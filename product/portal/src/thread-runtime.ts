import type { ThreadSummary } from '@weave/product-protocol';
import {
  messageForThreadEvent,
  RESUME_GAP_ERROR,
  RUNTIME_STATE_METHOD,
  RUNTIME_UNAVAILABLE_ERROR,
  THREAD_EVENTS_ACK_METHOD,
  THREAD_EVENTS_SYNC_METHOD,
  threadEventAckFrom,
  threadEventsCursorFrom,
  withWeaveCapabilities,
} from './acp-extension.ts';
import { AgentProcess, type AgentProcessExit } from './agent-process.ts';
import type { AgentDefinition, WorkspaceDefinition } from './config.ts';
import { error, idKey, type JsonRpcId, type JsonRpcMessage, result } from './json-rpc.ts';
import {
  ACP_INITIALIZE_PARAMS,
  restoreProviderSession,
  sessionIdFrom,
  sessionLoadStateFrom,
  supportsSessionLoad,
} from './provider-protocol.ts';
import { RuntimeStateStore } from './runtime-state.ts';
import { ThreadEventJournal, type ThreadEventRecord } from './thread-journal.ts';

export type ThreadAttachment = {
  receive(message: JsonRpcMessage): Promise<void>;
  close(): void;
};

export class ThreadPromptActiveError extends Error {
  constructor() {
    super('Stop the active prompt before archiving this Thread.');
    this.name = 'ThreadPromptActiveError';
  }
}

type Attachment = {
  attachmentId: string;
  acknowledgedSequence: number;
  threadEventsEnabled: boolean;
  send(message: JsonRpcMessage): void;
  disconnect(reason: string): void;
};
type ClientPending = {
  attachment: Attachment;
  clientId: JsonRpcId;
  method: string;
  isPrompt: boolean;
  requestedModeId?: string;
};
type AgentPending = { attachmentId: string; providerId: JsonRpcId };
type ThreadChanged = (thread: ThreadSummary) => Promise<void>;
type ThreadPromoted = (thread: ThreadSummary) => Promise<void>;

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

const FORWARDED_ATTACHMENT_REQUESTS = new Set([
  'session/set_mode',
  'session/set_config_option',
]);

export class HostedThread {
  #process: AgentProcess;
  #initializeResult: unknown;
  #sessionLoadResult: Record<string, unknown>;
  readonly #workspace: WorkspaceDefinition;
  readonly #agent: AgentDefinition;
  readonly #attachments = new Map<string, Attachment>();
  readonly #journal: ThreadEventJournal;
  readonly #runtimeStates: RuntimeStateStore;
  readonly #clientPending = new Map<string, ClientPending>();
  readonly #agentPending = new Map<string, AgentPending>();
  readonly #onThreadChanged: ThreadChanged;
  #onFirstPrompt?: ThreadPromoted;
  #activePromptAttachmentId?: string;
  #submittedPromptEchoes: string[] = [];
  #nextForwardedId = 0;
  #agentMessageQueue = Promise.resolve();
  #providerReplayCapture?: JsonRpcMessage[];
  #providerReplayTask?: Promise<{ messages: JsonRpcMessage[]; state: Record<string, unknown> }>;
  #generation: number;
  #recoveryState: 'ready' | 'restoring' | 'unavailable' = 'ready';
  #restoringInternally = false;
  #accepting = true;
  #closing = false;

  private constructor(
    readonly thread: ThreadSummary,
    workspace: WorkspaceDefinition,
    agent: AgentDefinition,
    process: AgentProcess,
    generation: number,
    initializeResult: unknown,
    sessionLoadResult: Record<string, unknown>,
    onThreadChanged: ThreadChanged,
    journal: ThreadEventJournal,
    runtimeStates: RuntimeStateStore,
    onFirstPrompt?: ThreadPromoted,
  ) {
    this.#workspace = workspace;
    this.#agent = agent;
    this.#process = process;
    this.#generation = generation;
    this.#initializeResult = initializeResult;
    this.#sessionLoadResult = sessionLoadResult;
    this.#onThreadChanged = onThreadChanged;
    this.#journal = journal;
    this.#runtimeStates = runtimeStates;
    this.#onFirstPrompt = onFirstPrompt;
  }

