import {
  type AgentSummary,
  parsePortalRpcResult,
  parseWorkspaceFileErrorData,
  parseWorkspaceFileWatchNotification,
  type PortalRpcMethod,
  type PortalRpcParams,
  type PortalRpcResult,
  type ThreadSummary,
  WORKSPACE_FILE_WATCH_EVENT_METHOD,
  type WorkspaceFileErrorData,
  type WorkspaceFileWatchEvent,
  type WorkspaceSummary,
} from '@weave/product-protocol';
import type {
  ContentBlock,
  CreateElicitationResponse,
} from '@agentclientprotocol/sdk';
import { AcpSessionClient } from '@/chat/acp-client';
import type { AcpTranscriptEvent } from '@/chat/acp-transcript';
import { portalWebSocketUrl } from '@/portal-address';
import { authenticatedPortalWebSocket } from '@/portal-authenticated-websocket';
import type { PortalCredentialSigner } from '@/portal-credential';

type JsonRpcId = number;
type PendingRequest = {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
};
type NotificationHandler = (method: string, params: unknown) => void;

export class PortalRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: WorkspaceFileErrorData | unknown,
  ) {
    super(message);
    this.name = 'PortalRpcError';
  }
}

export class PortalTransportError extends Error {
  constructor(
    message: string,
    readonly closeCode?: number,
  ) {
    super(message);
    this.name = 'PortalTransportError';
  }
}

