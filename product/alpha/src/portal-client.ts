import { type BrowserPageRpcMethod, type BrowserPaneRpcMethod, type BrowserProfileRpcMethod, parsePortalAuthChallenge, parsePortalAuthenticated, portalAuthChallengePayload, PORTAL_BROWSER_RFB_PATH, PORTAL_AUTH_RESPONSE_TYPE } from '@weave/product-protocol';
import { encodeHostMessage, decodeHostMessage } from '@weave/product-protocol';
import {
  type AgentSummary,
  parsePortalRpcResult,
  parseTerminalErrorData,
  parseTerminalNotification,
  parseWorkspaceFileErrorData,
  parseWorkspaceFileWatchNotification,
  type PortalRpcMethod,
  type PortalRpcParams,
  type PortalRpcResult,
  TERMINAL_EVENT_METHOD,
  type TerminalAttachmentMode,
  type TerminalNotification,
  type ThreadSummary,
  WORKSPACE_FILE_WATCH_EVENT_METHOD,
  type WorkspaceFileErrorData,
  type WorkspaceFileWatchEvent,
  type ExecutionContextSummary,
  type Workspace,
} from "@weave/product-protocol";
import type {
  ContentBlock,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import { AcpSessionClient } from "@/chat/acp-client";
import type { AcpTranscriptEvent } from "@/chat/acp-transcript";
import { portalWebSocketUrl } from "@/portal-address";
import { authenticatedPortalWebSocket } from "@/portal-authenticated-websocket";
import type { PortalCredentialSigner } from "@/portal-credential";

type JsonRpcId = number;
type PendingRequest = {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
};
type NotificationHandler = (method: string, params: unknown) => void;
type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

export class PortalRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: WorkspaceFileErrorData | unknown,
  ) {
    super(message);
    this.name = "PortalRpcError";
  }
}

export class PortalTransportError extends Error {
  constructor(
    message: string,
    readonly closeCode?: number,
  ) {
    super(message);
    this.name = "PortalTransportError";
  }
}

class JsonRpcWebSocket {
  private nextId = 0;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private opened: Promise<void>;
  private closedByClient = false;
  private transportError?: PortalTransportError;
  private rejectOpened!: (error: Error) => void;

