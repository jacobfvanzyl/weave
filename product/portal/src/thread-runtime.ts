import type { ThreadSummary } from '@weave/product-protocol';
import { AgentProcess } from './agent-process.ts';
import type { AgentDefinition, WorkspaceDefinition } from './config.ts';
import { error, idKey, type JsonRpcId, type JsonRpcMessage, result } from './json-rpc.ts';

export type ThreadAttachment = {
  receive(message: JsonRpcMessage): Promise<void>;
  close(): void;
};

type Attachment = { attachmentId: string; send(message: JsonRpcMessage): void };
type ClientPending = { attachment: Attachment; clientId: JsonRpcId };
type AgentPending = { attachmentId: string; providerId: JsonRpcId };

const sessionIdFrom = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent returned an invalid session/new result.');
  }
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Agent returned no ACP session ID.');
  return sessionId;
};

export class HostedThread {
  readonly #process: AgentProcess;
  readonly #initializeResult: unknown;
  readonly #attachments = new Map<string, Attachment>();
  readonly #journal: JsonRpcMessage[] = [];
  readonly #clientPending = new Map<string, ClientPending>();
  readonly #agentPending = new Map<string, AgentPending>();
  readonly #onThreadChanged: (thread: ThreadSummary) => void;
  #activePromptAttachmentId?: string;
  #nextForwardedId = 0;

  private constructor(
    readonly thread: ThreadSummary,
    process: AgentProcess,
    initializeResult: unknown,
    onThreadChanged: (thread: ThreadSummary) => void,
  ) {
    this.#process = process;
    this.#initializeResult = initializeResult;
    this.#onThreadChanged = onThreadChanged;
  }

  static async create(
    workspace: WorkspaceDefinition,
    agent: AgentDefinition,
    title: string | undefined,
    onThreadChanged: (thread: ThreadSummary) => void,
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
      clientCapabilities: {},
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
      onThreadChanged,
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
      clientCapabilities: {},
      clientInfo: { name: 'Weave Portal', version: '0.1.0' },
    });
    await process.request('session/load', { sessionId: thread.acpSessionId, cwd: workspace.path, mcpServers: [] });
    const hosted = new HostedThread(thread, process, initializeResult, onThreadChanged);
    holder.hosted = hosted;
    for (const message of buffered) hosted.#receiveAgent(message);
    return hosted;
  }

  connect(send: (message: JsonRpcMessage) => void): ThreadAttachment {
    const attachment: Attachment = { attachmentId: crypto.randomUUID(), send };
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
      attachment.send(result(message.id, this.#initializeResult));
      return;
    }
    if (message.method === 'session/load') {
      const requested = (message.params as { sessionId?: unknown } | undefined)?.sessionId;
      if (requested !== this.thread.acpSessionId) {
        attachment.send(error(message.id, -32602, 'Thread ACP session does not match.'));
        return;
      }
      for (const update of this.#journal) attachment.send(update);
      attachment.send(result(message.id, null));
      return;
    }
    if (message.method === 'session/prompt') {
      if (this.#activePromptAttachmentId) {
        attachment.send(error(message.id, -32002, 'Another prompt is already active.'));
        return;
      }
      this.#activePromptAttachmentId = attachment.attachmentId;
      const providerId = `client:${++this.#nextForwardedId}`;
      this.#clientPending.set(idKey(providerId), { attachment, clientId: message.id });
      await this.#process.send({ ...message, id: providerId });
      return;
    }
    attachment.send(error(message.id, -32601, `Portal does not support ${message.method}.`));
  }

  #receiveAgent(message: JsonRpcMessage) {
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
      this.#activePromptAttachmentId = undefined;
      pending.attachment.send({ ...message, id: pending.clientId });
      this.thread.updatedAt = new Date().toISOString();
      this.#onThreadChanged(this.thread);
      return;
    }
    if (message.method) {
      if (message.method === 'session/update') this.#journal.push(message);
      for (const attachment of this.#attachments.values()) attachment.send(message);
    }
  }
}
