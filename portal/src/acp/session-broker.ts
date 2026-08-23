import { type JsonRpcId, type JsonRpcMessage, jsonRpcMessageSchema, rpcErrorCode } from '@weave/protocol';
import type { AgentAttachInput, AgentAttachment, AgentRuntimePort } from './runtime.ts';

const idKey = (id: JsonRpcId | null) => `${typeof id}:${String(id)}`;

const sessionIdFrom = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId : undefined;
};

const promptFrom = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const prompt = (value as { prompt?: unknown }).prompt;
  return Array.isArray(prompt) ? prompt : [];
};

const userMessageContentFrom = (message: JsonRpcMessage) => {
  if (!('method' in message) || message.method !== 'session/update') return undefined;
  const params = message.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const update = (params as { update?: unknown }).update;
  if (!update || typeof update !== 'object' || Array.isArray(update)) return undefined;
  if ((update as { sessionUpdate?: unknown }).sessionUpdate !== 'user_message_chunk') return undefined;
  return (update as { content?: unknown }).content;
};

const jsonValuesEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(leftRecord[key], rightRecord[key]));
};

const sessionKey = (agentId: string, workspaceId: string, acpSessionId: string) =>
  `${agentId}\u0000${workspaceId}\u0000${acpSessionId}`;

type BrokerClient = {
  readonly id: string;
  readonly input: AgentAttachInput;
  readonly messages: ReadableStream<JsonRpcMessage>;
  readonly agentRequests: Map<string, JsonRpcId>;
  controller?: ReadableStreamDefaultController<JsonRpcMessage>;
  runtime?: HostedRuntime;
  closed: boolean;
};

type PendingClientRequest = {
  readonly client: BrokerClient;
  readonly downstreamId: JsonRpcId;
  readonly method: string;
  readonly sessionId?: string;
};

type InitializeWaiter = {
  readonly client: BrokerClient;
  readonly downstreamId: JsonRpcId;
};

class HostedRuntime {
  readonly clients = new Set<BrokerClient>();
  readonly journal: JsonRpcMessage[] = [];
  private readonly pending = new Map<string, PendingClientRequest>();
  private readonly initializeWaiters: InitializeWaiter[] = [];
  private readonly readerTask: Promise<void>;
  private nextRequestId = 0;
  private nextAgentRequestId = 0;
  private initialized = false;
  private initializePending = false;
  private initializeResult: unknown;
  private activePromptClient?: BrokerClient;
  private expectedUserEchoes: unknown[] = [];
  private stopped = false;
  sessionId?: string;

  constructor(
    private readonly broker: AcpSessionBroker,
    readonly upstream: AgentAttachment,
  ) {
    this.readerTask = this.readUpstream();
  }

  add(client: BrokerClient) {
    this.clients.add(client);
    client.runtime = this;
  }

  detach(client: BrokerClient) {
    this.clients.delete(client);
    if (client.runtime === this) client.runtime = undefined;
  }

  async receive(client: BrokerClient, rawMessage: JsonRpcMessage) {
    if (this.stopped) throw new Error('Hosted ACP session is unavailable.');
    const message = jsonRpcMessageSchema.parse(rawMessage);
    if (!('method' in message)) {
      const upstreamId = client.agentRequests.get(idKey(message.id));
      if (upstreamId === undefined) throw new Error('Unknown ACP Agent request response.');
      client.agentRequests.delete(idKey(message.id));
      await this.upstream.receive(jsonRpcMessageSchema.parse({ ...message, id: upstreamId }));
      return;
    }
    if (!('id' in message)) {
      await this.upstream.receive(message);
      return;
    }

    if (message.method === 'initialize') {
      if (this.initialized) {
        this.emit(client, { jsonrpc: '2.0', id: message.id, result: this.initializeResult });
        return;
      }
      if (this.initializePending) {
        this.initializeWaiters.push({ client, downstreamId: message.id });
        return;
      }
      this.initializePending = true;
    }

    if (message.method === 'session/load') {
      const requestedSessionId = sessionIdFrom(message.params);
      if (requestedSessionId) {
        const target = this.broker.findSession(this.upstream.agentId, this.upstream.workspaceId, requestedSessionId);
        if (target && target !== this) {
          await this.broker.moveClient(client, this, target);
          await target.receive(client, message);
          return;
        }
        if (this.sessionId === requestedSessionId) {
          for (const event of this.journal) this.emit(client, event);
          this.emit(client, { jsonrpc: '2.0', id: message.id, result: null });
          return;
        }
      }
    }

    if (message.method === 'session/prompt') {
      if (this.activePromptClient) {
        this.emit(client, {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: rpcErrorCode.conflict,
            message: 'The ACP session already has an active prompt.',
            data: { code: 'SESSION_BUSY' },
          },
        });
        return;
      }
      this.activePromptClient = client;
      this.expectedUserEchoes = [...promptFrom(message.params)];
    }

