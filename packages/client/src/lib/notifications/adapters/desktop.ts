import type {
  NativeNotificationAction,
  NativeNotificationAdapter,
  NativeNotificationShowResult,
  NotificationPermissionState,
  WeaveNotificationEvent,
} from '../types';

type DesktopNotificationBridge = {
  nativeNotificationsGetPermissionState: () => Promise<NotificationPermissionState>;
  nativeNotificationsRequestPermission: () => Promise<NotificationPermissionState>;
  nativeNotificationsShow: (event: WeaveNotificationEvent) => Promise<NativeNotificationShowResult>;
  nativeNotificationsClear: (id?: string) => Promise<void>;
  onNativeNotificationAction: (listener: (action: NativeNotificationAction) => void) => () => void;
};

type WindowWithDesktopNotifications = Window & {
  weaveDesktop?: Partial<DesktopNotificationBridge>;
};

const getDesktopNotificationBridge = (): DesktopNotificationBridge | undefined => {
  if (typeof window === 'undefined') return undefined;
  const bridge = (window as WindowWithDesktopNotifications).weaveDesktop;
  if (
    typeof bridge?.nativeNotificationsGetPermissionState !== 'function'
    || typeof bridge.nativeNotificationsRequestPermission !== 'function'
    || typeof bridge.nativeNotificationsShow !== 'function'
    || typeof bridge.nativeNotificationsClear !== 'function'
    || typeof bridge.onNativeNotificationAction !== 'function'
  ) {
    return undefined;
  }

  return bridge as DesktopNotificationBridge;
};

export const createDesktopNotificationAdapter = (): NativeNotificationAdapter | undefined => {
  const bridge = getDesktopNotificationBridge();
  if (!bridge) return undefined;

  return {
    getPermissionState: bridge.nativeNotificationsGetPermissionState,
    requestPermission: bridge.nativeNotificationsRequestPermission,
    show: bridge.nativeNotificationsShow,
    clear: bridge.nativeNotificationsClear,
    onAction: bridge.onNativeNotificationAction,
  };
};