  static async create(
    workspace: WorkspaceDefinition,
    agent: AgentDefinition,
    title: string | undefined,
    onThreadChanged: ThreadChanged,
    journal: ThreadEventJournal,
    runtimeStates: RuntimeStateStore,
    onFirstPrompt?: ThreadPromoted,
  ) {
    const threadId = crypto.randomUUID();
    const runtimeState = await runtimeStates.start(threadId, 'idle');
    const buffered: JsonRpcMessage[] = [];
    const holder: { hosted?: HostedThread } = {};
    const process = new AgentProcess(
      agent,
      workspace.path,
      (message) =>
        holder.hosted ? holder.hosted.#receiveAgent(runtimeState.generation, message) : buffered.push(message),
      (exit) => {
        if (holder.hosted) void holder.hosted.#providerStopped(runtimeState.generation, exit);
      },
    );
    const initializeResult = await process.request('initialize', ACP_INITIALIZE_PARAMS);
    const sessionResult = await process.request('session/new', { cwd: workspace.path, mcpServers: [] });
    const now = new Date().toISOString();
    const hosted = new HostedThread(
      {
        threadId,
        workspaceId: workspace.workspaceId,
        agentId: agent.agentId,
        acpSessionId: sessionIdFrom(sessionResult),
        ...(title ? { title } : {}),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      workspace,
      agent,
      process,
      runtimeState.generation,
      initializeResult,
      sessionLoadStateFrom(sessionResult),
      onThreadChanged,
      journal,
      runtimeStates,
      onFirstPrompt,
    );
    holder.hosted = hosted;
    for (const message of buffered) hosted.#receiveAgent(runtimeState.generation, message);
    return hosted;
  }

  static async restore(
    thread: ThreadSummary,
    workspace: WorkspaceDefinition,
    agent: AgentDefinition,
    onThreadChanged: ThreadChanged,
    journal: ThreadEventJournal,
    runtimeStates: RuntimeStateStore,
  ) {
    const runtimeState = await runtimeStates.start(thread.threadId, 'restoring');
    const buffered: JsonRpcMessage[] = [];
    const holder: { hosted?: HostedThread } = {};
    const spawn = () =>
      new AgentProcess(
        agent,
        workspace.path,
        (message) =>
          holder.hosted ? holder.hosted.#receiveAgent(runtimeState.generation, message) : buffered.push(message),
        (exit) => {
          if (holder.hosted) void holder.hosted.#providerStopped(runtimeState.generation, exit);
        },
      );
    let process = spawn();
    let restoredThread = thread;
    let replacedSession = false;
    try {
      let initializeResult = await process.request('initialize', ACP_INITIALIZE_PARAMS);
      let sessionLoadResult: unknown;
      try {
        sessionLoadResult = await restoreProviderSession(process, initializeResult, {
          sessionId: thread.acpSessionId,
          cwd: workspace.path,
          mcpServers: [],
        });
      } catch (restoreCause) {
        await process.close().catch(() => undefined);
        if (!await journal.clearIfNoConversation(thread.threadId)) throw restoreCause;

        buffered.length = 0;
        process = spawn();
        initializeResult = await process.request('initialize', ACP_INITIALIZE_PARAMS);
        sessionLoadResult = await process.request('session/new', { cwd: workspace.path, mcpServers: [] });
        restoredThread = {
          ...thread,
          acpSessionId: sessionIdFrom(sessionLoadResult),
          updatedAt: new Date().toISOString(),
        };
        await onThreadChanged(restoredThread);
        replacedSession = true;
      }

      await runtimeStates.transition(thread.threadId, runtimeState.generation, 'idle');
      const hosted = new HostedThread(
        restoredThread,
        workspace,
        agent,
        process,
        runtimeState.generation,
        initializeResult,
        sessionLoadStateFrom(sessionLoadResult),
        onThreadChanged,
        journal,
        runtimeStates,
      );
      holder.hosted = hosted;
      for (const message of buffered) {
        if (replacedSession || message.method !== 'session/update') {
          hosted.#receiveAgent(runtimeState.generation, message);
        }
      }
      return hosted;
    } catch (cause) {
      await process.close().catch(() => undefined);
      await runtimeStates.transition(thread.threadId, runtimeState.generation, 'unavailable').catch(() => undefined);
      throw cause;
    }
  }

  connect(
    send: (message: JsonRpcMessage) => void,
    disconnect: (reason: string) => void = () => undefined,
  ): ThreadAttachment {
    if (!this.#accepting) throw new Error('Thread is unavailable.');
    const attachment: Attachment = {
      attachmentId: crypto.randomUUID(),
      acknowledgedSequence: 0,
      threadEventsEnabled: false,
      send,
      disconnect,
    };
    this.#attachments.set(attachment.attachmentId, attachment);
    return {
      receive: async (message) => await this.#receiveClient(attachment, message),
      close: () => {
        this.#attachments.delete(attachment.attachmentId);
      },
    };
  }

  async archive() {
    if (this.#activePromptAttachmentId) throw new ThreadPromptActiveError();
    await this.close('Thread archived.');
  }

  async close(reason = 'Portal is shutting down.') {
    if (this.#closing) return;
    this.#accepting = false;
    this.#closing = true;
    for (const attachment of [...this.#attachments.values()]) attachment.disconnect(reason);
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
    if (!this.#accepting) {
      if (message.id !== undefined) {
        attachment.send(error(message.id, -32002, 'Thread is unavailable.'));
      }
      return;
    }
    if (message.id === undefined) {
      await this.#process.send(message);
      return;
    }
    if (message.method === 'initialize') {
      attachment.send(result(message.id, withWeaveCapabilities(this.#initializeResult)));
      return;
    }
    if (message.method === THREAD_EVENTS_ACK_METHOD) {
      let acknowledgement: ReturnType<typeof threadEventAckFrom>;
      try {
        acknowledgement = threadEventAckFrom(message.params);
      } catch (cause) {
        attachment.send(error(message.id, -32602, cause instanceof Error ? cause.message : String(cause)));
        return;
      }
      if (!attachment.threadEventsEnabled || acknowledgement.sessionId !== this.thread.acpSessionId) {
        attachment.send(error(message.id, -32002, 'The client is not observing that Thread event stream.'));
        return;
      }
      let window: Awaited<ReturnType<ThreadEventJournal['read']>>;
      try {
        window = await this.#journal.read(this.thread.threadId, acknowledgement.sequence);
      } catch {
        attachment.send(error(message.id, -32602, 'Thread event acknowledgement is out of range.'));
        return;
      }
      if (acknowledgement.sequence < attachment.acknowledgedSequence || window.cursorExpired) {
        this.#sendResumeGap(attachment, message.id, window.compactedThrough, window.lastSequence);
        return;
      }
      attachment.acknowledgedSequence = acknowledgement.sequence;
      attachment.send(result(message.id, { acknowledgedSequence: acknowledgement.sequence }));
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
      await this.#agentMessageQueue;
      let replay: Awaited<ReturnType<ThreadEventJournal['read']>>;
      try {
        replay = await this.#journal.read(
          this.thread.threadId,
          cursor.enabled ? cursor.afterSequence : undefined,
        );
      } catch {
        attachment.send(error(message.id, -32602, 'Thread event cursor is out of range.'));
        return;
      }
      if (cursor.enabled && cursor.afterSequence !== undefined && replay.cursorExpired) {
        this.#sendResumeGap(attachment, message.id, replay.compactedThrough, replay.lastSequence);
        return;
      }
      attachment.threadEventsEnabled = cursor.enabled;
      attachment.acknowledgedSequence = 0;
      const needsProviderReplay = replay.compactedThrough > 0 &&
        (!cursor.enabled || cursor.afterSequence === undefined);
      if (needsProviderReplay) {
        if (this.#recoveryState !== 'ready') {
          attachment.send(error(message.id, RUNTIME_UNAVAILABLE_ERROR, 'The ACP session cannot be fully reloaded.', {
            code: 'CANNOT_RESUME',
            generation: this.#generation,
          }));
          return;
        }
        try {
          const providerReplay = await this.#loadProviderReplay();
          this.#sessionLoadResult = { ...this.#sessionLoadResult, ...providerReplay.state };
          for (const providerMessage of providerReplay.messages) attachment.send(providerMessage);
        } catch {
          attachment.send(
            error(message.id, RUNTIME_UNAVAILABLE_ERROR, 'The ACP provider transcript cannot be loaded.', {
              code: 'CANNOT_RESUME',
              generation: this.#generation,
            }),
          );
          return;
        }
      } else {
        for (const event of replay.events) this.#sendThreadEvent(attachment, event);
      }
      if (cursor.enabled) {
        attachment.send({
          jsonrpc: '2.0',
          method: THREAD_EVENTS_SYNC_METHOD,
          params: {
            sessionId: this.thread.acpSessionId,
            lastSequence: replay.lastSequence,
            fullReload: needsProviderReplay,
          },
        });
      }
      attachment.send(result(message.id, this.#sessionLoadResult));
      return;
    }
    if (message.method === 'session/resume') {
      const requested = (message.params as { sessionId?: unknown } | undefined)?.sessionId;
      if (requested !== this.thread.acpSessionId) {
        attachment.send(error(message.id, -32602, 'Thread ACP session does not match.'));
        return;
      }
      attachment.threadEventsEnabled = false;
      attachment.acknowledgedSequence = 0;
      attachment.send(result(message.id, this.#sessionLoadResult));
      return;
    }
    if (this.#recoveryState !== 'ready') {
      attachment.send(error(message.id, RUNTIME_UNAVAILABLE_ERROR, 'The ACP session is not currently available.', {
        code: this.#recoveryState === 'restoring' ? 'SESSION_RESTORING' : 'CANNOT_RESUME',
        generation: this.#generation,
      }));
      return;
    }
    if (message.method === 'session/prompt') {
      if (this.#activePromptAttachmentId) {
        attachment.send(error(message.id, -32002, 'Another prompt is already active.'));
        return;
      }
      const onFirstPrompt = this.#onFirstPrompt;
      if (onFirstPrompt) {
        await onFirstPrompt(this.thread);
        this.#onFirstPrompt = undefined;
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

  #receiveAgent(generation: number, message: JsonRpcMessage) {
    if (generation !== this.#generation) return;
    if (this.#providerReplayCapture && message.method === 'session/update') {
      this.#providerReplayCapture.push(message);
      return;
    }
    if (this.#restoringInternally && message.method === 'session/update') return;
    this.#agentMessageQueue = this.#agentMessageQueue.then(async () => {
      if (generation === this.#generation) await this.#handleAgentMessage(message);
    });
  }

  async #providerStopped(generation: number, exit: AgentProcessExit) {
    if (this.#closing || generation !== this.#generation) return;
    if (this.#recoveryState === 'restoring') {
      this.#recoveryState = 'unavailable';
      await this.#runtimeStates.transition(this.thread.threadId, generation, 'unavailable', exit).catch(() =>
        undefined
      );
      this.#emitRuntimeState(
        'unavailable',
        generation,
        'RECOVERY_FAILED',
        'The replacement Agent process exited during recovery.',
      );
      return;
    }

    const interruptedPrompt = [...this.#clientPending.values()].some((pending) => pending.isPrompt);
    const state = interruptedPrompt ? 'uncertain' : 'exited';
    await this.#runtimeStates.transition(this.thread.threadId, generation, state, exit).catch(() => undefined);
    this.#emitRuntimeState(
      state,
      generation,
      interruptedPrompt ? 'PROMPT_UNCERTAIN' : 'PROCESS_EXITED',
      interruptedPrompt
        ? 'The Agent process exited after prompt delivery; completion is unknown.'
        : 'The Agent process exited and will be restored.',
    );
    this.#failPendingProviderRequests(generation);
    this.#recoveryState = 'restoring';
    await this.#recoverProvider();
  }

  #failPendingProviderRequests(generation: number) {
    for (const pending of this.#clientPending.values()) {
      pending.attachment.send(error(
        pending.clientId,
        RUNTIME_UNAVAILABLE_ERROR,
        pending.isPrompt
          ? 'The Agent process exited after prompt delivery; completion is unknown.'
          : 'The Agent process exited before the request completed.',
        { code: pending.isPrompt ? 'PROMPT_UNCERTAIN' : 'RUNTIME_RESTARTED', generation },
      ));
    }
    this.#clientPending.clear();
    this.#agentPending.clear();
    this.#activePromptAttachmentId = undefined;
    this.#submittedPromptEchoes = [];
  }

  async #recoverProvider() {
    let generation = this.#generation;
    let replacement: AgentProcess | undefined;
    try {
      const state = await this.#runtimeStates.start(this.thread.threadId, 'restoring');
      generation = state.generation;
      this.#generation = generation;
      this.#emitRuntimeState('restoring', generation, 'RESTORING', 'The Host is restoring the ACP provider session.');

      const process = new AgentProcess(
        this.#agent,
        this.#workspace.path,
        (message) => this.#receiveAgent(generation, message),
        (exit) => void this.#providerStopped(generation, exit),
      );
      replacement = process;
      this.#process = process;
      this.#restoringInternally = true;
      const initializeResult = await process.request('initialize', ACP_INITIALIZE_PARAMS);
      const sessionLoadResult = await restoreProviderSession(process, initializeResult, {
        sessionId: this.thread.acpSessionId,
        cwd: this.#workspace.path,
        mcpServers: [],
      });
      this.#initializeResult = initializeResult;
      this.#sessionLoadResult = {
        ...this.#sessionLoadResult,
        ...sessionLoadStateFrom(sessionLoadResult),
      };
      this.#restoringInternally = false;
      await this.#agentMessageQueue;
      await this.#runtimeStates.transition(this.thread.threadId, generation, 'idle');
      this.#recoveryState = 'ready';
      this.#emitRuntimeState('idle', generation, 'RECOVERED', 'The ACP provider session was restored.');
    } catch (cause) {
      this.#restoringInternally = false;
      this.#recoveryState = 'unavailable';
      await this.#runtimeStates.transition(this.thread.threadId, generation, 'unavailable').catch(() => undefined);
      const cannotResume = cause instanceof Error && cause.message === 'CANNOT_RESUME';
      this.#emitRuntimeState(
        'unavailable',
        generation,
        cannotResume ? 'CANNOT_RESUME' : 'RECOVERY_FAILED',
        cannotResume
          ? 'The Agent supports neither session/resume nor session/load.'
          : 'The ACP provider session could not be restored.',
      );
      await replacement?.close().catch(() => undefined);
    }
  }

  #loadProviderReplay() {
    if (this.#providerReplayTask) return this.#providerReplayTask;
    const operation = (async () => {
      if (!supportsSessionLoad(this.#initializeResult)) throw new Error('CANNOT_RESUME');
      if (this.#activePromptAttachmentId) throw new Error('SESSION_BUSY');
      const messages: JsonRpcMessage[] = [];
      this.#providerReplayCapture = messages;
      try {
        const loaded = await this.#process.request('session/load', {
          sessionId: this.thread.acpSessionId,
          cwd: this.#workspace.path,
          mcpServers: [],
        });
        return { messages, state: sessionLoadStateFrom(loaded) };
      } finally {
        if (this.#providerReplayCapture === messages) this.#providerReplayCapture = undefined;
      }
    })();
    this.#providerReplayTask = operation;
    void operation.then(() => {
      if (this.#providerReplayTask === operation) this.#providerReplayTask = undefined;
    }, () => {
      if (this.#providerReplayTask === operation) this.#providerReplayTask = undefined;
    });
    return operation;
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
      await this.#onThreadChanged(this.thread);
      return;
    }
    if (message.method) {
      if (message.method === 'session/update') {
        if (this.#consumeSubmittedPromptEcho(message.params)) return;
        const event = await this.#journal.append(this.thread.threadId, message);
        await this.#captureSessionState(message.params);
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
    await this.#captureSessionState(update.params);
    this.#fanOutThreadEvent(event);
  }

  #fanOutThreadEvent(event: ThreadEventRecord) {
    for (const attachment of this.#attachments.values()) this.#sendThreadEvent(attachment, event);
  }

  #sendThreadEvent(attachment: Attachment, event: ThreadEventRecord) {
    attachment.send(attachment.threadEventsEnabled ? messageForThreadEvent(event) : event.message);
  }

  #sendResumeGap(attachment: Attachment, id: JsonRpcId, compactedThrough: number, lastSequence: number) {
    attachment.send(error(id, RESUME_GAP_ERROR, 'The requested Thread event cursor has expired.', {
      code: 'RESUME_GAP',
      compactedThrough,
      lastSequence,
      reloadAfterSequence: null,
    }));
  }

  #emitRuntimeState(
    state: 'idle' | 'exited' | 'restoring' | 'uncertain' | 'unavailable',
    generation: number,
    code: 'PROCESS_EXITED' | 'PROMPT_UNCERTAIN' | 'RESTORING' | 'RECOVERED' | 'CANNOT_RESUME' | 'RECOVERY_FAILED',
    message: string,
  ) {
    const notification: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: RUNTIME_STATE_METHOD,
      params: { sessionId: this.thread.acpSessionId, generation, state, code, message },
    };
    for (const attachment of this.#attachments.values()) {
      if (attachment.threadEventsEnabled) attachment.send(notification);
    }
  }

  async #captureSessionState(params: unknown) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return;
    const sessionId = (params as { sessionId?: unknown }).sessionId;
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
    if (
      record.sessionUpdate === 'session_info_update' &&
      sessionId === this.thread.acpSessionId
    ) {
      const hasTitle = Object.prototype.hasOwnProperty.call(record, 'title');
      const validTitle = record.title === null || typeof record.title === 'string';
      const validUpdatedAt = typeof record.updatedAt === 'string' &&
        Number.isFinite(Date.parse(record.updatedAt));
      let changed = false;
      if (hasTitle && validTitle) {
        const title = typeof record.title === 'string' ? record.title : undefined;
        if (this.thread.title !== title) {
          if (title === undefined) delete this.thread.title;
          else this.thread.title = title;
          changed = true;
        }
      }
      if (validUpdatedAt && this.thread.updatedAt !== record.updatedAt) {
        this.thread.updatedAt = record.updatedAt as string;
        changed = true;
      } else if (changed && !validUpdatedAt) {
        this.thread.updatedAt = new Date().toISOString();
      }
      if (changed) await this.#onThreadChanged(this.thread);
    }
  }
}