    const upstreamId = `weave-client-${++this.nextRequestId}`;
    this.pending.set(idKey(upstreamId), {
      client,
      downstreamId: message.id,
      method: message.method,
      sessionId: sessionIdFrom(message.params),
    });
    if (message.method === 'session/prompt') this.fanOutSubmittedPrompt(client, message.params);
    try {
      await this.upstream.receive(jsonRpcMessageSchema.parse({ ...message, id: upstreamId }));
    } catch (error) {
      this.pending.delete(idKey(upstreamId));
      if (message.method === 'initialize') this.initializePending = false;
      if (message.method === 'session/prompt' && this.activePromptClient === client) {
        this.activePromptClient = undefined;
        this.expectedUserEchoes = [];
      }
      throw error;
    }
  }

  async close(reason: string) {
    if (this.stopped) return;
    this.stopped = true;
    await this.upstream.close(reason).catch(() => undefined);
    await this.readerTask.catch(() => undefined);
    for (const client of [...this.clients]) {
      this.detach(client);
      this.closeClientStream(client);
    }
  }

  private async readUpstream() {
    const reader = this.upstream.messages.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await this.routeUpstream(jsonRpcMessageSchema.parse(value));
      }
      this.finishClients();
    } catch (error) {
      this.finishClients(error);
    } finally {
      reader.releaseLock();
      this.stopped = true;
      this.broker.runtimeStopped(this);
    }
  }

  private async routeUpstream(message: JsonRpcMessage) {
    if ('method' in message) {
      if (!('id' in message)) {
        if (this.consumeExpectedUserEcho(message)) return;
        if (message.method === 'session/update') this.journal.push(message);
        for (const client of this.clients) this.emit(client, message);
        return;
      }
      const client = this.activePromptClient && !this.activePromptClient.closed
        ? this.activePromptClient
        : [...this.clients].find((candidate) => !candidate.closed);
      if (!client) {
        await this.upstream.receive({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: rpcErrorCode.portalUnavailable, message: 'No ACP client can answer the Agent request.' },
        });
        return;
      }
      const downstreamId = `weave-agent-${++this.nextAgentRequestId}`;
      client.agentRequests.set(idKey(downstreamId), message.id);
      this.emit(client, { ...message, id: downstreamId });
      return;
    }

    if (message.id === null) return;
    const pending = this.pending.get(idKey(message.id));
    if (!pending) return;
    this.pending.delete(idKey(message.id));
    if (pending.method === 'initialize') {
      this.initializePending = false;
      if ('result' in message) {
        this.initialized = true;
        this.initializeResult = message.result;
      }
    }
    if ((pending.method === 'session/new' || pending.method === 'session/load') && 'result' in message) {
      const boundSessionId = pending.method === 'session/new' ? sessionIdFrom(message.result) : pending.sessionId;
      if (boundSessionId) {
        this.sessionId = boundSessionId;
        this.broker.bindSession(this, boundSessionId);
      }
    }
    if (pending.method === 'session/prompt' && this.activePromptClient === pending.client) {
      this.activePromptClient = undefined;
      this.expectedUserEchoes = [];
    }
    this.emit(pending.client, { ...message, id: pending.downstreamId });
    if (pending.method === 'initialize' && this.initialized) {
      for (const waiter of this.initializeWaiters.splice(0)) {
        this.emit(waiter.client, {
          jsonrpc: '2.0',
          id: waiter.downstreamId,
          result: this.initializeResult,
        });
      }
    }
  }

  private emit(client: BrokerClient, message: JsonRpcMessage) {
    if (client.closed) return;
    try {
      client.controller?.enqueue(jsonRpcMessageSchema.parse(message));
    } catch {
      // Detach races are resolved by the client's close path.
    }
  }

  private fanOutSubmittedPrompt(origin: BrokerClient, params: unknown) {
    const sessionId = sessionIdFrom(params) ?? this.sessionId;
    if (!sessionId) return;
    for (const content of promptFrom(params)) {
      const update = jsonRpcMessageSchema.parse({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'user_message_chunk', content },
        },
      });
      this.journal.push(update);
      for (const client of this.clients) {
        if (client !== origin) this.emit(client, update);
      }
    }
  }

  private consumeExpectedUserEcho(message: JsonRpcMessage) {
    const content = userMessageContentFrom(message);
    if (content === undefined || this.expectedUserEchoes.length === 0) return false;
    if (!jsonValuesEqual(content, this.expectedUserEchoes[0])) {
      this.expectedUserEchoes = [];
      return false;
    }
    this.expectedUserEchoes.shift();
    return true;
  }

  private finishClients(error?: unknown) {
    for (const client of [...this.clients]) {
      this.detach(client);
      this.closeClientStream(client, error);
    }
  }

  private closeClientStream(client: BrokerClient, error?: unknown) {
    if (client.closed) return;
    client.closed = true;
    try {
      if (error) client.controller?.error(error);
      else client.controller?.close();
    } catch {
      // The consumer may already have cancelled its stream.
    }
  }
}

