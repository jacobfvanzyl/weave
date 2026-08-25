import type { ThreadSummary } from '@weave/product-protocol';
import { AgentProcess } from './agent-process.ts';
import type { AgentDefinition, WorkspaceDefinition } from './config.ts';
import { error, idKey, type JsonRpcId, type JsonRpcMessage, result } from './json-rpc.ts';
import { ThreadEventJournal, type ThreadEventRecord } from './thread-journal.ts';

export type ThreadAttachment = {
  receive(message: JsonRpcMessage): Promise<void>;
  close(): void;
};

type Attachment = {
  attachmentId: string;
  threadEventsEnabled: boolean;
  send(message: JsonRpcMessage): void;
};
type ClientPending = {
  attachment: Attachment;
  clientId: JsonRpcId;
  method: string;
  isPrompt: boolean;
  requestedModeId?: string;
};
type AgentPending = { attachmentId: string; providerId: JsonRpcId };

const sessionIdFrom = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent returned an invalid session/new result.');
  }
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Agent returned no ACP session ID.');
  return sessionId;
};

const sessionLoadStateFrom = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(record.modes === undefined ? {} : { modes: record.modes }),
    ...(record.configOptions === undefined ? {} : { configOptions: record.configOptions }),
    ...(record._meta === undefined ? {} : { _meta: record._meta }),
  };
};

const promptContentFrom = (params: unknown): unknown[] => {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [];
  const prompt = (params as { prompt?: unknown }).prompt;
  return Array.isArray(prompt) ? prompt : [];
};

const requestedModeIdFrom = (params: unknown) => {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return;
  const modeId = (params as { modeId?: unknown }).modeId;
  return typeof modeId === 'string' && modeId ? modeId : undefined;
};

const promptEchoKey = (content: unknown) => {
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const record = content as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      return JSON.stringify({ type: 'text', text: record.text });
    }
  }
  return JSON.stringify(content);
};

const PROXIED_CLIENT_CAPABILITIES = {
  elicitation: { form: {}, url: {} },
  plan: {},
  session: {
    compaction: {},
    configOptions: { boolean: {} },
  },
};

const THREAD_EVENTS_LOAD_META = 'weave.dev/threadEvents';
const THREAD_EVENT_UPDATE_META = 'weave.dev/threadEvent';
const THREAD_EVENTS_SYNC_METHOD = '_weave.dev/thread_events/sync';
const THREAD_EVENTS_ACK_METHOD = '_weave.dev/thread_events/ack';

const objectFrom = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const withThreadEventsCapability = (value: unknown) => {
  const initialize = objectFrom(value);
  const agentCapabilities = objectFrom(initialize.agentCapabilities);
  const meta = objectFrom(agentCapabilities._meta);
  const weave = objectFrom(meta['weave.dev']);
  return {
    ...initialize,
    agentCapabilities: {
      ...agentCapabilities,
      _meta: {
        ...meta,
        'weave.dev': {
          ...weave,
          threadEvents: {
            version: 1,
            ackMethod: THREAD_EVENTS_ACK_METHOD,
            syncNotification: THREAD_EVENTS_SYNC_METHOD,
          },
        },
      },
    },
  };
};

const threadEventsCursorFrom = (params: unknown): { enabled: false } | { enabled: true; afterSequence?: number } => {
  const extension = objectFrom(objectFrom(objectFrom(params)._meta)[THREAD_EVENTS_LOAD_META]);
  if (!Object.keys(extension).length) return { enabled: false };
  const cursor = extension.afterSequence;
  if (cursor === null) return { enabled: true };
  if (!Number.isInteger(cursor) || Number(cursor) < 0) {
    throw new Error('Thread event cursor must be a non-negative integer or null.');
  }
  return { enabled: true, afterSequence: Number(cursor) };
};

const messageForThreadEvent = (event: ThreadEventRecord): JsonRpcMessage => {
  const params = objectFrom(event.message.params);
  const update = objectFrom(params.update);
  return {
    ...event.message,
    params: {
      ...params,
      update: {
        ...update,
        _meta: {
          ...objectFrom(update._meta),
          [THREAD_EVENT_UPDATE_META]: {
            sequence: event.sequence,
            eventId: event.eventId,
            createdAt: event.createdAt,
          },
        },
      },
    },
  };
};

