import {
  type AgentSummary,
  type BrowserControlErrorCode,
  type BrowserControlInvokeParams,
  parseBrowserControlInvokeParams,
  type BrowserProviderLease,
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
  type WorkspaceSummary,
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
import {
  alphaBrowserSession,
  AlphaBrowserControlError,
  type AlphaBrowserSession,
} from "@/app/alpha-browser-session";

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

const browserClientIdentity = () => {
  const key = "weave.alpha.browser-client-id";
  const stored = globalThis.localStorage?.getItem(key);
  if (stored) return stored;
  const created = crypto.randomUUID();
  globalThis.localStorage?.setItem(key, created);
  return created;
};

const browserPlatform = (): "macOS" | "iPadOS" =>
  /iPad/i.test(globalThis.navigator?.userAgent ?? "") ? "iPadOS" : "macOS";

const browserControlFailure = (code: BrowserControlErrorCode, message: string) =>
  Object.assign(new Error(message), {
    data: { domain: "browser-control", code, retryable: code === "CANCELLED" },
  });

class JsonRpcWebSocket {
  private nextId = 0;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private opened: Promise<void>;
  private closedByClient = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly onNotification?: NotificationHandler,
    private readonly onUnexpectedClose?: (error: Error) => void,
    private readonly onRequest?: RequestHandler,
  ) {
    this.opened = new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () =>
        reject(
          new PortalTransportError("The Host WebSocket could not be opened."),
        );
    });
    socket.onmessage = (event) => void this.receive(String(event.data));
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
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        }),
      );
    });
  }

  close() {
    this.closedByClient = true;
    this.socket.close(1000, "Weave disconnected.");
  }

  private async receive(text: string) {
    const message = JSON.parse(text) as Record<string, unknown>;
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
  private readonly browserSession: AlphaBrowserSession;
  private readonly browserClientId: string;
  private browserLease?: BrowserProviderLease;
  private browserSync = Promise.resolve();
  private readonly browserRequests = new Map<string, AbortController>();
  private readonly stopBrowserSubscription: () => void;
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
    credential: PortalCredentialSigner,
    private readonly onAcpEvent: (event: AcpTranscriptEvent) => void,
    onUnexpectedClose?: (error: Error) => void,
    browserSession: AlphaBrowserSession = alphaBrowserSession(),
  ) {
    this.baseUrl = portalWebSocketUrl(hostUrl);
    this.WebSocket = authenticatedPortalWebSocket(credential);
    this.browserSession = browserSession;
    this.browserClientId = browserClientIdentity();
    this.rpc = new JsonRpcWebSocket(
      new this.WebSocket(this.baseUrl.toString()) as unknown as WebSocket,
      (method, params) => this.handleNotification(method, params),
      (error) => {
        this.browserSession.setAgentAccess('off');
        onUnexpectedClose?.(error);
      },
      (method, params) => this.handleBrowserRequest(method, params),
    );
    this.stopBrowserSubscription = this.browserSession.subscribe(() => this.queueBrowserSync());
  }

  async snapshot(): Promise<HostSnapshot> {
    const capabilities = await this.request("portal.capabilities", {});
    const supportsThreadLifecycle =
      capabilities.capabilities.includes("thread.archive") &&
      capabilities.capabilities.includes("thread.restore");
    const [workspaces, agents, threads, archivedThreads] = await Promise.all([
      this.request("workspace.list", {}),
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
      workspaces: workspaces.workspaces,
      agents: agents.agents,
      threads: threads.threads,
      archivedThreads: archivedThreads.threads,
    };
  }

  async attach(threadId: string) {
    const prepared = await this.request("thread.attach", { threadId });
    this.acp?.close();
    this.activeThread = prepared.thread;
    await this.syncBrowserProvider();
    this.onAcpEvent({
      type: "history/reset",
      sessionId: prepared.thread.acpSessionId,
    });
    const url = new URL(this.baseUrl);
    url.pathname = prepared.connection.path;
    url.searchParams.set("threadId", prepared.connection.threadId);
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
      await this.request("thread.create", {
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
      await this.request("thread.draft.create", {
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
      this.queueBrowserSync();
    }
    await this.request("thread.draft.discard", { threadId });
  }

  async addWorkspace(path: string, name?: string) {
    return (
      await this.request("workspace.add", {
        path,
        ...(name ? { name } : {}),
      })
    ).workspace;
  }

  async removeWorkspace(workspaceId: string) {
    await this.request("workspace.remove", { workspaceId });
  }

  async archiveThread(threadId: string) {
    const archived = (await this.request("thread.archive", { threadId }))
      .thread;
    if (this.activeThread?.threadId === threadId) {
      this.acp?.close();
      this.acp = undefined;
      this.activeThread = undefined;
      this.queueBrowserSync();
    }
    return archived;
  }

  async restoreThread(threadId: string) {
    return (await this.request("thread.restore", { threadId })).thread;
  }

  listWorkspaceFiles(workspaceId: string, path: string) {
    return this.request("workspace.file.list", { workspaceId, path });
  }

  readWorkspaceFile(workspaceId: string, path: string) {
    return this.request("workspace.file.read", { workspaceId, path });
  }

  hashWorkspaceFile(workspaceId: string, path: string) {
    return this.request("workspace.file.hash", { workspaceId, path });
  }

  writeWorkspaceFile(
    workspaceId: string,
    path: string,
    content: string,
    expectedContentHash: string | null,
  ) {
    return this.request("workspace.file.write", {
      workspaceId,
      path,
      content,
      expectedContentHash,
    });
  }

  createWorkspaceDirectory(workspaceId: string, path: string) {
    return this.request("workspace.directory.create", { workspaceId, path });
  }

  moveWorkspaceFile(
    workspaceId: string,
    fromPath: string,
    toPath: string,
    overwrite?: boolean,
  ) {
    return this.request("workspace.file.move", {
      workspaceId,
      fromPath,
      toPath,
      ...(overwrite === undefined ? {} : { overwrite }),
    });
  }

  deleteWorkspaceFile(workspaceId: string, path: string, recursive?: boolean) {
    return this.request("workspace.file.delete", {
      workspaceId,
      path,
      ...(recursive === undefined ? {} : { recursive }),
    });
  }

  searchWorkspaceFiles(
    workspaceId: string,
    path: string,
    query: string,
    scope: "path" | "content" | "both" = "both",
    limit?: number,
  ) {
    return this.request("workspace.file.search", {
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
    const started = await this.request("workspace.file.watch.start", {
      workspaceId,
      paths,
    });
    this.workspaceFileWatchListeners.set(started.subscriptionId, onEvent);
    let closed = false;
    return {
      subscriptionId: started.subscriptionId,
      paths: started.paths,
      update: async (nextPaths: string[]) => {
        const updated = await this.request("workspace.file.watch.update", {
          subscriptionId: started.subscriptionId,
          paths: nextPaths,
        });
        return updated.paths;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        this.workspaceFileWatchListeners.delete(started.subscriptionId);
        await this.request("workspace.file.watch.stop", {
          subscriptionId: started.subscriptionId,
        }).catch(() => undefined);
      },
    };
  }

  listTerminals(workspaceId: string) {
    return this.request("terminal.list", { workspaceId });
  }

  createTerminal(workspaceId: string, cols?: number, rows?: number) {
    return this.request("terminal.create", {
      workspaceId,
      ...(cols === undefined ? {} : { cols }),
      ...(rows === undefined ? {} : { rows }),
    });
  }

  snapshotTerminal(workspaceId: string, terminalId: string) {
    return this.request("terminal.snapshot", { workspaceId, terminalId });
  }

  async attachTerminal(
    workspaceId: string,
    terminalId: string,
    mode: TerminalAttachmentMode,
    onEvent: (event: TerminalNotification) => void,
  ) {
    const result = await this.request("terminal.attach", {
      workspaceId,
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
            workspaceId: result.snapshot.terminal.workspaceId,
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

  inputTerminal(
    workspaceId: string,
    terminalId: string,
    attachmentId: string,
    data: string,
  ) {
    return this.request("terminal.input", {
      workspaceId,
      terminalId,
      attachmentId,
      data,
    });
  }

  resizeTerminal(
    workspaceId: string,
    terminalId: string,
    attachmentId: string,
    cols: number,
    rows: number,
  ) {
    return this.request("terminal.resize", {
      workspaceId,
      terminalId,
      attachmentId,
      cols,
      rows,
    });
  }

  async detachTerminal(
    workspaceId: string,
    terminalId: string,
    attachmentId: string,
  ) {
    this.terminalListeners.delete(attachmentId);
    this.pendingTerminalNotifications.delete(attachmentId);
    this.overflowedTerminalAttachments.delete(attachmentId);
    return await this.request("terminal.detach", {
      workspaceId,
      terminalId,
      attachmentId,
    });
  }

  async closeTerminal(
    workspaceId: string,
    terminalId: string,
    attachmentId: string,
  ) {
    const result = await this.request("terminal.close", {
      workspaceId,
      terminalId,
      attachmentId,
    });
    this.terminalListeners.delete(attachmentId);
    this.pendingTerminalNotifications.delete(attachmentId);
    this.overflowedTerminalAttachments.delete(attachmentId);
    return result;
  }

  async prompt(content: ContentBlock[]) {
    if (!this.acp || !this.activeThread) {
      throw new Error("Attach to a Thread first.");
    }
    await this.acp.prompt(content);
  }

  async cancelPrompt() {
    await this.acp?.cancel();
  }

  respondToPermission(requestId: string, optionId: string) {
    return (
      this.acp?.respondToPermission(requestId, {
        outcome: "selected",
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
    this.browserSession.setAgentAccess('off');
    this.stopBrowserSubscription();
    for (const request of this.browserRequests.values()) request.abort();
    this.browserRequests.clear();
    this.workspaceFileWatchListeners.clear();
    this.terminalListeners.clear();
    this.pendingTerminalNotifications.clear();
    this.overflowedTerminalAttachments.clear();
    this.pendingTerminalNotifications.clear();
    this.acp?.close();
    this.rpc.close();
  }

  private queueBrowserSync() {
    this.browserSync = this.browserSync
      .then(() => this.syncBrowserProvider())
      .catch(() => this.browserSession.setAgentAccess('off'));
  }

  private async syncBrowserProvider() {
    const state = this.browserSession.getSnapshot();
    const thread = this.activeThread;
    const attachable = Boolean(
      thread && state.supported && state.visible && state.agentAccess !== 'off' &&
        state.tabId && state.generation && state.controlRevision !== undefined,
    );
    if (
      this.browserLease &&
      (!attachable || this.browserLease.address.threadId !== thread?.threadId ||
        this.browserLease.address.tabId !== state.tabId ||
        this.browserLease.generation !== state.generation)
    ) {
      const leaseId = this.browserLease.leaseId;
      this.browserLease = undefined;
      await this.request("browser.provider.detach", { leaseId }).catch(() => undefined);
    }
    if (!attachable || this.browserLease || !thread) return;
    this.browserLease = await this.request("browser.provider.attach", {
      threadId: thread.threadId,
      offer: {
        version: 1,
        clientId: this.browserClientId,
        tabId: state.tabId!,
        generation: state.generation!,
        controlRevision: state.controlRevision!,
        platform: browserPlatform(),
        operations: ["see", "act"],
        authorization: {
          observe: true,
          control: state.agentAccess === 'control',
        },
        limits: {
          maxResultBytes: 2 * 1024 * 1024,
          maxScreenshotBytes: 1_500_000,
          maxElements: 200,
          maxDurationMs: 30_000,
        },
      },
    });
  }

  private async handleBrowserRequest(method: string, value: unknown) {
    if (method !== "browser.control.execute") {
      throw new Error(`Method not supported by Weave: ${method}`);
    }
    const request = parseBrowserControlInvokeParams(value);
    const lease = this.browserLease;
    const state = this.browserSession.getSnapshot();
    if (
      !lease || request.leaseId !== lease.leaseId ||
      request.address.hostId !== lease.address.hostId ||
      request.address.threadId !== lease.address.threadId ||
      request.address.clientId !== lease.address.clientId ||
      request.address.tabId !== lease.address.tabId ||
      request.generation !== lease.generation || !state.agentControlEnabled ||
      !state.visible
    ) {
      throw browserControlFailure(
        "LEASE_REVOKED",
        "Browser control is not attached to this visible session.",
      );
    }
    const controller = new AbortController();
    this.browserRequests.set(request.requestId, controller);
    try {
      return await this.browserSession.execute(request, controller.signal);
    } catch (cause) {
      throw browserControlFailure(
        controller.signal.aborted
          ? "CANCELLED"
          : cause instanceof AlphaBrowserControlError
          ? cause.code
          : "CONTROL_INTERRUPTED",
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      this.browserRequests.delete(request.requestId);
    }
  }

  private handleNotification(method: string, params: unknown) {
    if (method === "browser.control.cancel") {
      const requestId = (params as { requestId?: unknown } | undefined)?.requestId;
      if (typeof requestId === "string") this.browserRequests.get(requestId)?.abort();
      return;
    }
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

  private async request<Method extends PortalRpcMethod>(
    method: Method,
    params: PortalRpcParams<Method>,
  ): Promise<PortalRpcResult<Method>> {
    return parsePortalRpcResult(method, await this.rpc.request(method, params));
  }
}