export class AcpSessionBroker implements AgentRuntimePort {
  private readonly runtimes = new Set<HostedRuntime>();
  private readonly sessions = new Map<string, HostedRuntime>();
  private closed = false;

  constructor(private readonly upstream: AgentRuntimePort) {}

  listDefinitions() {
    return this.upstream.listDefinitions();
  }

  async attach(input: AgentAttachInput): Promise<AgentAttachment> {
    if (this.closed) throw new Error('ACP Session Broker is closed.');
    let runtime = input.acpSessionId && input.workspaceId
      ? this.findSession(input.agentId, input.workspaceId, input.acpSessionId)
      : undefined;
    if (!runtime) {
      runtime = new HostedRuntime(this, await this.upstream.attach(input));
      this.runtimes.add(runtime);
    }
    const client: BrokerClient = {
      id: crypto.randomUUID(),
      input,
      messages: undefined as unknown as ReadableStream<JsonRpcMessage>,
      agentRequests: new Map(),
      runtime,
      closed: false,
    };
    const messages = new ReadableStream<JsonRpcMessage>({
      start(controller) {
        client.controller = controller;
      },
    });
    Object.assign(client, { messages });
    runtime.add(client);

    return {
      agentId: runtime.upstream.agentId,
      workspaceId: runtime.upstream.workspaceId,
      messages,
      stderrTail: () => client.runtime?.upstream.stderrTail() ?? '',
      receive: async (message) => {
        if (client.closed || !client.runtime) throw new Error('ACP attachment is closed.');
        await client.runtime.receive(client, message);
      },
      close: async () => {
        if (client.closed) return;
        client.closed = true;
        const current = client.runtime;
        current?.detach(client);
        try {
          client.controller?.close();
        } catch {
          // The consumer may already have cancelled its stream.
        }
        if (current && !current.sessionId && current.clients.size === 0) {
          this.runtimes.delete(current);
          await current.close('Unbound ACP client detached.');
        }
      },
    };
  }

  findSession(agentId: string, workspaceId: string, acpSessionId: string) {
    return this.sessions.get(sessionKey(agentId, workspaceId, acpSessionId));
  }

  bindSession(runtime: HostedRuntime, acpSessionId: string) {
    const key = sessionKey(runtime.upstream.agentId, runtime.upstream.workspaceId, acpSessionId);
    const existing = this.sessions.get(key);
    if (existing && existing !== runtime) {
      throw new Error(`ACP session is already hosted: ${acpSessionId}`);
    }
    this.sessions.set(key, runtime);
  }

  async moveClient(client: BrokerClient, from: HostedRuntime, to: HostedRuntime) {
    from.detach(client);
    to.add(client);
    if (!from.sessionId && from.clients.size === 0) {
      this.runtimes.delete(from);
      await from.close('Replaced provisional ACP runtime.');
    }
  }

  runtimeStopped(runtime: HostedRuntime) {
    this.runtimes.delete(runtime);
    if (runtime.sessionId) {
      const key = sessionKey(runtime.upstream.agentId, runtime.upstream.workspaceId, runtime.sessionId);
      if (this.sessions.get(key) === runtime) this.sessions.delete(key);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.runtimes].map((runtime) => runtime.close('ACP Session Broker stopped.')));
    this.runtimes.clear();
    this.sessions.clear();
  }
}