const FORWARDED_ATTACHMENT_REQUESTS = new Set([
  'session/set_mode',
  'session/set_config_option',
]);

export class HostedThread {
  readonly #process: AgentProcess;
  readonly #initializeResult: unknown;
  #sessionLoadResult: Record<string, unknown>;
  readonly #attachments = new Map<string, Attachment>();
  readonly #journal: ThreadEventJournal;
  readonly #clientPending = new Map<string, ClientPending>();
  readonly #agentPending = new Map<string, AgentPending>();
  readonly #onThreadChanged: (thread: ThreadSummary) => void;
  #activePromptAttachmentId?: string;
  #submittedPromptEchoes: string[] = [];
  #nextForwardedId = 0;
  #agentMessageQueue = Promise.resolve();

  private constructor(
    readonly thread: ThreadSummary,
    process: AgentProcess,
    initializeResult: unknown,
    sessionLoadResult: Record<string, unknown>,
    onThreadChanged: (thread: ThreadSummary) => void,
    journal: ThreadEventJournal,
  ) {
    this.#process = process;
    this.#initializeResult = initializeResult;
    this.#sessionLoadResult = sessionLoadResult;
    this.#onThreadChanged = onThreadChanged;
    this.#journal = journal;
  }

  static async create(
    workspace: WorkspaceDefinition,
    agent: AgentDefinition,
    title: string | undefined,
    onThreadChanged: (thread: ThreadSummary) => void,
    journal: ThreadEventJournal,
  ) {
    const buffered: JsonRpcMessage[] = [];
    const holder: { hosted?: HostedThread } = {};
    const process = new AgentProcess(
      agent,
      workspace.path,
      (message) => holder.hosted ? holder.hosted.#receiveAgent(message) : buffered.push(message),
    );
    const initializeResult = await process.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: PROXIED_CLIENT_CAPABILITIES,
      clientInfo: { name: 'Weave Portal', version: '0.1.0' },
    });
    const sessionResult = await process.request('session/new', { cwd: workspace.path, mcpServers: [] });
    const now = new Date().toISOString();
    const hosted = new HostedThread(
      {
        threadId: crypto.randomUUID(),
        workspaceId: workspace.workspaceId,
        agentId: agent.agentId,
        acpSessionId: sessionIdFrom(sessionResult),
        ...(title ? { title } : {}),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      process,
      initializeResult,
      sessionLoadStateFrom(sessionResult),
      onThreadChanged,
      journal,
    );
    holder.hosted = hosted;
    for (const message of buffered) hosted.#receiveAgent(message);
    return hosted;
  }

  static async restore(
    thread: ThreadSummary,
    workspace: WorkspaceDefinition,
    agent: AgentDefinition,
    onThreadChanged: (thread: ThreadSummary) => void,
    journal: ThreadEventJournal,
  ) {
    const buffered: JsonRpcMessage[] = [];
    const holder: { hosted?: HostedThread } = {};
    const process = new AgentProcess(
      agent,
      workspace.path,
      (message) => holder.hosted ? holder.hosted.#receiveAgent(message) : buffered.push(message),
    );
    const initializeResult = await process.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: PROXIED_CLIENT_CAPABILITIES,
      clientInfo: { name: 'Weave Portal', version: '0.1.0' },
    });
    const sessionLoadResult = await process.request('session/load', {
      sessionId: thread.acpSessionId,
      cwd: workspace.path,
      mcpServers: [],
    });
    const hosted = new HostedThread(
      thread,
      process,
      initializeResult,
      sessionLoadStateFrom(sessionLoadResult),
      onThreadChanged,
      journal,
    );
    holder.hosted = hosted;
    for (const message of buffered) hosted.#receiveAgent(message);
    return hosted;
  }

  connect(send: (message: JsonRpcMessage) => void): ThreadAttachment {
    const attachment: Attachment = { attachmentId: crypto.randomUUID(), threadEventsEnabled: false, send };
    this.#attachments.set(attachment.attachmentId, attachment);
    return {
      receive: async (message) => await this.#receiveClient(attachment, message),
      close: () => {
        this.#attachments.delete(attachment.attachmentId);
      },
    };
  }

  async close() {
    await this.#process.close();
    await this.#agentMessageQueue;
    this.#attachments.clear();
  }

  async #receiveClient(attachment: Attachment, message: JsonRpcMessage) {
    if (message.method === undefined && message.id !== undefined) {
      const pending = this.#agentPending.get(idKey(message.id));
      if (pending && pending.attachmentId === attachment.attachmentId) {
        this.#agentPending.delete(idKey(message.id));
        await this.#process.send({ ...message, id: pending.providerId });
      }
      return;
    }
    if (!message.method) return;
    if (message.id === undefined) {
      await this.#process.send(message);
      return;
    }
    if (message.method === 'initialize') {
      attachment.send(result(message.id, withThreadEventsCapability(this.#initializeResult)));
      return;
    }
    if (message.method === 'session/load') {
      const requested = (message.params as { sessionId?: unknown } | undefined)?.sessionId;
      if (requested !== this.thread.acpSessionId) {
        attachment.send(error(message.id, -32602, 'Thread ACP session does not match.'));
        return;
      }
      let cursor: ReturnType<typeof threadEventsCursorFrom>;
      try {
        cursor = threadEventsCursorFrom(message.params);
      } catch (cause) {
        attachment.send(error(message.id, -32602, cause instanceof Error ? cause.message : String(cause)));
        return;
      }
      attachment.threadEventsEnabled = cursor.enabled;
      await this.#agentMessageQueue;
      const replay = await this.#journal.read(
        this.thread.threadId,
        cursor.enabled ? cursor.afterSequence : undefined,
      );
      for (const event of replay.events) this.#sendThreadEvent(attachment, event);
      if (cursor.enabled) {
        attachment.send({
          jsonrpc: '2.0',
          method: THREAD_EVENTS_SYNC_METHOD,
          params: {
            sessionId: this.thread.acpSessionId,
            lastSequence: replay.lastSequence,
            fullReload: false,
          },
        });
      }
      attachment.send(result(message.id, this.#sessionLoadResult));
      return;
    }
    if (message.method === 'session/prompt') {
      if (this.#activePromptAttachmentId) {
        attachment.send(error(message.id, -32002, 'Another prompt is already active.'));
        return;
      }
      this.#activePromptAttachmentId = attachment.attachmentId;
      try {
        await this.#fanOutSubmittedPrompt(attachment, message.params);
        const providerId = `client:${++this.#nextForwardedId}`;
        this.#clientPending.set(idKey(providerId), {
          attachment,
          clientId: message.id,
          method: message.method,
          isPrompt: true,
        });
        await this.#process.send({ ...message, id: providerId });
      } catch (cause) {
        this.#activePromptAttachmentId = undefined;
        this.#submittedPromptEchoes = [];
        throw cause;
      }
      return;
    }
    if (FORWARDED_ATTACHMENT_REQUESTS.has(message.method)) {
      const providerId = `client:${++this.#nextForwardedId}`;
      this.#clientPending.set(idKey(providerId), {
        attachment,
        clientId: message.id,
        method: message.method,
        isPrompt: false,
        ...(message.method === 'session/set_mode' ? { requestedModeId: requestedModeIdFrom(message.params) } : {}),
      });
      await this.#process.send({ ...message, id: providerId });
      return;
    }
    attachment.send(error(message.id, -32601, `Portal does not support ${message.method}.`));
  }

  #receiveAgent(message: JsonRpcMessage) {
    this.#agentMessageQueue = this.#agentMessageQueue.then(() => this.#handleAgentMessage(message));
  }

  async #handleAgentMessage(message: JsonRpcMessage) {
    if (message.method && message.id !== undefined) {
      const controller = this.#activePromptAttachmentId
        ? this.#attachments.get(this.#activePromptAttachmentId)
        : this.#attachments.values().next().value as Attachment | undefined;
      if (!controller) {
        void this.#process.send(error(message.id, -32001, 'No client is available for the Agent request.'));
        return;
      }
      const clientId = `agent:${++this.#nextForwardedId}`;
      this.#agentPending.set(idKey(clientId), { attachmentId: controller.attachmentId, providerId: message.id });
      controller.send({ ...message, id: clientId });
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.#clientPending.get(idKey(message.id));
      if (!pending) return;
      this.#clientPending.delete(idKey(message.id));
      if (pending.isPrompt && this.#activePromptAttachmentId === pending.attachment.attachmentId) {
        this.#activePromptAttachmentId = undefined;
        this.#submittedPromptEchoes = [];
      }
      if (pending.method === 'session/set_config_option') {
        this.#sessionLoadResult = {
          ...this.#sessionLoadResult,
          ...sessionLoadStateFrom(message.result),
        };
      }
      if (!message.error && pending.requestedModeId) {
        await this.#confirmMode(pending.requestedModeId);
      }
      pending.attachment.send({ ...message, id: pending.clientId });
      this.thread.updatedAt = new Date().toISOString();
      this.#onThreadChanged(this.thread);
      return;
    }
    if (message.method) {
      if (message.method === 'session/update') {
        if (this.#consumeSubmittedPromptEcho(message.params)) return;
        const event = await this.#journal.append(this.thread.threadId, message);
        this.#captureSessionState(message.params);
        this.#fanOutThreadEvent(event);
        return;
      }
      for (const attachment of this.#attachments.values()) attachment.send(message);
    }
  }

  async #fanOutSubmittedPrompt(origin: Attachment, params: unknown) {
    const messageId = crypto.randomUUID();
    const contentBlocks = promptContentFrom(params);
    this.#submittedPromptEchoes = contentBlocks.map(promptEchoKey);
    for (const content of contentBlocks) {
      const update: JsonRpcMessage = {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: this.thread.acpSessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            messageId,
            content,
          },
        },
      };
      const event = await this.#journal.append(this.thread.threadId, update);
      for (const client of this.#attachments.values()) {
        if (client !== origin || client.threadEventsEnabled) this.#sendThreadEvent(client, event);
      }
    }
  }

  #consumeSubmittedPromptEcho(params: unknown) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
    const update = (params as { update?: unknown }).update;
    if (!update || typeof update !== 'object' || Array.isArray(update)) return false;
    const record = update as Record<string, unknown>;
    if (record.sessionUpdate !== 'user_message_chunk' || record.content === undefined) return false;
    const serialized = promptEchoKey(record.content);
    const index = this.#submittedPromptEchoes.indexOf(serialized);
    if (index === -1) return false;
    this.#submittedPromptEchoes.splice(index, 1);
    return true;
  }

  async #confirmMode(modeId: string) {
    const modes = this.#sessionLoadResult.modes;
    if (
      modes &&
      typeof modes === 'object' &&
      !Array.isArray(modes) &&
      (modes as { currentModeId?: unknown }).currentModeId === modeId
    ) return;
    const update: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: this.thread.acpSessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: modeId },
      },
    };
    const event = await this.#journal.append(this.thread.threadId, update);
    this.#captureSessionState(update.params);
    this.#fanOutThreadEvent(event);
  }

  #fanOutThreadEvent(event: ThreadEventRecord) {
    for (const attachment of this.#attachments.values()) this.#sendThreadEvent(attachment, event);
  }

  #sendThreadEvent(attachment: Attachment, event: ThreadEventRecord) {
    attachment.send(attachment.threadEventsEnabled ? messageForThreadEvent(event) : event.message);
  }

  #captureSessionState(params: unknown) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return;
    const update = (params as { update?: unknown }).update;
    if (!update || typeof update !== 'object' || Array.isArray(update)) return;
    const record = update as Record<string, unknown>;
    if (
      record.sessionUpdate === 'current_mode_update' &&
      typeof record.currentModeId === 'string'
    ) {
      const modes = this.#sessionLoadResult.modes;
      if (modes && typeof modes === 'object' && !Array.isArray(modes)) {
        this.#sessionLoadResult = {
          ...this.#sessionLoadResult,
          modes: { ...modes, currentModeId: record.currentModeId },
        };
      }
    }
    if (
      record.sessionUpdate === 'config_option_update' &&
      Array.isArray(record.configOptions)
    ) {
      this.#sessionLoadResult = {
        ...this.#sessionLoadResult,
        configOptions: record.configOptions,
      };
    }
  }
}