class JsonRpcWebSocket {
  private nextId = 0;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private opened: Promise<void>;
  private closedByClient = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly onNotification?: NotificationHandler,
    private readonly onUnexpectedClose?: (error: Error) => void,
  ) {
    this.opened = new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () =>
        reject(
          new PortalTransportError(
            'The Host WebSocket could not be opened.',
          ),
        );
    });
    socket.onmessage = (event) => this.receive(String(event.data));
    socket.onclose = (event) => {
      const error = new PortalTransportError(
        event.reason || `The Host WebSocket closed (${event.code}).`,
        event.code,
      );
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      if (!this.closedByClient) this.onUnexpectedClose?.(error);
    };
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.opened;
    const id = ++this.nextId;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          ...(params === undefined ? {} : { params }),
        }),
      );
    });
  }

  close() {
    this.closedByClient = true;
    this.socket.close(1000, 'Weave disconnected.');
  }

  private receive(text: string) {
    const message = JSON.parse(text) as Record<string, unknown>;
    if (typeof message.method === 'string') {
      if (typeof message.id === 'number') {
        this.socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32601,
              message: `Method not supported by Weave: ${message.method}`,
            },
          }),
        );
      } else {
        this.onNotification?.(message.method, message.params);
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error && typeof message.error === 'object') {
      const error = message.error as {
        code?: unknown;
        message?: unknown;
        data?: unknown;
      };
      let data = error.data;
      try {
        if (
          (data as { domain?: unknown } | undefined)?.domain ===
          'workspace-filesystem'
        ) {
          data = parseWorkspaceFileErrorData(data);
        }
      } catch {
        // Preserve malformed remote error data as opaque evidence.
      }
      pending.reject(
        new PortalRpcError(
          typeof error.code === 'number' ? error.code : -32000,
          typeof error.message === 'string'
            ? error.message
            : `${pending.method} failed.`,
          data,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }
}

export type HostSnapshot = {
  hostId: string;
  displayName: string;
  capabilities: string[];
  workspaces: WorkspaceSummary[];
  agents: AgentSummary[];
  threads: ThreadSummary[];
  archivedThreads: ThreadSummary[];
};

export class DirectHostClient {
  private readonly baseUrl: URL;
  private readonly WebSocket: ReturnType<typeof authenticatedPortalWebSocket>;
  private rpc: JsonRpcWebSocket;
  private acp?: AcpSessionClient;
  private activeThread?: ThreadSummary;
  private readonly workspaceFileWatchListeners = new Map<
    string,
    (event: WorkspaceFileWatchEvent) => void
  >();

  constructor(
    hostUrl: string,
    credential: PortalCredentialSigner,
    private readonly onAcpEvent: (event: AcpTranscriptEvent) => void,
    onUnexpectedClose?: (error: Error) => void,
  ) {
    this.baseUrl = portalWebSocketUrl(hostUrl);
    this.WebSocket = authenticatedPortalWebSocket(credential);
    this.rpc = new JsonRpcWebSocket(
      new this.WebSocket(this.baseUrl.toString()) as unknown as WebSocket,
      (method, params) => this.handleNotification(method, params),
      onUnexpectedClose,
    );
  }

  async snapshot(): Promise<HostSnapshot> {
    const capabilities = await this.request('portal.capabilities', {});
    const supportsThreadLifecycle =
      capabilities.capabilities.includes('thread.archive') &&
      capabilities.capabilities.includes('thread.restore');
    const [workspaces, agents, threads, archivedThreads] = await Promise.all([
      this.request('workspace.list', {}),
      this.request('agent.list', {}),
      this.request('thread.list', { status: 'active' }),
      supportsThreadLifecycle
        ? this.request('thread.list', { status: 'archived' })
        : Promise.resolve({ threads: [] }),
    ]);
    return {
      hostId: capabilities.hostId,
      displayName: capabilities.displayName,
      capabilities: capabilities.capabilities,
      workspaces: workspaces.workspaces,
      agents: agents.agents,
      threads: threads.threads,
      archivedThreads: archivedThreads.threads,
    };
  }

  async attach(threadId: string) {
    const prepared = await this.request('thread.attach', { threadId });
    this.acp?.close();
    this.activeThread = prepared.thread;
    this.onAcpEvent({
      type: 'history/reset',
      sessionId: prepared.thread.acpSessionId,
    });
    const url = new URL(this.baseUrl);
    url.pathname = prepared.connection.path;
    url.searchParams.set('threadId', prepared.connection.threadId);
    this.acp = new AcpSessionClient({
      url: url.toString(),
      WebSocket: this.WebSocket,
      onEvent: this.onAcpEvent,
    });
    await this.acp.initializeAndLoad({
      sessionId: prepared.thread.acpSessionId,
      cwd: prepared.connection.cwd,
    });
    return prepared.thread;
  }

  async createThread(workspaceId: string, agentId: string, title?: string) {
    return (
      await this.request('thread.create', {
        workspaceId,
        agentId,
        ...(title ? { title } : {}),
      })
    ).thread;
  }

  async createThreadDraft(
    workspaceId: string,
    agentId: string,
    title?: string,
  ) {
    return (
      await this.request('thread.draft.create', {
        workspaceId,
        agentId,
        ...(title ? { title } : {}),
      })
    ).thread;
  }

  async discardThreadDraft(threadId: string) {
    if (this.activeThread?.threadId === threadId) {
      this.acp?.close();
      this.acp = undefined;
      this.activeThread = undefined;
    }
    await this.request('thread.draft.discard', { threadId });
  }

  async addWorkspace(path: string, name?: string) {
    return (
      await this.request('workspace.add', {
        path,
        ...(name ? { name } : {}),
      })
    ).workspace;
  }

  async archiveThread(threadId: string) {
    const archived = (await this.request('thread.archive', { threadId }))
      .thread;
    if (this.activeThread?.threadId === threadId) {
      this.acp?.close();
      this.acp = undefined;
      this.activeThread = undefined;
    }
    return archived;
  }

  async restoreThread(threadId: string) {
    return (await this.request('thread.restore', { threadId })).thread;
  }

  listWorkspaceFiles(workspaceId: string, path: string) {
    return this.request('workspace.file.list', { workspaceId, path });
  }

  readWorkspaceFile(workspaceId: string, path: string) {
    return this.request('workspace.file.read', { workspaceId, path });
  }

  hashWorkspaceFile(workspaceId: string, path: string) {
    return this.request('workspace.file.hash', { workspaceId, path });
  }

  writeWorkspaceFile(
    workspaceId: string,
    path: string,
    content: string,
    expectedContentHash: string | null,
  ) {
    return this.request('workspace.file.write', {
      workspaceId,
      path,
      content,
      expectedContentHash,
    });
  }

  createWorkspaceDirectory(workspaceId: string, path: string) {
    return this.request('workspace.directory.create', { workspaceId, path });
  }

  moveWorkspaceFile(
    workspaceId: string,
    fromPath: string,
    toPath: string,
    overwrite?: boolean,
  ) {
    return this.request('workspace.file.move', {
      workspaceId,
      fromPath,
      toPath,
      ...(overwrite === undefined ? {} : { overwrite }),
    });
  }

  deleteWorkspaceFile(workspaceId: string, path: string, recursive?: boolean) {
    return this.request('workspace.file.delete', {
      workspaceId,
      path,
      ...(recursive === undefined ? {} : { recursive }),
    });
  }

  searchWorkspaceFiles(
    workspaceId: string,
    path: string,
    query: string,
    scope: 'path' | 'content' | 'both' = 'both',
    limit?: number,
  ) {
    return this.request('workspace.file.search', {
      workspaceId,
      path,
      query,
      scope,
      ...(limit === undefined ? {} : { limit }),
    });
  }

  async watchWorkspaceFiles(
    workspaceId: string,
    paths: string[],
    onEvent: (event: WorkspaceFileWatchEvent) => void,
  ) {
    const started = await this.request('workspace.file.watch.start', {
      workspaceId,
      paths,
    });
    this.workspaceFileWatchListeners.set(started.subscriptionId, onEvent);
    let closed = false;
    return {
      subscriptionId: started.subscriptionId,
      paths: started.paths,
      update: async (nextPaths: string[]) => {
        const updated = await this.request('workspace.file.watch.update', {
          subscriptionId: started.subscriptionId,
          paths: nextPaths,
        });
        return updated.paths;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        this.workspaceFileWatchListeners.delete(started.subscriptionId);
        await this.request('workspace.file.watch.stop', {
          subscriptionId: started.subscriptionId,
        }).catch(() => undefined);
      },
    };
  }

  async prompt(content: ContentBlock[]) {
    if (!this.acp || !this.activeThread)
      throw new Error('Attach to a Thread first.');
    await this.acp.prompt(content);
  }

  async cancelPrompt() {
    await this.acp?.cancel();
  }

  respondToPermission(requestId: string, optionId: string) {
    return (
      this.acp?.respondToPermission(requestId, {
        outcome: 'selected',
        optionId,
      }) ?? false
    );
  }

  respondToElicitation(requestId: string, response: CreateElicitationResponse) {
    return this.acp?.respondToElicitation(requestId, response) ?? false;
  }

  async setMode(modeId: string) {
    await this.acp?.setMode(modeId);
  }

  async setConfigOption(optionId: string, value: string | boolean) {
    await this.acp?.setConfigOption(optionId, value);
  }

  close() {
    this.workspaceFileWatchListeners.clear();
    this.acp?.close();
    this.rpc.close();
  }

  private handleNotification(method: string, params: unknown) {
    if (method !== WORKSPACE_FILE_WATCH_EVENT_METHOD) return;
    const notification = parseWorkspaceFileWatchNotification(method, params);
    this.workspaceFileWatchListeners.get(notification.subscriptionId)?.(
      notification.event,
    );
  }

  private async request<Method extends PortalRpcMethod>(
    method: Method,
    params: PortalRpcParams<Method>,
  ): Promise<PortalRpcResult<Method>> {
    return parsePortalRpcResult(method, await this.rpc.request(method, params));
  }
}
