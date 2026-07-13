import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopConnectionInput,
  DesktopConnectionSettings,
  DesktopConnectionTestResult,
  DesktopChatGPTAuthStatus,
  DesktopPortalStatus,
  WeaveDesktopBridge,
} from '../shared/desktop-api';
import type {
  NativeNotificationAction,
  NativeNotificationShowResult,
  WeaveNotificationEvent,
} from '@weave/client/lib/notifications/types';

type IpcErrorResult = {
  __weaveIpcError: true;
  message: string;
};

const unwrapIpcResult = async <T>(promise: Promise<T | IpcErrorResult>): Promise<T> => {
  const result = await promise;
  if (
    result
    && typeof result === 'object'
    && '__weaveIpcError' in result
    && result.__weaveIpcError === true
  ) {
    throw new Error(typeof result.message === 'string' ? result.message : 'Desktop IPC request failed.');
  }
  return result as T;
};

const bridge: WeaveDesktopBridge = {
  getConnectionSettings: () => ipcRenderer.invoke('connection:get-settings') as Promise<DesktopConnectionSettings>,
  saveConnectionSettings: (input: DesktopConnectionInput) =>
    ipcRenderer.invoke('connection:save-settings', input) as Promise<DesktopConnectionSettings>,
  testConnection: (input?: DesktopConnectionInput) =>
    ipcRenderer.invoke('connection:test', input) as Promise<DesktopConnectionTestResult>,
  rpcRequest: <T = unknown>(method: string, params?: unknown, options?: {
    timeoutMs?: number;
    requestId?: string;
  }) => ipcRenderer.invoke(
    'rpc:request',
    options?.requestId ?? `renderer_${crypto.randomUUID()}`,
    method,
    params,
    { ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) },
  ) as Promise<T>,
  cancelRpcRequest: requestId => ipcRenderer.send('rpc:request-cancel', requestId),
  rpcNotify: (method: string, params?: unknown) =>
    ipcRenderer.invoke('rpc:notify', method, params) as Promise<void>,
  onRpcConnectionState: listener => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed') => listener(state);
    ipcRenderer.on('rpc:connection-state', wrapped);
    return () => ipcRenderer.removeListener('rpc:connection-state', wrapped);
  },
  onRpcNotification: listener => {
    const wrapped = (_event: Electron.IpcRendererEvent, notification: { method: string; params: unknown }) =>
      listener(notification.method, notification.params);
    ipcRenderer.on('rpc:notification', wrapped);
    return () => ipcRenderer.removeListener('rpc:notification', wrapped);
  },
  onRpcReverseRequest: listener => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      request: { requestId: string; method: string; params: unknown },
    ) => listener(request.requestId, request.method, request.params);
    ipcRenderer.on('rpc:reverse-request', wrapped);
    return () => ipcRenderer.removeListener('rpc:reverse-request', wrapped);
  },
  respondRpcReverseRequest: (requestId, result, error) =>
    ipcRenderer.invoke('rpc:reverse-response', requestId, result, error) as Promise<void>,
  getPortalStatus: () => ipcRenderer.invoke('portal:get-status') as Promise<DesktopPortalStatus>,
  retryPortal: () => unwrapIpcResult<DesktopPortalStatus>(ipcRenderer.invoke('portal:retry')),
  onPortalStatus: listener => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, status: DesktopPortalStatus) => listener(status);
    ipcRenderer.on('portal:status', wrappedListener);
    return () => ipcRenderer.removeListener('portal:status', wrappedListener);
  },
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url) as Promise<void>,
  connectChatGPT: () =>
    unwrapIpcResult<DesktopChatGPTAuthStatus>(ipcRenderer.invoke('chatgpt:connect')),
  getPlatform: () => process.platform,
  nativeNotificationsGetPermissionState: () =>
    ipcRenderer.invoke('native-notifications:get-permission-state'),
  nativeNotificationsRequestPermission: () =>
    ipcRenderer.invoke('native-notifications:request-permission'),
  nativeNotificationsShow: (event: WeaveNotificationEvent) =>
    ipcRenderer.invoke('native-notifications:show', event) as Promise<NativeNotificationShowResult>,
  nativeNotificationsClear: (id?: string) =>
    ipcRenderer.invoke('native-notifications:clear', id) as Promise<void>,
  onNativeNotificationAction: listener => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: NativeNotificationAction) => {
      listener(action);
    };
    ipcRenderer.on('native-notification:action', wrappedListener);
    return () => ipcRenderer.removeListener('native-notification:action', wrappedListener);
  },
};

contextBridge.exposeInMainWorld('weaveDesktop', bridge);
