import type {
  NativeNotificationAction,
  NativeNotificationShowResult,
  NotificationPermissionState,
  WeaveNotificationEvent,
} from '@weave/client/lib/notifications/types';

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
  rpcRequest: <T = unknown>(method: string, params?: unknown, options?: {
    timeoutMs?: number;
    requestId?: string;
  }) => Promise<T>;
  cancelRpcRequest: (requestId: string) => void;
  rpcNotify: (method: string, params?: unknown) => Promise<void>;
  onRpcConnectionState: (listener: (state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed') => void) => () => void;
  onRpcNotification: (listener: (method: string, params: unknown) => void) => () => void;
  onRpcReverseRequest: (
    listener: (requestId: string, method: string, params: unknown) => void,
  ) => () => void;
  respondRpcReverseRequest: (
    requestId: string,
    result?: unknown,
    error?: { message: string },
  ) => Promise<void>;
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
