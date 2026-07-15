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
import {
  type DesktopRpcRequestEnvelope,
  type DesktopRpcResponseEnvelope,
  parseDesktopRpcNotificationEnvelope,
  parseDesktopRpcNotifyEnvelope,
  parseDesktopRpcRequestEnvelope,
  parseDesktopRpcResponseEnvelope,
  parseDesktopRpcReverseRequestEnvelope,
  parseDesktopRpcReverseResponseEnvelope,
  type RpcRequestMethod,
} from '@weave/protocol';

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
  rpcRequest: async <Method extends RpcRequestMethod<'client', 'server'>>(
    input: DesktopRpcRequestEnvelope<Method>,
  ): Promise<DesktopRpcResponseEnvelope<Method>> => {
    const method = input.method as Method;
    const request = parseDesktopRpcRequestEnvelope<Method>(input, method);
    const response: unknown = await ipcRenderer.invoke('rpc:request', request);
    return parseDesktopRpcResponseEnvelope<Method>(response, method);
  },
  cancelRpcRequest: requestId => ipcRenderer.send('rpc:request-cancel', requestId),
  rpcNotify: input => ipcRenderer.invoke('rpc:notify', parseDesktopRpcNotifyEnvelope(input, input.method)) as Promise<void>,
  onRpcConnectionState: listener => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed') => listener(state);
    ipcRenderer.on('rpc:connection-state', wrapped);
    return () => ipcRenderer.removeListener('rpc:connection-state', wrapped);
  },
  onRpcNotification: listener => {
    const wrapped = (_event: Electron.IpcRendererEvent, input: unknown) =>
      listener(parseDesktopRpcNotificationEnvelope(input));
    ipcRenderer.on('rpc:notification', wrapped);
    return () => ipcRenderer.removeListener('rpc:notification', wrapped);
  },
  onRpcReverseRequest: listener => {
    const wrapped = (_event: Electron.IpcRendererEvent, input: unknown) =>
      listener(parseDesktopRpcReverseRequestEnvelope(input));
    ipcRenderer.on('rpc:reverse-request', wrapped);
    return () => ipcRenderer.removeListener('rpc:reverse-request', wrapped);
  },
  respondRpcReverseRequest: response =>
    ipcRenderer.invoke(
      'rpc:reverse-response',
      parseDesktopRpcReverseResponseEnvelope(response, response.method),
    ) as Promise<void>,
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
