import {
  type JsonRpcId,
  type JsonRpcMessage,
  jsonRpcMessageSchema,
  rpcErrorCode,
  WEAVE_ACP_META_NAMESPACE,
  WEAVE_ACP_THREAD_ACK_METHOD,
  WEAVE_ACP_THREAD_EVENT_META_KEY,
  WEAVE_ACP_THREAD_EVENTS_META_KEY,
  WEAVE_ACP_THREAD_SYNC_NOTIFICATION,
  weaveAcpThreadAckParamsSchema,
  weaveAcpThreadEventMetaSchema,
  weaveAcpThreadEventsCapabilitySchema,
  weaveAcpThreadEventsLoadMetaSchema,
  weaveAcpThreadSyncParamsSchema,
} from '@weave/protocol';
import type { AgentAttachInput, AgentAttachment, AgentRuntimePort } from './runtime.ts';
import {
  InMemoryThreadEventJournal,
  type ThreadEventJournal,
  type ThreadEventRecord,
  type ThreadEventStream,
} from './thread-event-journal.ts';

const idKey = (id: JsonRpcId | null) => `${typeof id}:${String(id)}`;

const sessionIdFrom = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId : undefined;
};

const promptFrom = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const prompt = (value as { prompt?: unknown }).prompt;
  return Array.isArray(prompt) ? prompt : [];
};

const objectFrom = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

type ThreadEventCursorRequest = {
  enabled: boolean;
  afterSequence?: number | null;
};

const threadEventCursorFrom = (params: unknown): ThreadEventCursorRequest => {
  const meta = objectFrom(objectFrom(params)?._meta);
  if (!meta || !(WEAVE_ACP_THREAD_EVENTS_META_KEY in meta)) {
    return { enabled: false };
  }
  const parsed = weaveAcpThreadEventsLoadMetaSchema.parse(
    meta[WEAVE_ACP_THREAD_EVENTS_META_KEY],
  );
  return { enabled: true, afterSequence: parsed.afterSequence };
};

const withThreadEventsCapability = (value: unknown) => {
  const result = objectFrom(value);
  const agentCapabilities = objectFrom(result?.agentCapabilities);
  if (!result || !agentCapabilities) return value;
  const meta = objectFrom(agentCapabilities._meta) ?? {};
  const namespace = objectFrom(meta[WEAVE_ACP_META_NAMESPACE]) ?? {};
  return {
    ...result,
    agentCapabilities: {
      ...agentCapabilities,
      _meta: {
        ...meta,
        [WEAVE_ACP_META_NAMESPACE]: {
          ...namespace,
          threadEvents: weaveAcpThreadEventsCapabilitySchema.parse({
            version: 1,
            ackMethod: WEAVE_ACP_THREAD_ACK_METHOD,
            syncNotification: WEAVE_ACP_THREAD_SYNC_NOTIFICATION,
          }),
        },
      },
    },
  };
};

const userMessageContentFrom = (message: JsonRpcMessage) => {
  if (!('method' in message) || message.method !== 'session/update') {
    return undefined;
  }
  const params = message.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return undefined;
  }
  const update = (params as { update?: unknown }).update;
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    return undefined;
  }
  if (
    (update as { sessionUpdate?: unknown }).sessionUpdate !==
      'user_message_chunk'
  ) return undefined;
  return (update as { content?: unknown }).content;
};

const jsonValuesEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (
    !left || !right || typeof left !== 'object' || typeof right !== 'object'
  ) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] &&
      jsonValuesEqual(leftRecord[key], rightRecord[key])
    );
};

const sessionKey = (
  agentId: string,
  workspaceId: string,
  acpSessionId: string,
) => `${agentId}\u0000${workspaceId}\u0000${acpSessionId}`;