  constructor(
    private readonly socket: WebSocket,
    private readonly onNotification?: NotificationHandler,
    private readonly onUnexpectedClose?: (error: Error) => void,
    private readonly onRequest?: RequestHandler,
  ) {
    this.opened = new Promise<void>((resolve, reject) => {
      this.rejectOpened = reject;
      socket.onopen = () => resolve();
      socket.onerror = () =>
        reject(
          new PortalTransportError("The Host WebSocket could not be opened."),
        );
    });
    // Closing before the first request must not leave an unhandled rejection.
    void this.opened.catch(() => undefined);
    socket.onmessage = (event) => { void this.receive(event.data).catch(() => {
      const error = new PortalTransportError('The Host sent an invalid frame.');
      this.rejectTransport(error); this.socket.close(1002, error.message);
      if (!this.closedByClient) this.onUnexpectedClose?.(error);
    }); };
    socket.onclose = (event) => {
      const error = new PortalTransportError(
        event.reason || `The Host WebSocket closed (${event.code}).`,
        event.code,
      );
      this.rejectTransport(error);
      if (!this.closedByClient) this.onUnexpectedClose?.(error);
    };
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.transportError) throw this.transportError;
    await this.opened;
    // A close may arrive while this request is waiting for authentication.
    if (this.transportError) throw this.transportError;
    if (this.pending.size >= 1024 || this.socket.bufferedAmount > 2 * 1024 * 1024) throw new PortalTransportError('Terminal input queue is full; input was not sent.');
    const id = ++this.nextId;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      try {
        this.socket.send(encodeHostMessage({
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        }));
      } catch (cause) {
        this.pending.delete(id);
        reject(new PortalTransportError(cause instanceof Error ? cause.message : 'The Host WebSocket could not send the request.'));
      }
    });
  }

  close() {
    this.closedByClient = true;
    // Browser close events are asynchronous. Release queues immediately so a
    // new client never waits on cleanup through this retired connection.
    this.rejectTransport(new PortalTransportError('Weave disconnected.'));
    this.socket.close(1000, "Weave disconnected.");
  }

  private rejectTransport(error: PortalTransportError) {
    this.transportError ??= error;
    this.rejectOpened(this.transportError);
    for (const request of this.pending.values()) request.reject(this.transportError);
    this.pending.clear();
  }

  private async receive(text: string | ArrayBuffer) {
    const message = decodeHostMessage(text) as Record<string, unknown>;
    if (typeof message.method === "string") {
      if (typeof message.id === "number" || typeof message.id === "string") {
        try {
          if (!this.onRequest) throw new Error(`Method not supported by Weave: ${message.method}`);
          const value = await this.onRequest(message.method, message.params);
          this.socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value }));
        } catch (cause) {
          const typed = cause as Error & { data?: unknown };
          this.socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32013,
              message: typed instanceof Error ? typed.message : String(cause),
              ...(typed?.data === undefined ? {} : { data: typed.data }),
            },
          }));
        }
      } else {
        this.onNotification?.(message.method, message.params);
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error && typeof message.error === "object") {
      const error = message.error as {
        code?: unknown;
        message?: unknown;
        data?: unknown;
      };
      let data = error.data;
      try {
        if (
          (data as { domain?: unknown } | undefined)?.domain ===
          "workspace-filesystem"
        ) {
          data = parseWorkspaceFileErrorData(data);
        } else if (
          (data as { domain?: unknown } | undefined)?.domain === "terminal"
        ) {
          data = parseTerminalErrorData(data);
        }
      } catch {
        // Preserve malformed remote error data as opaque evidence.
      }
      pending.reject(
        new PortalRpcError(
          typeof error.code === "number" ? error.code : -32000,
          typeof error.message === "string"
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
  executionContexts: ExecutionContextSummary[];
  agents: AgentSummary[];
  threads: ThreadSummary[];
  archivedThreads: ThreadSummary[];
};

export class DirectHostClient {
  private readonly baseUrl: URL;
  private readonly WebSocket: ReturnType<typeof authenticatedPortalWebSocket>;
  private rpc: JsonRpcWebSocket;
  private sessions = new Map<string, { acp: AcpSessionClient; thread: ThreadSummary }>();
  private attaching = new Map<string, Promise<ThreadSummary>>();
  private closed = false;
  private connectingSessions = new Map<string, { token: symbol; acp?: AcpSessionClient }>();
  private activeThread?: ThreadSummary;
  private readonly workspaceFileWatchListeners = new Map<
    string,
    (event: WorkspaceFileWatchEvent) => void
  >();
  private readonly terminalListeners = new Map<
    string,
    {
      generation: string;
      cursor: number;
      onEvent: (event: TerminalNotification) => void;
    }
  >();
  private readonly pendingTerminalNotifications = new Map<
    string,
    TerminalNotification[]
  >();
  private readonly overflowedTerminalAttachments = new Set<string>();

  constructor(
    hostUrl: string,
    private readonly credential: PortalCredentialSigner,
    private readonly onAcpEvent: (event: AcpTranscriptEvent, threadId?: string) => void,
    onUnexpectedClose?: (error: Error) => void,
  ) {
    this.baseUrl = portalWebSocketUrl(hostUrl);
    this.WebSocket = authenticatedPortalWebSocket(credential);
    this.rpc = new JsonRpcWebSocket(
      new this.WebSocket(this.baseUrl.toString()) as unknown as WebSocket,
      (method, params) => this.handleNotification(method, params),
      (error) => {
        onUnexpectedClose?.(error);
      },
    );
  }

  async snapshot(): Promise<HostSnapshot> {
    const capabilities = await this.request("portal.capabilities", {});
    const supportsThreadLifecycle =
      capabilities.capabilities.includes("thread.archive") &&
      capabilities.capabilities.includes("thread.restore");
    const [executionContexts, agents, threads, archivedThreads] = await Promise.all([
      this.request("context.list", {}),
      this.request("agent.list", {}),
      this.request("thread.list", { status: "active" }),
      supportsThreadLifecycle
        ? this.request("thread.list", { status: "archived" })
        : Promise.resolve({ threads: [] }),
    ]);
    return {
      hostId: capabilities.hostId,
      displayName: capabilities.displayName,
      capabilities: capabilities.capabilities,
      executionContexts: executionContexts.executionContexts,
      agents: agents.agents,
      threads: threads.threads,
      archivedThreads: archivedThreads.threads,
    };
  }

  async attach(threadId: string) {
    if (this.closed) throw new Error('Host connection is closed.');
    const existing = this.sessions.get(threadId);
    if (existing) { this.activeThread = existing.thread; return existing.thread; }
    const pending = this.attaching.get(threadId);
    if (pending) return pending;
    const token = Symbol(threadId);
    this.connectingSessions.set(threadId, { token });
    const operation = this.attachSession(threadId, token);
    this.attaching.set(threadId, operation);
    try { return await operation; }
    finally { if (this.attaching.get(threadId) === operation) this.attaching.delete(threadId); }
  }

  private async attachSession(threadId: string, token: symbol) {
    const prepared = await this.request("thread.attach", { threadId });
    if (this.closed || this.connectingSessions.get(threadId)?.token !== token) throw new Error('Thread attachment was closed.');
    this.onAcpEvent({ type: "history/reset", sessionId: prepared.thread.acpSessionId }, threadId);
    const url = new URL(this.baseUrl);
    url.pathname = prepared.connection.path;
    url.searchParams.set("threadId", prepared.connection.threadId);
    const acp = new AcpSessionClient({ url: url.toString(), WebSocket: this.WebSocket,
      onEvent: (event) => { if (!this.closed) this.onAcpEvent(event, threadId); },
      onClose: () => { if (this.sessions.get(threadId)?.acp === acp) this.sessions.delete(threadId); },
    });
    this.connectingSessions.set(threadId, { token, acp });
    try {
      await acp.initializeAndLoad({ sessionId: prepared.thread.acpSessionId, cwd: prepared.connection.cwd });
      if (this.closed || this.connectingSessions.get(threadId)?.token !== token) throw new Error('Thread attachment was closed.');
      this.sessions.set(threadId, { acp, thread: prepared.thread });
      this.activeThread = prepared.thread;
      return prepared.thread;
    } catch (error) { acp.close(); throw error; }
    finally { if (this.connectingSessions.get(threadId)?.token === token) this.connectingSessions.delete(threadId); }
  }

  private session(threadId = this.activeThread?.threadId) {
    const session = threadId && this.sessions.get(threadId);
    if (!session) throw new Error('Attach to this Thread first.');
    return session.acp;
  }

  private closeSession(threadId: string) {
    this.attaching.delete(threadId);
    this.connectingSessions.get(threadId)?.acp?.close();
    this.connectingSessions.delete(threadId);
    this.sessions.get(threadId)?.acp.close();
    this.sessions.delete(threadId);
    if (this.activeThread?.threadId === threadId) this.activeThread = undefined;
  }

  async createThread(executionContextId: string, agentId: string, title?: string, workspaceId?: string) {
    return (
      await this.request("thread.create", {
        executionContextId,
        workspaceId,
        agentId,
        ...(title ? { title } : {}),
      })
    ).thread;
  }

  async createThreadDraft(
    executionContextId: string,
    agentId: string,
    title?: string,
    workspaceId?: string,
  ) {
    return (
      await this.request("thread.draft.create", {
        executionContextId,
        workspaceId,
        agentId,
        ...(title ? { title } : {}),
      })
    ).thread;
  }

  async discardThreadDraft(threadId: string) {
    this.closeSession(threadId);
    await this.request("thread.draft.discard", { threadId });
  }

  async addWorkspace(path: string, name?: string) {
    return (
      await this.request("context.add", {
        path,
        ...(name ? { name } : {}),
      })
    ).workspace;
  }

  async removeWorkspace(executionContextId: string) {
    await this.request("context.remove", { executionContextId });
  }

  async assignThread(threadId: string, hostId: string, workspaceId: string, expectedRevision: number) {
    return (await this.request('thread.assign', { threadId, hostId, workspaceId, expectedRevision })).thread;
  }

  async archiveThread(threadId: string, stopActive = false) {
    const archived = (await this.request("thread.archive", { threadId, stopActive }))
      .thread;
    this.closeSession(threadId);
    return archived;
  }

  async restoreThread(threadId: string) {
    return (await this.request("thread.restore", { threadId })).thread;
  }

  listWorkspaceFiles(executionContextId: string, path: string) {
    return this.request("context.file.list", { executionContextId, path });
  }

  readWorkspaceFile(executionContextId: string, path: string) {
    return this.request("context.file.read", { executionContextId, path });
  }

  hashWorkspaceFile(executionContextId: string, path: string) {
    return this.request("context.file.hash", { executionContextId, path });
  }

  writeWorkspaceFile(
    executionContextId: string,
    path: string,
    content: string,
    expectedContentHash: string | null,
  ) {
    return this.request("context.file.write", {
      executionContextId,
      path,
      content,
      expectedContentHash,
    });
  }

  createWorkspaceDirectory(executionContextId: string, path: string) {
    return this.request("context.directory.create", { executionContextId, path });
  }

  moveWorkspaceFile(
    executionContextId: string,
    fromPath: string,
    toPath: string,
    overwrite?: boolean,
  ) {
    return this.request("context.file.move", {
      executionContextId,
      fromPath,
      toPath,
      ...(overwrite === undefined ? {} : { overwrite }),
    });
  }

  deleteWorkspaceFile(executionContextId: string, path: string, recursive?: boolean) {
    return this.request("context.file.delete", {
      executionContextId,
      path,
      ...(recursive === undefined ? {} : { recursive }),
    });
  }

  searchWorkspaceFiles(
    executionContextId: string,
    path: string,
    query: string,
    scope: "path" | "content" | "both" = "both",
    limit?: number,
  ) {
    return this.request("context.file.search", {
      executionContextId,
      path,
      query,
      scope,
      ...(limit === undefined ? {} : { limit }),
    });
  }

  async watchWorkspaceFiles(
    executionContextId: string,
    paths: string[],
    onEvent: (event: WorkspaceFileWatchEvent) => void,
  ) {
    const started = await this.request("context.file.watch.start", {
      executionContextId,
      paths,
    });
    this.workspaceFileWatchListeners.set(started.subscriptionId, onEvent);
    let closed = false;
    return {
      subscriptionId: started.subscriptionId,
      paths: started.paths,
      update: async (nextPaths: string[]) => {
        const updated = await this.request("context.file.watch.update", {
          subscriptionId: started.subscriptionId,
          paths: nextPaths,
        });
        return updated.paths;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        this.workspaceFileWatchListeners.delete(started.subscriptionId);
        await this.request("context.file.watch.stop", {
          subscriptionId: started.subscriptionId,
        }).catch(() => undefined);
      },
    };
  }

  previewWorkspaceClose(hostId: string, workspaceId: string) {
    return this.request('workspace.close.preview', { hostId, workspaceId });
  }

  closeWorkspace(hostId: string, workspaceId: string, token: string, confirmed: boolean) {
    return this.request('workspace.close', { hostId, workspaceId, token, confirmed });
  }

  getWorkspaceComposition(hostId: string) {
    return this.request("workspace.composition.get", { hostId });
  }

  replaceWorkspaceComposition(hostId: string, expectedRevision: number, workspaces: Workspace[]) {
    return this.request("workspace.composition.replace", { hostId, expectedRevision, workspaces });
  }

  listTerminals(executionContextId: string) {
    return this.request("terminal.list", { executionContextId });
  }

  createTerminal(executionContextId: string, cols?: number, rows?: number) {
    return this.request("terminal.create", {
      executionContextId,
      ...(cols === undefined ? {} : { cols }),
      ...(rows === undefined ? {} : { rows }),
    });
  }

  snapshotTerminal(executionContextId: string, terminalId: string) {
    return this.request("terminal.snapshot", { executionContextId, terminalId });
  }

  async attachTerminal(
    executionContextId: string,
    terminalId: string,
    mode: TerminalAttachmentMode,
    onEvent: (event: TerminalNotification) => void,
  ) {
    const result = await this.request("terminal.attach", {
      executionContextId,
      terminalId,
      mode,
    });
    let started = false;
    return {
      ...result,
      startEvents: () => {
        if (started) return;
        started = true;
        this.terminalListeners.set(result.attachment.attachmentId, {
          generation: result.snapshot.generation,
          cursor: result.snapshot.cursor,
          onEvent,
        });
        if (
          this.overflowedTerminalAttachments.delete(
            result.attachment.attachmentId,
          )
        ) {
          this.pendingTerminalNotifications.delete(
            result.attachment.attachmentId,
          );
          onEvent({
            attachmentId: result.attachment.attachmentId,
            terminalId: result.snapshot.terminal.terminalId,
            executionContextId: result.snapshot.terminal.executionContextId,
            generation: result.snapshot.generation,
            sequence: result.snapshot.cursor + 1,
            event: {
              type: "resync",
              retainedFrom: result.snapshot.retainedFrom,
            },
          });
          return;
        }
        const pending =
          this.pendingTerminalNotifications.get(
            result.attachment.attachmentId,
          ) ?? [];
        this.pendingTerminalNotifications.delete(
          result.attachment.attachmentId,
        );
        for (const notification of pending) {
          this.dispatchTerminalNotification(notification);
        }
      },
    };
  }

  historyTerminal(executionContextId: string, terminalId: string, attachmentId: string, token: string, page: number) {
    return this.request('terminal.history', { executionContextId, terminalId, attachmentId, token, page });
  }

  inputTerminal(
    executionContextId: string,
    terminalId: string,
    attachmentId: string,
    data: string | Uint8Array,
  ) {
    return this.request("terminal.input", {
      executionContextId,
      terminalId,
      attachmentId,
      data: typeof data === 'string' ? new TextEncoder().encode(data) : data,
    });
  }

  resizeTerminal(
    executionContextId: string,
    terminalId: string,
    attachmentId: string,
    cols: number,
    rows: number,
  ) {
    return this.request("terminal.resize", {
      executionContextId,
      terminalId,
      attachmentId,
      cols,
      rows,
    });
  }

  async detachTerminal(
    executionContextId: string,
    terminalId: string,
    attachmentId: string,
  ) {
    this.terminalListeners.delete(attachmentId);
    this.pendingTerminalNotifications.delete(attachmentId);
    this.overflowedTerminalAttachments.delete(attachmentId);
    return await this.request("terminal.detach", {
      executionContextId,
      terminalId,
      attachmentId,
    });
  }

  async closeTerminal(
    executionContextId: string,
    terminalId: string,
    attachmentId: string,
  ) {
    const result = await this.request("terminal.close", {
      executionContextId,
      terminalId,
      attachmentId,
    });
    this.terminalListeners.delete(attachmentId);
    this.pendingTerminalNotifications.delete(attachmentId);
    this.overflowedTerminalAttachments.delete(attachmentId);
    return result;
  }

  async prompt(content: ContentBlock[], threadId?: string) { await this.session(threadId).prompt(content); }
  async cancelPrompt(threadId?: string) { await this.session(threadId).cancel(); }
  respondToPermission(requestId: string, optionId: string, threadId?: string) {
    return this.session(threadId).respondToPermission(requestId, { outcome: "selected", optionId });
  }
  respondToElicitation(requestId: string, response: CreateElicitationResponse, threadId?: string) {
    return this.session(threadId).respondToElicitation(requestId, response);
  }
  async setMode(modeId: string, threadId?: string) { await this.session(threadId).setMode(modeId); }
  async setConfigOption(optionId: string, value: string | boolean, threadId?: string) {
    await this.session(threadId).setConfigOption(optionId, value);
  }

  close() {
    this.workspaceFileWatchListeners.clear();
    this.terminalListeners.clear();
    this.pendingTerminalNotifications.clear();
    this.overflowedTerminalAttachments.clear();
    this.pendingTerminalNotifications.clear();
    this.closed = true;
    this.attaching.clear();
    for (const { acp } of this.connectingSessions.values()) acp?.close();
    this.connectingSessions.clear();
    for (const { acp } of this.sessions.values()) acp.close();
    this.sessions.clear();
    this.rpc.close();
  }

  private handleNotification(method: string, params: unknown) {
    if (method === WORKSPACE_FILE_WATCH_EVENT_METHOD) {
      const notification = parseWorkspaceFileWatchNotification(method, params);
      this.workspaceFileWatchListeners.get(notification.subscriptionId)?.(
        notification.event,
      );
      return;
    }
    if (method === TERMINAL_EVENT_METHOD) {
      this.dispatchTerminalNotification(
        parseTerminalNotification(method, params),
      );
    }
  }

  private dispatchTerminalNotification(notification: TerminalNotification) {
    const listener = this.terminalListeners.get(notification.attachmentId);
    if (!listener) {
      if (this.overflowedTerminalAttachments.has(notification.attachmentId))
        return;
      const pending =
        this.pendingTerminalNotifications.get(notification.attachmentId) ?? [];
      pending.push(notification);
      if (pending.length > 256) {
        this.pendingTerminalNotifications.delete(notification.attachmentId);
        this.overflowedTerminalAttachments.add(notification.attachmentId);
      } else {
        this.pendingTerminalNotifications.set(
          notification.attachmentId,
          pending,
        );
      }
      return;
    }
    if (notification.sequence <= listener.cursor) return;
    if (
      notification.generation !== listener.generation ||
      notification.sequence !== listener.cursor + 1
    ) {
      this.terminalListeners.delete(notification.attachmentId);
      listener.onEvent({
        ...notification,
        event: { type: "resync", retainedFrom: notification.sequence },
      });
      return;
    }
    listener.cursor = notification.sequence;
    listener.onEvent(notification);
  }

  browserRequest<M extends BrowserPageRpcMethod | BrowserPaneRpcMethod | BrowserProfileRpcMethod>(method: M, params: PortalRpcParams<M>): Promise<PortalRpcResult<M>> {
    return this.request(method, params);
  }

  browserDisplay() {
    const url = new URL(this.baseUrl); url.pathname = PORTAL_BROWSER_RFB_PATH; url.search = ''; url.hash = '';
    return {
      url: url.toString(),
      authorize: async (value: unknown) => {
        const challenge = parsePortalAuthChallenge(value);
        if (challenge.hostId !== this.credential.hostId || challenge.audience !== PORTAL_BROWSER_RFB_PATH || Date.parse(challenge.expiresAt) <= Date.now()) throw new Error('Browser display identity does not match this Host');
        return { type: PORTAL_AUTH_RESPONSE_TYPE, credentialId: this.credential.credentialId, signature: await this.credential.sign(portalAuthChallengePayload(challenge)) };
      },
      authenticated: (value: unknown) => {
        if (parsePortalAuthenticated(value).principal.credentialId !== this.credential.credentialId) throw new Error('Browser authenticated a different credential');
      },
    };
  }

  private async request<Method extends PortalRpcMethod>(
    method: Method,
    params: PortalRpcParams<Method>,
  ): Promise<PortalRpcResult<Method>> {
    return parsePortalRpcResult(method, await this.rpc.request(method, params));
  }
}
