import type {
  NativeNotificationAction,
  NativeNotificationShowResult,
  NotificationPermissionState,
  WeaveNotificationEvent,
} from '@weave/client/lib/notifications/types';
import type {
  DesktopRpcNotificationEnvelope,
  DesktopRpcNotifyEnvelope,
  DesktopRpcRequestEnvelope,
  DesktopRpcResponseEnvelope,
  DesktopRpcReverseRequestEnvelope,
  DesktopRpcReverseResponseEnvelope,
  RpcNotificationMethod,
  RpcRequestMethod,
} from '@weave/protocol';

export type DesktopConnectionSettings = {
  mastraUrl: string;
  hasAuthToken: boolean;
};

export type DesktopConnectionInput = {
  mastraUrl: string;
  authToken?: string | null;
};

export type DesktopConnectionTestResult =
  | { ok: true; user: { id: string; name: string } }
  | { ok: false; status?: number; error: string };

export type DesktopPortalStatus = {
  phase: 'idle' | 'starting' | 'ready' | 'reconnecting' | 'failed';
  serverUrl: string;
  portalId?: string;
  source?: 'adopted' | 'launched';
  remoteConnectionState?: 'connecting' | 'connected' | 'reconnecting' | 'rejected';
  remoteConnectedAt?: string;
  error?: string;
};

export type DesktopChatGPTAuthStatus = {
  connected: boolean;
  accountId?: string;
  expires?: number;
};

export type WeaveDesktopBridge = {
  getConnectionSettings: () => Promise<DesktopConnectionSettings>;
  saveConnectionSettings: (input: DesktopConnectionInput) => Promise<DesktopConnectionSettings>;
  testConnection: (input?: DesktopConnectionInput) => Promise<DesktopConnectionTestResult>;
  rpcRequest: <Method extends RpcRequestMethod<'client', 'server'>>(
    request: DesktopRpcRequestEnvelope<Method>,
  ) => Promise<DesktopRpcResponseEnvelope<Method>>;
  cancelRpcRequest: (requestId: string) => void;
  rpcNotify: <Method extends RpcNotificationMethod<'client', 'server'>>(
    notification: DesktopRpcNotifyEnvelope<Method>,
  ) => Promise<void>;
  onRpcConnectionState: (listener: (state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed') => void) => () => void;
  onRpcNotification: (listener: (notification: DesktopRpcNotificationEnvelope) => void) => () => void;
  onRpcReverseRequest: (
    listener: (request: DesktopRpcReverseRequestEnvelope) => void,
  ) => () => void;
  respondRpcReverseRequest: (response: DesktopRpcReverseResponseEnvelope) => Promise<void>;
  getPortalStatus: () => Promise<DesktopPortalStatus>;
  retryPortal: () => Promise<DesktopPortalStatus>;
  onPortalStatus: (listener: (status: DesktopPortalStatus) => void) => () => void;
  openExternal: (url: string) => Promise<void>;
  connectChatGPT: () => Promise<DesktopChatGPTAuthStatus>;
  getPlatform: () => NodeJS.Platform;
  nativeNotificationsGetPermissionState: () => Promise<NotificationPermissionState>;
  nativeNotificationsRequestPermission: () => Promise<NotificationPermissionState>;
  nativeNotificationsShow: (event: WeaveNotificationEvent) => Promise<NativeNotificationShowResult>;
  nativeNotificationsClear: (id?: string) => Promise<void>;
  onNativeNotificationAction: (listener: (action: NativeNotificationAction) => void) => () => void;
};
