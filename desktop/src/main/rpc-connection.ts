import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import {
  parseDesktopRpcNotificationEnvelope,
  parseDesktopRpcNotifyEnvelope,
  parseDesktopRpcRequestEnvelope,
  parseDesktopRpcResponseEnvelope,
  parseDesktopRpcReverseRequestEnvelope,
  parseDesktopRpcReverseResponseEnvelope,
  RpcConnection,
  type RpcConnectionState,
  type RpcNotificationMethod,
  type RpcNotificationData,
  type RpcNotificationParams,
  type RpcRequestArguments,
  type RpcRequestMethod,
  type RpcRequestParams,
  type RpcRequestParsedParams,
  type RpcRequestResult,
  RpcRemoteError,
  WEAVE_RPC_PROTOCOL_VERSION,
} from '@weave/protocol';
import type { ConnectionSettingsStore } from './settings-store';

type EditorContextResult = RpcRequestResult<'server', 'client', 'client.editorContext.get'>;

type ReversePending = {
  sender: WebContents;
  method: 'client.editorContext.get';
  resolve: (value: EditorContextResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RendererSurface = {
  sender: WebContents;
  surfaceId?: string;
  projectId?: string;
  workspaceId?: string;
  threadId?: string;
  active: boolean;
  updatedAt: number;
};

const clientInstanceId = `desktop_${crypto.randomUUID()}`;

export class DesktopRpcConnection {
  private connection: RpcConnection;
  private readonly reversePending = new Map<string, ReversePending>();
  private readonly rendererSurfaces = new Map<number, RendererSurface>();
  private readonly rendererRequests = new Map<string, AbortController>();
  private readonly stateHandlers = new Set<(state: RpcConnectionState) => void>();
  private readonly notificationHandlers = new Map<
    string,
    Set<(params: unknown, method: string) => void | Promise<void>>
  >();

  constructor(private readonly settingsStore: ConnectionSettingsStore) {
    this.connection = this.createConnection();
    this.registerIpc();
  }

  get state(): RpcConnectionState {
    return this.connection.state;
  }

  onState(handler: (state: RpcConnectionState) => void) {
    this.stateHandlers.add(handler);
    handler(this.state);
    return () => this.stateHandlers.delete(handler);
  }

  onNotification<Method extends RpcNotificationMethod<'server', 'client'>>(
    method: Method,
    handler: (
      params: RpcNotificationData<'server', 'client', Method>,
      method: Method,
    ) => void | Promise<void>,
  ) {
    const handlers = this.notificationHandlers.get(method) ??
      new Set<(params: unknown, method: string) => void | Promise<void>>();
    const rawHandler = handler as unknown as (params: unknown, method: string) => void | Promise<void>;
    handlers.add(rawHandler);
    this.notificationHandlers.set(method, handlers);
    return () => {
      handlers.delete(rawHandler);
      if (handlers.size === 0) this.notificationHandlers.delete(method);
    };
  }

  async request<Method extends RpcRequestMethod<'client', 'server'>>(
    method: Method,
    ...args: RpcRequestArguments<'client', 'server', Method>
  ): Promise<RpcRequestResult<'client', 'server', Method>> {
    return await this.connection.request(method, ...args);
  }

  async notify<Method extends RpcNotificationMethod<'client', 'server'>>(
    method: Method,
    params: RpcNotificationParams<'client', 'server', Method>,
  ) {
    await this.connection.connect();
    this.connection.notify(method, params);
  }

  reconnect() {
    this.connection.close('Desktop RPC settings changed.');
    this.connection = this.createConnection();
  }

  dispose() {
    this.connection.close('Desktop is shutting down.');
    for (const pending of this.reversePending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Desktop is shutting down.'));
    }
    this.reversePending.clear();
    this.rendererSurfaces.clear();
    this.stateHandlers.clear();
    this.notificationHandlers.clear();
    for (const controller of this.rendererRequests.values()) controller.abort(new Error('Desktop is shutting down.'));
    this.rendererRequests.clear();
  }

  private createConnection() {
    const connection = new RpcConnection({
      serverUrl: this.settingsStore.getSettings().mastraUrl,
      initialize: () => {
        const token = this.settingsStore.getAuthToken();
        if (!token) throw new Error('Authentication token is required.');
        return {
          protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
          role: 'client',
          token,
          capabilities: ['client.editorContext.get'],
          client: {
            clientAppId: 'weave',
            clientInstanceId,
            name: 'Weave Desktop',
            version: process.env.npm_package_version ?? '0.1.0',
            active: true,
          },
        };
      },
    });
    connection.onAnyNotification(async (params, method) => {
      for (const handler of this.notificationHandlers.get(method) ?? []) {
        try {
          await handler(params, method);
        } catch (error) {
          console.warn(`[rpc] Desktop notification handler failed: ${method}`, error);
        }
      }
      const notification = parseDesktopRpcNotificationEnvelope({ kind: 'notification', method, params });
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed()) window.webContents.send('rpc:notification', notification);
      }
    });
    connection.onState((state) => {
      for (const handler of this.stateHandlers) handler(state);
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed()) window.webContents.send('rpc:connection-state', state);
      }
    });
    connection.register(
      'client.editorContext.get',
      (params, context) => this.forwardReverseRequest('client.editorContext.get', params, context.signal),
    );
    return connection;
  }

  private registerIpc() {
    ipcMain.handle('rpc:request', async (event, input: unknown) => {
      const request = parseDesktopRpcRequestEnvelope(input);
      if (request.method === 'client.surface.update') this.updateRendererSurface(event.sender, request.params);
      const key = `${event.sender.id}:${request.requestId}`;
      const controller = new AbortController();
      this.rendererRequests.set(key, controller);
      try {
        const result = await this.connection.request(
          request.method,
          request.params as never,
          { signal: controller.signal, timeoutMs: request.options?.timeoutMs },
        );
        return parseDesktopRpcResponseEnvelope({
          kind: 'success',
          requestId: request.requestId,
          method: request.method,
          result,
        }, request.method);
      } catch (error) {
        const remote = error instanceof RpcRemoteError ? error : undefined;
        return parseDesktopRpcResponseEnvelope({
          kind: 'error',
          requestId: request.requestId,
          method: request.method,
          error: {
            code: remote?.code ?? -32603,
            message: remote?.message ?? 'Internal error.',
            ...(remote?.data === undefined ? {} : { data: remote.data }),
          },
        }, request.method);
      } finally {
        this.rendererRequests.delete(key);
      }
    });
    ipcMain.on('rpc:request-cancel', (event, requestId: unknown) => {
      if (typeof requestId !== 'string') return;
      this.rendererRequests.get(`${event.sender.id}:${requestId}`)?.abort(new DOMException('Aborted', 'AbortError'));
    });
    ipcMain.handle('rpc:notify', (_event, input: unknown) => {
      const notification = parseDesktopRpcNotifyEnvelope(input);
      return this.connection.notify(notification.method, notification.params as never);
    });
    ipcMain.handle(
      'rpc:reverse-response',
      (event, input: unknown) => {
        const requestId = input && typeof input === 'object' && 'requestId' in input
          ? (input as { requestId?: unknown }).requestId
          : undefined;
        if (typeof requestId !== 'string') return;
        const pending = this.reversePending.get(requestId);
        if (!pending || pending.sender.id !== event.sender.id) return;
        const response = parseDesktopRpcReverseResponseEnvelope(input, pending.method);
        this.reversePending.delete(requestId);
        clearTimeout(pending.timer);
        if (response.kind === 'reverse-error') pending.reject(new Error(response.error.message));
        else pending.resolve(response.result);
      },
    );
  }

  private updateRendererSurface(sender: WebContents, params: unknown) {
    const record = params && typeof params === 'object' && !Array.isArray(params)
      ? params as Record<string, unknown>
      : {};
    const stringValue = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
    this.rendererSurfaces.set(sender.id, {
      sender,
      surfaceId: stringValue(record.surfaceId),
      projectId: stringValue(record.projectId),
      workspaceId: stringValue(record.workspaceId),
      threadId: stringValue(record.threadId),
      active: record.active !== false,
      updatedAt: Date.now(),
    });
    sender.once('destroyed', () => this.rendererSurfaces.delete(sender.id));
  }

  private selectRendererSurface(params: unknown) {
    const record = params && typeof params === 'object' && !Array.isArray(params)
      ? params as Record<string, unknown>
      : {};
    const requestedProject = typeof record.projectId === 'string' ? record.projectId : undefined;
    const requestedWorkspace = typeof record.workspaceId === 'string' ? record.workspaceId : undefined;
    const requestedThread = typeof record.threadId === 'string' ? record.threadId : undefined;
    const candidates = [...this.rendererSurfaces.values()]
      .filter((surface) => !surface.sender.isDestroyed())
      .filter((surface) => !requestedProject || surface.projectId === requestedProject)
      .filter((surface) => !requestedWorkspace || surface.workspaceId === requestedWorkspace)
      .sort((a, b) => {
        const aThread = requestedThread && a.threadId === requestedThread ? 1 : 0;
        const bThread = requestedThread && b.threadId === requestedThread ? 1 : 0;
        if (aThread !== bThread) return bThread - aThread;
        if (a.active !== b.active) return a.active ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });
    if (candidates[0]) return candidates[0].sender;
    const focused = BrowserWindow.getFocusedWindow()?.webContents;
    if (focused && !focused.isDestroyed()) return focused;
    return BrowserWindow.getAllWindows().find((window) => !window.webContents.isDestroyed())?.webContents;
  }

  private forwardReverseRequest(
    method: 'client.editorContext.get',
    params: RpcRequestParsedParams<'server', 'client', 'client.editorContext.get'>,
    signal: AbortSignal,
  ) {
    const target = this.selectRendererSurface(params);
    if (!target) throw new Error('No Desktop renderer is available.');
    const requestId = `reverse_${crypto.randomUUID()}`;
    return new Promise<EditorContextResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.reversePending.delete(requestId);
        reject(new Error(`Renderer RPC request timed out: ${method}`));
      }, 10_000);
      this.reversePending.set(requestId, { sender: target, method, resolve, reject, timer });
      const abort = () => {
        const pending = this.reversePending.get(requestId);
        if (!pending) return;
        this.reversePending.delete(requestId);
        clearTimeout(pending.timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Renderer RPC request cancelled.'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      target.send('rpc:reverse-request', parseDesktopRpcReverseRequestEnvelope({
        kind: 'reverse-request', requestId, method, params,
      }));
    });
  }
}
