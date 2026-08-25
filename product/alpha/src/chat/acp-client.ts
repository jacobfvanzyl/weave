import {
  client,
  methods,
  PROTOCOL_VERSION,
  type AnyMessage,
  type ClientConnection,
  type ClientContext,
  type ContentBlock,
  type CreateElicitationResponse,
  type InitializeResponse,
  type RequestPermissionOutcome,
  type Stream,
} from '@agentclientprotocol/sdk';
import {
  createWebSocketStream,
  type WebSocketConstructor,
} from '@agentclientprotocol/sdk/experimental/ws-client';
import type { AcpTranscriptEvent } from './acp-transcript';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isJsonRpcId = (value: unknown) =>
  value === null
  || typeof value === 'string'
  || (typeof value === 'number' && Number.isInteger(value));

export const parseAcpClientMessage = (raw: string): AnyMessage => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('ACP transport message must contain valid JSON.');
  }
  if (!isRecord(value)) {
    throw new Error('ACP transport message must be a JSON-RPC object.');
  }
  if (value.jsonrpc !== '2.0') {
    throw new Error('ACP transport message must use JSON-RPC 2.0.');
  }
  if (typeof value.method === 'string') {
    if ('id' in value && !isJsonRpcId(value.id)) {
      throw new Error('ACP JSON-RPC request id is invalid.');
    }
    return value as AnyMessage;
  }
  if (!('id' in value) || !isJsonRpcId(value.id)) {
    throw new Error('ACP JSON-RPC response must contain a valid id.');
  }
  if (!('result' in value) && !('error' in value)) {
    throw new Error('ACP JSON-RPC response must contain result or error.');
  }
  return value as AnyMessage;
};

const knownSessionUpdates = new Set([
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'plan_update',
  'plan_removed',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
  'compaction_update',
  'compaction_summary_chunk',
]);

const unknownSessionUpdate = (message: AnyMessage) => {
  const envelope: unknown = message;
  if (!isRecord(envelope) || envelope.method !== 'session/update') return;
  if (!isRecord(envelope.params) || !isRecord(envelope.params.update)) return;
  const discriminator = envelope.params.update.sessionUpdate;
  if (typeof discriminator !== 'string' || knownSessionUpdates.has(discriminator)) return;
  return envelope.params;
};

const createParsedWebSocketStream = (
  options: Pick<AcpSessionClientOptions, 'url' | 'protocols' | 'WebSocket'>,
  onUnknown: (method: string, payload: Record<string, unknown>) => void,
): Stream => {
  const upstream = createWebSocketStream(options.url, {
    ...(options.protocols ? { protocols: options.protocols } : {}),
    ...(options.WebSocket ? { WebSocket: options.WebSocket } : {}),
  });
  const readable = upstream.readable.pipeThrough(new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      const parsed = parseAcpClientMessage(JSON.stringify(message));
      const unknown = unknownSessionUpdate(parsed);
      if (unknown) {
        onUnknown('session/update', unknown);
        return;
      }
      controller.enqueue(parsed);
    },
  }));
  return { readable, writable: upstream.writable };
};

type PendingPermission = (outcome: RequestPermissionOutcome) => void;
type PendingElicitation = (response: CreateElicitationResponse) => void;

export type AcpSessionClientOptions = {
  url: string;
  protocols?: string[];
  WebSocket?: WebSocketConstructor;
  onEvent(event: AcpTranscriptEvent): void;
};

export class AcpSessionClient {
  private readonly connection: ClientConnection;
  private readonly agent: ClientContext;
  private readonly onEvent: AcpSessionClientOptions['onEvent'];
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly pendingElicitations = new Map<string, PendingElicitation>();
  private sessionId?: string;

