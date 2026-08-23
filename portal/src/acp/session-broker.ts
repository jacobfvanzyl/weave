import {
  type JsonRpcId,
  type JsonRpcMessage,
  jsonRpcMessageSchema,
  rpcErrorCode,
  WEAVE_ACP_META_NAMESPACE,
  WEAVE_ACP_RUNTIME_STATE_NOTIFICATION,
  WEAVE_ACP_THREAD_ACK_METHOD,
  WEAVE_ACP_THREAD_EVENT_META_KEY,
  WEAVE_ACP_THREAD_EVENTS_META_KEY,
  WEAVE_ACP_THREAD_SYNC_NOTIFICATION,
  weaveAcpRuntimeRecoveryCapabilitySchema,
  weaveAcpRuntimeStateParamsSchema,
  weaveAcpThreadAckParamsSchema,
  weaveAcpThreadEventMetaSchema,
  weaveAcpThreadEventsCapabilitySchema,
  weaveAcpThreadEventsLoadMetaSchema,
  weaveAcpThreadSyncParamsSchema,
} from '@weave/protocol';
import type { AgentAttachInput, AgentAttachment, AgentAttachmentExit, AgentRuntimePort } from './runtime.ts';
import {
  InMemoryThreadEventJournal,
  type ThreadEventJournal,
  type ThreadEventRecord,
  type ThreadEventStream,
} from './thread-event-journal.ts';
import {
  InMemoryRuntimeStateStore,
  type RuntimeStateRecord,
  type RuntimeStateStore,
  type RuntimeStream,
} from './runtime-state.ts';

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
          runtimeRecovery: weaveAcpRuntimeRecoveryCapabilitySchema.parse({
            version: 1,
            stateNotification: WEAVE_ACP_RUNTIME_STATE_NOTIFICATION,
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
  readonly finished: Promise<AgentAttachmentExit>;
  readonly finish: (exit: AgentAttachmentExit) => void;
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
  readonly params?: unknown;
};

type PendingInternalRequest = {
  readonly method: string;
  readonly resolve: (message: JsonRpcMessage) => void;
  readonly reject: (error: Error) => void;
};

type ProviderGeneration = {
  readonly attachment: AgentAttachment;
  generation: number;
  intentionalClose: boolean;
  stopped: boolean;
  readerTask?: Promise<void>;
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
  private readonly internalPending = new Map<string, PendingInternalRequest>();
  private readonly initializeWaiters: InitializeWaiter[] = [];
  private nextRequestId = 0;
  private nextAgentRequestId = 0;
  private initialized = false;
  private initializePending = false;
  private initializeResult: unknown;
  private initializeParams: unknown;
  private sessionSetupParams: unknown;
  private eventQueue = Promise.resolve();
  private activePromptClient?: BrokerClient;
  private expectedUserEchoes: unknown[] = [];
  private coldSessionLoad?: ColdSessionLoad;
  private stopped = false;
  private recoveryState: 'ready' | 'restoring' | 'unavailable' = 'ready';
  private recoveryTask?: Promise<void>;
  private restoringInternally = false;
  private provider: ProviderGeneration;
  sessionId?: string;

  constructor(
    private readonly broker: AcpSessionBroker,
    upstream: AgentAttachment,
    private readonly eventJournal: ThreadEventJournal,
    private readonly input: AgentAttachInput,
    readonly reservedSessionId?: string,
  ) {
    this.provider = this.installProvider(upstream, 0);
  }

  get agentId() {
    return this.provider.attachment.agentId;
  }

  get workspaceId() {
    return this.provider.attachment.workspaceId;
  }

  get stderrTail() {
    return this.provider.attachment.stderrTail;
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
      await this.provider.attachment.receive(
        jsonRpcMessageSchema.parse({ ...message, id: upstreamId }),
      );
      await this.transitionRuntime(
        this.activePromptClient ? 'prompting' : 'idle',
      );
      return;
    }
    if (!('id' in message)) {
      if (this.recoveryState !== 'ready') return;
      await this.provider.attachment.receive(message);
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
      this.initializeParams = message.params;
    } else if (this.recoveryState !== 'ready') {
      this.emitRuntimeUnavailable(client, message.id);
      return;
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
          this.agentId,
          this.workspaceId,
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
            params: message.params,
          });
          await this.provider.attachment.receive(
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
      params: message.params,
    });
    try {
      if (message.method === 'session/prompt') {
        await this.fanOutSubmittedPrompt(client, message.params);
        await this.transitionRuntime('prompting');
      }
    } catch (error) {
      this.pending.delete(idKey(upstreamId));
      if (message.method === 'initialize') this.initializePending = false;
      if (
        message.method === 'session/prompt' &&
        this.activePromptClient === client
      ) {
        this.activePromptClient = undefined;
        this.expectedUserEchoes = [];
        await this.transitionRuntime('idle').catch(() => undefined);
      }
      throw error;
    }

    const provider = this.provider;
    try {
      await provider.attachment.receive(
        jsonRpcMessageSchema.parse({ ...message, id: upstreamId }),
      );
    } catch (error) {
      if (this.sessionId && this.provider === provider) {
        await this.providerStopped(provider, {
          success: false,
          code: 1,
          error: error instanceof Error ? error.message : String(error),
          stderrTail: provider.attachment.stderrTail(),
        }, 'io');
        return;
      }
      this.pending.delete(idKey(upstreamId));
      if (message.method === 'initialize') this.initializePending = false;
      throw error;
    }
  }

  async close(reason: string) {
    if (this.stopped) return;
    this.stopped = true;
    const provider = this.provider;
    provider.intentionalClose = true;
    await provider.attachment.close(reason).catch(() => undefined);
    await provider.readerTask?.catch(() => undefined);
    for (const client of [...this.clients]) {
      this.detach(client);
      this.closeClientStream(client);
    }
  }

  private installProvider(
    attachment: AgentAttachment,
    generation: number,
  ): ProviderGeneration {
    const provider: ProviderGeneration = {
      attachment,
      generation,
      intentionalClose: false,
      stopped: false,
    };
    provider.readerTask = this.readUpstream(provider);
    void attachment.finished.then(
      (exit) => this.providerStopped(provider, exit),
      (error) =>
        this.providerStopped(provider, {
          success: false,
          code: 1,
          error: error instanceof Error ? error.message : String(error),
          stderrTail: attachment.stderrTail(),
        }, 'stream'),
    ).catch(() => undefined);
    return provider;
  }

  private async readUpstream(provider: ProviderGeneration) {
    const reader = provider.attachment.messages.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.provider !== provider || provider.stopped) continue;
        await this.routeUpstream(provider, jsonRpcMessageSchema.parse(value));
      }
    } catch (error) {
      await this.providerStopped(provider, {
        success: false,
        code: 1,
        error: error instanceof Error ? error.message : String(error),
        stderrTail: provider.attachment.stderrTail(),
      }, 'stream');
    } finally {
      reader.releaseLock();
    }
  }

  private async routeUpstream(
    provider: ProviderGeneration,
    message: JsonRpcMessage,
  ) {
    if (this.provider !== provider || provider.stopped) return;
    if ('method' in message) {
      if (!('id' in message)) {
        if (this.consumeExpectedUserEcho(message)) return;
        if (message.method === 'session/update') {
          if (this.restoringInternally) return;
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
        await provider.attachment.receive({
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
      await this.transitionRuntime('awaiting_client');
      this.emit(client, { ...message, id: downstreamId });
      return;
    }

    if (message.id === null) return;
    const internal = this.internalPending.get(idKey(message.id));
    if (internal) {
      this.internalPending.delete(idKey(message.id));
      internal.resolve(message);
      return;
    }
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
        this.sessionSetupParams = {
          ...(objectFrom(pending.params) ?? {}),
          sessionId: boundSessionId,
        };
        try {
          await this.broker.bindSession(
            this,
            boundSessionId,
            pending.method === 'session/load' ? 'restoring' : 'idle',
          );
        } catch {
          this.recoveryState = 'unavailable';
          this.sessionId = undefined;
          this.sessionSetupParams = undefined;
          this.emit(pending.client, {
            jsonrpc: '2.0',
            id: pending.downstreamId,
            error: {
              code: rpcErrorCode.portalUnavailable,
              message: 'The Host could not persist the ACP runtime binding.',
              data: { code: 'RUNTIME_STATE_UNAVAILABLE' },
            },
          });
          return;
        }
      }
    }
    if (
      pending.method === 'session/prompt' &&
      this.activePromptClient === pending.client
    ) {
      this.activePromptClient = undefined;
      this.expectedUserEchoes = [];
      await this.transitionRuntime('idle');
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
    if (
      pending.method === 'session/load' &&
      'result' in message &&
      this.recoveryState === 'ready'
    ) {
      await this.transitionRuntime('idle');
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
      agentId: this.agentId,
      workspaceId: this.workspaceId,
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

  async bindRuntimeState(
    acpSessionId: string,
    state: 'idle' | 'restoring',
  ) {
    if (this.provider.generation > 0) return;
    const record = await this.broker.runtimeStateStore.start(
      this.runtimeStream(acpSessionId),
      state,
    );
    this.provider.generation = record.generation;
  }

  private async transitionRuntime(
    state:
      | 'idle'
      | 'prompting'
      | 'awaiting_client'
      | 'exited'
      | 'restoring'
      | 'uncertain'
      | 'unavailable',
    exit?: AgentAttachmentExit,
  ) {
    if (!this.sessionId || this.provider.generation <= 0) return;
    await this.broker.runtimeStateStore.transition(
      this.runtimeStream(this.sessionId),
      this.provider.generation,
      { state, ...(exit ? { exit } : {}) },
    );
  }

  private runtimeStream(acpSessionId: string): RuntimeStream {
    return {
      agentId: this.agentId,
      workspaceId: this.workspaceId,
      acpSessionId,
    };
  }

  private async providerStopped(
    provider: ProviderGeneration,
    exit: AgentAttachmentExit,
    source: 'exit' | 'stream' | 'io' = 'exit',
  ) {
    if (
      provider.stopped || provider.intentionalClose || this.stopped ||
      this.provider !== provider
    ) return;
    provider.stopped = true;
    if (source !== 'exit') {
      provider.intentionalClose = true;
      await provider.attachment.close('ACP provider transport failed.').catch(() => undefined);
    }
    if (this.recoveryTask && this.recoveryState === 'restoring') {
      for (const pending of this.internalPending.values()) {
        pending.reject(
          new Error('Replacement Agent process exited during recovery.'),
        );
      }
      this.internalPending.clear();
      return;
    }

    const interruptedPrompt = [...this.pending.values()].some((request) => request.method === 'session/prompt');
    try {
      await this.transitionRuntime(
        interruptedPrompt ? 'uncertain' : 'exited',
        exit,
      );
    } catch {
      this.recoveryState = 'unavailable';
      this.failPendingRequests(interruptedPrompt, provider.generation);
      this.emitRuntimeState(
        'unavailable',
        provider.generation,
        'RECOVERY_FAILED',
        'The Host could not persist the provider exit state.',
      );
      return;
    }
    this.emitRuntimeState(
      interruptedPrompt ? 'uncertain' : 'exited',
      provider.generation,
      interruptedPrompt ? 'PROMPT_UNCERTAIN' : 'PROCESS_EXITED',
      interruptedPrompt
        ? 'The Agent process exited after prompt delivery; completion is unknown.'
        : 'The Agent process exited and will be restored.',
    );
    this.failPendingRequests(interruptedPrompt, provider.generation);

    if (!this.sessionId) {
      this.stopped = true;
      this.finishClients(
        new Error(
          'Hosted ACP provider exited before a session was established.',
        ),
      );
      this.broker.runtimeStopped(this);
      return;
    }

    this.recoveryState = 'restoring';
    const recovery = this.recoverProvider(provider);
    this.recoveryTask = recovery;
    await recovery;
  }

  private failPendingRequests(
    interruptedPrompt: boolean,
    generation: number,
  ) {
    const coldLoadKey = this.coldSessionLoad?.upstreamRequestId === undefined
      ? undefined
      : idKey(this.coldSessionLoad.upstreamRequestId);
    for (const [key, pending] of this.pending) {
      if (key === coldLoadKey) continue;
      const uncertain = pending.method === 'session/prompt';
      this.emit(pending.client, {
        jsonrpc: '2.0',
        id: pending.downstreamId,
        error: {
          code: rpcErrorCode.portalUnavailable,
          message: uncertain
            ? 'The Agent process exited after prompt delivery; completion is unknown.'
            : 'The Agent process exited before the request completed.',
          data: {
            code: uncertain ? 'PROMPT_UNCERTAIN' : 'RUNTIME_RESTARTED',
            generation,
          },
        },
      });
    }
    this.pending.clear();
    for (const pending of this.internalPending.values()) {
      pending.reject(
        new Error(`Agent process exited during ${pending.method}.`),
      );
    }
    this.internalPending.clear();
    for (const waiter of this.initializeWaiters.splice(0)) {
      this.emit(waiter.client, {
        jsonrpc: '2.0',
        id: waiter.downstreamId,
        error: {
          code: rpcErrorCode.portalUnavailable,
          message: 'The Agent process exited during initialization.',
          data: { code: 'RUNTIME_RESTARTED', generation },
        },
      });
    }
    if (this.coldSessionLoad) {
      for (const waiter of this.coldSessionLoad.waiters) {
        this.emit(waiter.client, {
          jsonrpc: '2.0',
          id: waiter.downstreamId,
          error: {
            code: rpcErrorCode.portalUnavailable,
            message: 'The Agent process exited while restoring the session.',
            data: { code: 'RUNTIME_RESTARTED', generation },
          },
        });
      }
      this.coldSessionLoad = undefined;
    }
    for (const client of this.clients) client.agentRequests.clear();
    if (interruptedPrompt) {
      this.activePromptClient = undefined;
      this.expectedUserEchoes = [];
    }
    this.initializePending = false;
  }

  private async recoverProvider(previous: ProviderGeneration) {
    const sessionId = this.sessionId!;
    let state: RuntimeStateRecord;
    try {
      state = await this.broker.runtimeStateStore.start(
        this.runtimeStream(sessionId),
        'restoring',
      );
    } catch {
      this.recoveryState = 'unavailable';
      this.emitRuntimeState(
        'unavailable',
        previous.generation,
        'RECOVERY_FAILED',
        'The Host could not persist a replacement runtime generation.',
      );
      this.recoveryTask = undefined;
      return;
    }
    this.emitRuntimeState(
      'restoring',
      state.generation,
      'RESTORING',
      'The Host is restoring the ACP provider session.',
    );
    let next: ProviderGeneration | undefined;
    try {
      const attachment = await this.broker.attachProvider({
        agentId: this.agentId,
        workspaceId: this.workspaceId,
        acpSessionId: sessionId,
        principalId: this.input.principalId,
        transport: 'remote-acp',
      });
      next = this.installProvider(attachment, state.generation);
      this.provider = next;

      const initialized = await this.sendInternal(
        next,
        'initialize',
        this.initializeParams ?? {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'weave-host', version: '1' },
        },
      );
      if (!('result' in initialized)) {
        throw new Error('Agent initialization failed during recovery.');
      }
      this.initializeResult = withThreadEventsCapability(initialized.result);
      this.initialized = true;

      const capabilities = objectFrom(
        objectFrom(initialized.result)?.agentCapabilities,
      );
      const sessionCapabilities = objectFrom(
        capabilities?.sessionCapabilities,
      );
      const supportsResume = objectFrom(sessionCapabilities?.resume) !==
        undefined;
      const supportsLoad = capabilities?.loadSession === true;
      const params = {
        ...(objectFrom(this.sessionSetupParams) ?? {}),
        sessionId,
      };

      let restored = false;
      this.restoringInternally = true;
      try {
        if (supportsResume) {
          const resumed = await this.sendInternal(
            next,
            'session/resume',
            params,
          )
            .catch(() => undefined);
          restored = Boolean(resumed && 'result' in resumed);
        }
        if (!restored && supportsLoad) {
          const loaded = await this.sendInternal(next, 'session/load', params);
          restored = 'result' in loaded;
        }
      } finally {
        this.restoringInternally = false;
      }
      if (!restored) {
        throw new Error('CANNOT_RESUME');
      }

      this.recoveryState = 'ready';
      await this.transitionRuntime('idle');
      this.emitRuntimeState(
        'idle',
        state.generation,
        'RECOVERED',
        'The ACP provider session was restored.',
      );
    } catch (error) {
      this.recoveryState = 'unavailable';
      await this.broker.runtimeStateStore.transition(
        this.runtimeStream(sessionId),
        state.generation,
        { state: 'unavailable' },
      ).catch(() => undefined);
      const cannotResume = error instanceof Error &&
        error.message === 'CANNOT_RESUME';
      this.emitRuntimeState(
        'unavailable',
        state.generation,
        cannotResume ? 'CANNOT_RESUME' : 'RECOVERY_FAILED',
        cannotResume
          ? 'The Agent supports neither session/resume nor session/load.'
          : 'The ACP provider session could not be restored.',
      );
      if (next) {
        next.intentionalClose = true;
        await next.attachment.close('ACP runtime recovery failed.').catch(() => undefined);
      } else if (this.provider === previous) {
        previous.intentionalClose = true;
        await previous.attachment.close('ACP runtime recovery failed.').catch(
          () => undefined,
        );
      }
      this.recoveryTask = undefined;
      return;
    }
    this.recoveryTask = undefined;
  }

  private sendInternal(
    provider: ProviderGeneration,
    method: string,
    params: unknown,
  ) {
    const id = `weave-internal-${provider.generation}-${++this.nextRequestId}`;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      this.internalPending.set(idKey(id), { method, resolve, reject });
      provider.attachment.receive(
        jsonRpcMessageSchema.parse({ jsonrpc: '2.0', id, method, params }),
      ).catch((error) => {
        this.internalPending.delete(idKey(id));
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private emitRuntimeUnavailable(client: BrokerClient, id: JsonRpcId) {
    this.emit(client, {
      jsonrpc: '2.0',
      id,
      error: {
        code: rpcErrorCode.portalUnavailable,
        message: this.recoveryState === 'restoring'
          ? 'The ACP session is being restored.'
          : 'The ACP session cannot currently be resumed.',
        data: {
          code: this.recoveryState === 'restoring' ? 'SESSION_RESTORING' : 'CANNOT_RESUME',
          generation: this.provider.generation,
        },
      },
    });
  }

  private emitRuntimeState(
    state:
      | 'idle'
      | 'prompting'
      | 'awaiting_client'
      | 'exited'
      | 'restoring'
      | 'uncertain'
      | 'unavailable',
    generation: number,
    code:
      | 'PROCESS_EXITED'
      | 'PROMPT_UNCERTAIN'
      | 'RESTORING'
      | 'RECOVERED'
      | 'CANNOT_RESUME'
      | 'RECOVERY_FAILED',
    message: string,
  ) {
    if (!this.sessionId) return;
    const notification = jsonRpcMessageSchema.parse({
      jsonrpc: '2.0',
      method: WEAVE_ACP_RUNTIME_STATE_NOTIFICATION,
      params: weaveAcpRuntimeStateParamsSchema.parse({
        sessionId: this.sessionId,
        generation,
        state,
        code,
        message,
      }),
    });
    for (const client of this.clients) {
      if (
        client.threadEventsEnabled &&
        client.observingSessionId === this.sessionId
      ) {
        this.emit(client, notification);
      }
    }
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
    client.finish({
      success: !error,
      code: error ? 1 : 0,
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
      stderrTail: '',
    });
  }
}

export class AcpSessionBroker implements AgentRuntimePort {
  private readonly runtimes = new Set<HostedRuntime>();
  private readonly sessions = new Map<string, HostedRuntime>();
  private readonly spawningSessions = new Map<string, Promise<HostedRuntime>>();
  private closed = false;

  private readonly eventJournal: ThreadEventJournal;
  readonly runtimeStateStore: RuntimeStateStore;

  constructor(
    private readonly upstream: AgentRuntimePort,
    options: {
      eventJournal?: ThreadEventJournal;
      runtimeStateStore?: RuntimeStateStore;
    } = {},
  ) {
    this.eventJournal = options.eventJournal ??
      new InMemoryThreadEventJournal();
    this.runtimeStateStore = options.runtimeStateStore ??
      new InMemoryRuntimeStateStore();
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
    let finishClient!: (exit: AgentAttachmentExit) => void;
    const finished = new Promise<AgentAttachmentExit>((resolve) => {
      finishClient = resolve;
    });
    const client: BrokerClient = {
      id: crypto.randomUUID(),
      input,
      messages: undefined as unknown as ReadableStream<JsonRpcMessage>,
      agentRequests: new Map(),
      finished,
      finish: finishClient,
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
      agentId: runtime.agentId,
      workspaceId: runtime.workspaceId,
      messages,
      stderrTail: () => client.runtime?.stderrTail() ?? '',
      finished,
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
        client.finish({ success: true, code: 0, stderrTail: '' });
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

  async bindSession(
    runtime: HostedRuntime,
    acpSessionId: string,
    state: 'idle' | 'restoring' = 'idle',
  ) {
    const key = sessionKey(
      runtime.agentId,
      runtime.workspaceId,
      acpSessionId,
    );
    const existing = this.sessions.get(key);
    if (existing && existing !== runtime) {
      throw new Error(`ACP session is already hosted: ${acpSessionId}`);
    }
    this.sessions.set(key, runtime);
    try {
      await runtime.bindRuntimeState(acpSessionId, state);
    } catch (error) {
      if (this.sessions.get(key) === runtime) this.sessions.delete(key);
      throw error;
    }
  }

  attachProvider(input: AgentAttachInput) {
    return this.upstream.attach(input);
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
      input,
      reservedSessionId,
    );
    this.runtimes.add(runtime);
    if (reservedSessionId) {
      try {
        await this.bindSession(runtime, reservedSessionId, 'restoring');
      } catch (error) {
        this.runtimes.delete(runtime);
        await runtime.close('Host runtime state is unavailable.');
        throw error;
      }
    }
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
        runtime.agentId,
        runtime.workspaceId,
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