type BrokerClient = {
  readonly id: string;
  readonly input: AgentAttachInput;
  readonly messages: ReadableStream<JsonRpcMessage>;
  readonly agentRequests: Map<string, JsonRpcId>;
  controller?: ReadableStreamDefaultController<JsonRpcMessage>;
  runtime?: HostedRuntime;
  observingSessionId?: string;
  threadEventsEnabled: boolean;
  acknowledgedSequence: number;
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

type SessionLoadWaiter = {
  readonly client: BrokerClient;
  readonly downstreamId: JsonRpcId;
  readonly cursor: ThreadEventCursorRequest;
};

type ColdSessionLoad = {
  readonly sessionId: string;
  readonly waiters: SessionLoadWaiter[];
  readonly providerReplay: JsonRpcMessage[];
  upstreamRequestId?: JsonRpcId;
};

class HostedRuntime {
  readonly clients = new Set<BrokerClient>();
  private readonly pending = new Map<string, PendingClientRequest>();
  private readonly initializeWaiters: InitializeWaiter[] = [];
  private readonly readerTask: Promise<void>;
  private nextRequestId = 0;
  private nextAgentRequestId = 0;
  private initialized = false;
  private initializePending = false;
  private initializeResult: unknown;
  private eventQueue = Promise.resolve();
  private activePromptClient?: BrokerClient;
  private expectedUserEchoes: unknown[] = [];
  private coldSessionLoad?: ColdSessionLoad;
  private stopped = false;
  sessionId?: string;

  constructor(
    private readonly broker: AcpSessionBroker,
    readonly upstream: AgentAttachment,
    private readonly eventJournal: ThreadEventJournal,
    readonly reservedSessionId?: string,
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
      if (upstreamId === undefined) {
        throw new Error('Unknown ACP Agent request response.');
      }
      client.agentRequests.delete(idKey(message.id));
      await this.upstream.receive(
        jsonRpcMessageSchema.parse({ ...message, id: upstreamId }),
      );
      return;
    }
    if (!('id' in message)) {
      await this.upstream.receive(message);
      return;
    }

    if (message.method === 'initialize') {
      if (this.initialized) {
        this.emit(client, {
          jsonrpc: '2.0',
          id: message.id,
          result: this.initializeResult,
        });
        return;
      }
      if (this.initializePending) {
        this.initializeWaiters.push({ client, downstreamId: message.id });
        return;
      }
      this.initializePending = true;
    }

    if (message.method === WEAVE_ACP_THREAD_ACK_METHOD) {
      const parsed = weaveAcpThreadAckParamsSchema.safeParse(message.params);
      if (!parsed.success) {
        this.emit(client, {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: rpcErrorCode.invalidParams,
            message: 'Invalid Thread event acknowledgement.',
          },
        });
        return;
      }
      if (
        !client.threadEventsEnabled ||
        client.observingSessionId !== parsed.data.sessionId
      ) {
        this.emit(client, {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: rpcErrorCode.conflict,
            message: 'The client is not observing that Thread event stream.',
          },
        });
        return;
      }
      let window;
      try {
        window = await this.withEventLock(() =>
          this.eventJournal.read(this.eventStream(parsed.data.sessionId), {
            afterSequence: parsed.data.sequence,
          })
        );
      } catch {
        this.emit(client, {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: rpcErrorCode.invalidParams,
            message: 'Thread event acknowledgement is out of range.',
          },
        });
        return;
      }
      if (
        parsed.data.sequence < client.acknowledgedSequence ||
        window.cursorExpired
      ) {
        this.emit(client, {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: rpcErrorCode.resumeGap,
            message: 'Thread event acknowledgement has expired.',
          },
        });
        return;
      }
      client.acknowledgedSequence = parsed.data.sequence;
      this.emit(client, {
        jsonrpc: '2.0',
        id: message.id,
        result: { acknowledgedSequence: client.acknowledgedSequence },
      });
      return;
    }

    if (message.method === 'session/load') {
      const requestedSessionId = sessionIdFrom(message.params);
      if (requestedSessionId) {
        let cursor: ThreadEventCursorRequest;
        try {
          cursor = threadEventCursorFrom(message.params);
        } catch {
          this.emit(client, {
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: rpcErrorCode.invalidParams,
              message: 'Invalid Weave Thread event cursor.',
            },
          });
          return;
        }
        const target = this.broker.findSession(
          this.upstream.agentId,
          this.upstream.workspaceId,
          requestedSessionId,
        );
        if (target && target !== this) {
          await this.broker.moveClient(client, this, target);
          await target.receive(client, message);
          return;
        }
        let window;
        try {
          window = await this.eventJournal.read(
            this.eventStream(requestedSessionId),
            {
              afterSequence: typeof cursor.afterSequence === 'number' ? cursor.afterSequence : 0,
            },
          );
        } catch {
          this.emit(client, {
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: rpcErrorCode.invalidParams,
              message: 'Thread event cursor is out of range.',
            },
          });
          return;
        }
        if (typeof cursor.afterSequence === 'number' && window.cursorExpired) {
          this.emitResumeGap(
            client,
            message.id,
            window.compactedThrough,
            window.lastSequence,
          );
          return;
        }
        const needsProviderReplay = window.lastSequence === 0 ||
          (cursor.afterSequence === null && window.compactedThrough > 0) ||
          (!cursor.enabled && window.compactedThrough > 0);
        if (this.sessionId === requestedSessionId && !needsProviderReplay) {
          await this.replayAndObserve(client, requestedSessionId, cursor);
          this.emit(client, { jsonrpc: '2.0', id: message.id, result: null });
          return;
        }
        if (this.coldSessionLoad) {
          if (this.coldSessionLoad.sessionId !== requestedSessionId) {
            this.emit(client, {
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: rpcErrorCode.conflict,
                message: 'The hosted ACP runtime is already loading another session.',
                data: { code: 'SESSION_BUSY' },
              },
            });
            return;
          }
          this.coldSessionLoad.waiters.push({
            client,
            downstreamId: message.id,
            cursor,
          });
          return;
        }

        const coldSessionLoad: ColdSessionLoad = {
          sessionId: requestedSessionId,
          waiters: [{ client, downstreamId: message.id, cursor }],
          providerReplay: [],
        };
        this.coldSessionLoad = coldSessionLoad;
        try {
          const upstreamId = `weave-client-${++this.nextRequestId}`;
          coldSessionLoad.upstreamRequestId = upstreamId;
          this.pending.set(idKey(upstreamId), {
            client,
            downstreamId: message.id,
            method: message.method,
            sessionId: requestedSessionId,
          });
          await this.upstream.receive(
            jsonRpcMessageSchema.parse({ ...message, id: upstreamId }),
          );
        } catch (error) {
          if (coldSessionLoad.upstreamRequestId !== undefined) {
            this.pending.delete(idKey(coldSessionLoad.upstreamRequestId));
          }
          if (this.coldSessionLoad === coldSessionLoad) {
            this.coldSessionLoad = undefined;
          }
          throw error;
        }
        return;
      }
    }

    if (message.method === 'session/prompt') {
      if (this.coldSessionLoad) {
        this.emit(client, {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: rpcErrorCode.conflict,
            message: 'The ACP session is being restored.',
            data: { code: 'SESSION_BUSY' },
          },
        });
        return;
      }
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
    try {
      if (message.method === 'session/prompt') {
        await this.fanOutSubmittedPrompt(client, message.params);
      }
      await this.upstream.receive(
        jsonRpcMessageSchema.parse({ ...message, id: upstreamId }),
      );
    } catch (error) {
      this.pending.delete(idKey(upstreamId));
      if (message.method === 'initialize') this.initializePending = false;
      if (
        message.method === 'session/prompt' &&
        this.activePromptClient === client
      ) {
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
        if (message.method === 'session/update') {
          const sessionId = sessionIdFrom(message.params) ?? this.sessionId ??
            this.coldSessionLoad?.sessionId;
          if (sessionId) {
            const coldSessionLoad = this.coldSessionLoad;
            if (coldSessionLoad?.sessionId === sessionId) {
              coldSessionLoad.providerReplay.push(message);
              return;
            }
            await this.withEventLock(async () => {
              const event = await this.eventJournal.append(
                this.eventStream(sessionId),
                message,
              );
              for (const client of this.clients) {
                if (client.observingSessionId === sessionId) {
                  this.emitThreadEvent(client, event);
                }
              }
            });
            return;
          }
        }
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
          error: {
            code: rpcErrorCode.portalUnavailable,
            message: 'No ACP client can answer the Agent request.',
          },
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
    let outboundMessage: JsonRpcMessage = message;
    if (pending.method === 'initialize') {
      this.initializePending = false;
      if ('result' in message) {
        this.initialized = true;
        this.initializeResult = withThreadEventsCapability(message.result);
        outboundMessage = jsonRpcMessageSchema.parse({
          ...message,
          result: this.initializeResult,
        });
      }
    }
    if (
      (pending.method === 'session/new' || pending.method === 'session/load') &&
      'result' in message
    ) {
      const boundSessionId = pending.method === 'session/new' ? sessionIdFrom(message.result) : pending.sessionId;
      if (boundSessionId) {
        this.sessionId = boundSessionId;
        this.broker.bindSession(this, boundSessionId);
      }
    }
    if (
      pending.method === 'session/prompt' &&
      this.activePromptClient === pending.client
    ) {
      this.activePromptClient = undefined;
      this.expectedUserEchoes = [];
    }
    if (
      pending.method === 'session/load' &&
      this.coldSessionLoad?.upstreamRequestId === message.id
    ) {
      const coldSessionLoad = this.coldSessionLoad;
      this.coldSessionLoad = undefined;
      if ('result' in message) {
        await this.withEventLock(async () => {
          let window = await this.eventJournal.read(
            this.eventStream(coldSessionLoad.sessionId),
          );
          if (window.lastSequence === 0 && window.compactedThrough === 0) {
            for (const replayed of coldSessionLoad.providerReplay) {
              await this.eventJournal.append(
                this.eventStream(coldSessionLoad.sessionId),
                replayed,
              );
            }
            window = await this.eventJournal.read(
              this.eventStream(coldSessionLoad.sessionId),
            );
          }
          for (const waiter of coldSessionLoad.waiters) {
            const forceProviderReload = window.compactedThrough > 0 &&
              (waiter.cursor.afterSequence === null || !waiter.cursor.enabled);
            if (forceProviderReload) {
              for (const replayed of coldSessionLoad.providerReplay) {
                this.emit(waiter.client, replayed);
              }
              this.observe(
                waiter.client,
                coldSessionLoad.sessionId,
                waiter.cursor.enabled,
              );
              if (waiter.cursor.enabled) {
                this.emitThreadSync(
                  waiter.client,
                  coldSessionLoad.sessionId,
                  window.lastSequence,
                  true,
                );
              }
            } else {
              await this.replayAndObserveUnlocked(
                waiter.client,
                coldSessionLoad.sessionId,
                waiter.cursor,
              );
            }
            this.emit(waiter.client, {
              ...outboundMessage,
              id: waiter.downstreamId,
            });
          }
        });
      } else {
        for (const waiter of coldSessionLoad.waiters) {
          this.emit(waiter.client, {
            ...outboundMessage,
            id: waiter.downstreamId,
          });
        }
      }
    } else {
      if (
        pending.method === 'session/new' && 'result' in message &&
        this.sessionId
      ) {
        pending.client.observingSessionId = this.sessionId;
      }
      this.emit(pending.client, {
        ...outboundMessage,
        id: pending.downstreamId,
      });
    }
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

  private async fanOutSubmittedPrompt(origin: BrokerClient, params: unknown) {
    const sessionId = sessionIdFrom(params) ?? this.sessionId;
    if (!sessionId) return;
    await this.withEventLock(async () => {
      for (const content of promptFrom(params)) {
        const update = jsonRpcMessageSchema.parse({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: { sessionUpdate: 'user_message_chunk', content },
          },
        });
        const event = await this.eventJournal.append(
          this.eventStream(sessionId),
          update,
        );
        for (const client of this.clients) {
          if (client.observingSessionId !== sessionId) continue;
          if (client !== origin || client.threadEventsEnabled) {
            this.emitThreadEvent(client, event);
          }
        }
      }
    });
  }

  private async replayAndObserve(
    client: BrokerClient,
    sessionId: string,
    cursor: ThreadEventCursorRequest,
  ) {
    await this.withEventLock(() => this.replayAndObserveUnlocked(client, sessionId, cursor));
  }

  private async replayAndObserveUnlocked(
    client: BrokerClient,
    sessionId: string,
    cursor: ThreadEventCursorRequest,
  ) {
    const window = await this.eventJournal.read(this.eventStream(sessionId), {
      afterSequence: typeof cursor.afterSequence === 'number' ? cursor.afterSequence : 0,
    });
    if (typeof cursor.afterSequence === 'number' && window.cursorExpired) {
      throw new Error('Thread event cursor expired during replay.');
    }
    for (const event of window.events) {
      this.emitThreadEvent(client, event, cursor.enabled);
    }
    this.observe(client, sessionId, cursor.enabled);
    if (cursor.enabled) {
      this.emitThreadSync(client, sessionId, window.lastSequence, false);
    }
  }

  private async withEventLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.eventQueue.then(operation);
    this.eventQueue = result.then(() => undefined, () => undefined);
    return await result;
  }

  private observe(
    client: BrokerClient,
    sessionId: string,
    threadEventsEnabled: boolean,
  ) {
    client.observingSessionId = sessionId;
    client.threadEventsEnabled = threadEventsEnabled;
  }

  private emitThreadEvent(
    client: BrokerClient,
    event: ThreadEventRecord,
    forceMetadata = client.threadEventsEnabled,
  ) {
    if (!forceMetadata) {
      this.emit(client, event.message);
      return;
    }
    const params = objectFrom(
      'params' in event.message ? event.message.params : undefined,
    );
    const update = objectFrom(params?.update);
    if (!params || !update) {
      this.emit(client, event.message);
      return;
    }
    const meta = objectFrom(update._meta) ?? {};
    this.emit(client, {
      ...event.message,
      params: {
        ...params,
        update: {
          ...update,
          _meta: {
            ...meta,
            [WEAVE_ACP_THREAD_EVENT_META_KEY]: weaveAcpThreadEventMetaSchema
              .parse({
                sequence: event.sequence,
                eventId: event.eventId,
                createdAt: event.createdAt,
              }),
          },
        },
      },
    });
  }

  private emitThreadSync(
    client: BrokerClient,
    sessionId: string,
    lastSequence: number,
    fullReload: boolean,
  ) {
    this.emit(client, {
      jsonrpc: '2.0',
      method: WEAVE_ACP_THREAD_SYNC_NOTIFICATION,
      params: weaveAcpThreadSyncParamsSchema.parse({
        sessionId,
        lastSequence,
        fullReload,
      }),
    });
  }

  private emitResumeGap(
    client: BrokerClient,
    id: JsonRpcId,
    compactedThrough: number,
    lastSequence: number,
  ) {
    this.emit(client, {
      jsonrpc: '2.0',
      id,
      error: {
        code: rpcErrorCode.resumeGap,
        message: 'The requested Thread event cursor has expired.',
        data: {
          code: 'RESUME_GAP',
          compactedThrough,
          lastSequence,
          reloadAfterSequence: null,
        },
      },
    });
  }

  private eventStream(acpSessionId: string): ThreadEventStream {
    return {
      agentId: this.upstream.agentId,
      workspaceId: this.upstream.workspaceId,
      acpSessionId,
    };
  }

  private consumeExpectedUserEcho(message: JsonRpcMessage) {
    const content = userMessageContentFrom(message);
    if (content === undefined || this.expectedUserEchoes.length === 0) {
      return false;
    }
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
  private readonly spawningSessions = new Map<string, Promise<HostedRuntime>>();
  private closed = false;

  private readonly eventJournal: ThreadEventJournal;

  constructor(
    private readonly upstream: AgentRuntimePort,
    options: { eventJournal?: ThreadEventJournal } = {},
  ) {
    this.eventJournal = options.eventJournal ??
      new InMemoryThreadEventJournal();
  }

  listDefinitions() {
    return this.upstream.listDefinitions();
  }

  async attach(input: AgentAttachInput): Promise<AgentAttachment> {
    if (this.closed) throw new Error('ACP Session Broker is closed.');
    let runtime = input.acpSessionId && input.workspaceId
      ? this.findSession(input.agentId, input.workspaceId, input.acpSessionId)
      : undefined;
    if (!runtime) {
      runtime = input.acpSessionId && input.workspaceId
        ? await this.spawnReservedRuntime(input, input.acpSessionId)
        : await this.spawnRuntime(input);
    }
    const client: BrokerClient = {
      id: crypto.randomUUID(),
      input,
      messages: undefined as unknown as ReadableStream<JsonRpcMessage>,
      agentRequests: new Map(),
      runtime,
      threadEventsEnabled: false,
      acknowledgedSequence: 0,
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
        if (client.closed || !client.runtime) {
          throw new Error('ACP attachment is closed.');
        }
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
    const key = sessionKey(
      runtime.upstream.agentId,
      runtime.upstream.workspaceId,
      acpSessionId,
    );
    const existing = this.sessions.get(key);
    if (existing && existing !== runtime) {
      throw new Error(`ACP session is already hosted: ${acpSessionId}`);
    }
    this.sessions.set(key, runtime);
  }

  private async spawnReservedRuntime(
    input: AgentAttachInput,
    acpSessionId: string,
  ) {
    const key = sessionKey(input.agentId, input.workspaceId!, acpSessionId);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    let spawning = this.spawningSessions.get(key);
    if (!spawning) {
      spawning = this.spawnRuntime(input, acpSessionId);
      this.spawningSessions.set(key, spawning);
    }
    try {
      return await spawning;
    } finally {
      if (this.spawningSessions.get(key) === spawning) {
        this.spawningSessions.delete(key);
      }
    }
  }

  private async spawnRuntime(
    input: AgentAttachInput,
    reservedSessionId?: string,
  ) {
    const runtime = new HostedRuntime(
      this,
      await this.upstream.attach(input),
      this.eventJournal,
      reservedSessionId,
    );
    this.runtimes.add(runtime);
    if (reservedSessionId) this.bindSession(runtime, reservedSessionId);
    return runtime;
  }

  async moveClient(
    client: BrokerClient,
    from: HostedRuntime,
    to: HostedRuntime,
  ) {
    from.detach(client);
    to.add(client);
    if (!from.sessionId && from.clients.size === 0) {
      this.runtimes.delete(from);
      await from.close('Replaced provisional ACP runtime.');
    }
  }

  runtimeStopped(runtime: HostedRuntime) {
    this.runtimes.delete(runtime);
    for (
      const acpSessionId of new Set([
        runtime.sessionId,
        runtime.reservedSessionId,
      ])
    ) {
      if (!acpSessionId) continue;
      const key = sessionKey(
        runtime.upstream.agentId,
        runtime.upstream.workspaceId,
        acpSessionId,
      );
      if (this.sessions.get(key) === runtime) this.sessions.delete(key);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(
      [...this.runtimes].map((runtime) => runtime.close('ACP Session Broker stopped.')),
    );
    this.runtimes.clear();
    this.sessions.clear();
    this.spawningSessions.clear();
  }
}