  constructor(options: AcpSessionClientOptions) {
    this.onEvent = options.onEvent;
    const stream = createParsedWebSocketStream(options, (method, payload) => {
      this.onEvent({ type: 'protocol/unknown', method, payload });
    });
    const app = client({ name: 'Weave' })
      .onNotification(methods.client.session.update, ({ params }) => {
        this.onEvent({ type: 'session/update', update: params.update });
      })
      .onRequest(methods.client.session.requestPermission, ({
        params,
        requestId,
        signal,
      }) => new Promise<RequestPermissionOutcome>((resolve) => {
        const id = String(requestId);
        this.pendingPermissions.set(id, resolve);
        this.onEvent({ type: 'permission/requested', requestId: id, request: params });
        signal.addEventListener('abort', () => {
          if (!this.pendingPermissions.delete(id)) return;
          this.onEvent({ type: 'permission/cancelled', requestId: id });
          resolve({ outcome: 'cancelled' });
        }, { once: true });
      }).then((outcome) => ({ outcome })))
      .onRequest(methods.client.elicitation.create, ({
        params,
        requestId,
        signal,
      }) => new Promise<CreateElicitationResponse>((resolve) => {
        const id = String(requestId);
        this.pendingElicitations.set(id, resolve);
        this.onEvent({ type: 'elicitation/requested', requestId: id, request: params });
        signal.addEventListener('abort', () => {
          if (!this.pendingElicitations.delete(id)) return;
          const response = { action: 'cancel' } as const;
          this.onEvent({ type: 'elicitation/resolved', requestId: id, response });
          resolve(response);
        }, { once: true });
      }))
      .onNotification(methods.client.elicitation.complete, ({ params }) => {
        this.onEvent({ type: 'elicitation/completed', notification: params });
      });
    this.connection = app.connect(stream);
    this.agent = this.connection.agent;
  }

  async initializeAndLoad(input: {
    sessionId: string;
    cwd: string;
  }): Promise<InitializeResponse> {
    this.sessionId = input.sessionId;
    const initialized = await this.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        elicitation: { form: {}, url: {} },
        plan: {},
        session: {
          compaction: {},
          configOptions: { boolean: {} },
        },
      },
      clientInfo: { name: 'Weave', title: 'Weave', version: '0.1.0' },
    });
    const loaded = await this.agent.request(methods.agent.session.load, {
      sessionId: input.sessionId,
      cwd: input.cwd,
      mcpServers: [],
    });
    this.onEvent({
      type: 'session/loaded',
      modes: loaded.modes,
      configOptions: loaded.configOptions,
    });
    return initialized;
  }

  async prompt(content: ContentBlock[]) {
    if (!this.sessionId) throw new Error('Attach to an ACP session first.');
    this.onEvent({ type: 'turn/started' });
    try {
      const response = await this.agent.request(methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: content,
      });
      this.onEvent({ type: 'turn/stopped', stopReason: response.stopReason });
      return response;
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      this.onEvent({ type: 'turn/failed', error });
      throw cause;
    }
  }

  async cancel() {
    if (!this.sessionId) return;
    await this.agent.notify(methods.agent.session.cancel, {
      sessionId: this.sessionId,
    });
    for (const [requestId] of this.pendingPermissions) {
      this.respondToPermission(requestId, { outcome: 'cancelled' });
    }
    for (const [requestId] of this.pendingElicitations) {
      this.respondToElicitation(requestId, { action: 'cancel' });
    }
  }

  async setMode(modeId: string) {
    if (!this.sessionId) throw new Error('Attach to an ACP session first.');
    await this.agent.request(methods.agent.session.setMode, {
      sessionId: this.sessionId,
      modeId,
    });
  }

  async setConfigOption(optionId: string, value: string | boolean) {
    if (!this.sessionId) throw new Error('Attach to an ACP session first.');
    const response = typeof value === 'boolean'
      ? await this.agent.request(methods.agent.session.setConfigOption, {
          sessionId: this.sessionId,
          configId: optionId,
          type: 'boolean',
          value,
        })
      : await this.agent.request(methods.agent.session.setConfigOption, {
          sessionId: this.sessionId,
          configId: optionId,
          value,
        });
    this.onEvent({
      type: 'session/update',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: response.configOptions,
      },
    });
  }

  respondToPermission(requestId: string, outcome: RequestPermissionOutcome) {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return false;
    this.pendingPermissions.delete(requestId);
    resolve(outcome);
    if (outcome.outcome === 'selected') {
      this.onEvent({
        type: 'permission/resolved',
        requestId,
        optionId: outcome.optionId,
      });
    } else {
      this.onEvent({ type: 'permission/cancelled', requestId });
    }
    return true;
  }

  respondToElicitation(requestId: string, response: CreateElicitationResponse) {
    const resolve = this.pendingElicitations.get(requestId);
    if (!resolve) return false;
    this.pendingElicitations.delete(requestId);
    resolve(response);
    this.onEvent({ type: 'elicitation/resolved', requestId, response });
    return true;
  }

  close() {
    for (const [requestId] of this.pendingPermissions) {
      this.respondToPermission(requestId, { outcome: 'cancelled' });
    }
    for (const [requestId] of this.pendingElicitations) {
      this.respondToElicitation(requestId, { action: 'cancel' });
    }
    this.connection.close();
  }
}
