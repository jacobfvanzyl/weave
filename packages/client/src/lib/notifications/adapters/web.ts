import type {
  NativeNotificationAction,
  NativeNotificationAdapter,
  NotificationPermissionState,
  WeaveNotificationEvent,
} from '../types';

const permissionFromNotification = (): NotificationPermissionState => {
  if (typeof window === 'undefined' || typeof window.Notification !== 'function') return 'unsupported';
  if (window.Notification.permission === 'granted') return 'granted';
  if (window.Notification.permission === 'denied') return 'denied';
  return 'prompt';
};

const isWebNotificationContextSupported = () => {
  if (typeof window === 'undefined' || typeof window.Notification !== 'function') return false;
  if (window.isSecureContext) return true;
  const hostname = window.location.hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
};

export const createWebNotificationAdapter = (): NativeNotificationAdapter | undefined => {
  if (!isWebNotificationContextSupported()) return undefined;

  const activeNotifications = new Map<string, Notification>();
  const listeners = new Set<(action: NativeNotificationAction) => void>();

  const emitAction = (event: WeaveNotificationEvent, actionId = 'default') => {
    for (const listener of listeners) listener({ event, actionId });
  };

  return {
    getPermissionState: () => permissionFromNotification(),
    requestPermission: async () => {
      if (!isWebNotificationContextSupported()) return 'unsupported';
      const permission = await window.Notification.requestPermission();
      return permission === 'granted' ? 'granted' : permission === 'denied' ? 'denied' : 'prompt';
    },
    show: event => {
      if (permissionFromNotification() !== 'granted') return;
      activeNotifications.get(event.id)?.close();
      const notification = new window.Notification(event.title, {
        body: event.body,
        tag: event.id,
        silent: event.priority === 'low',
        data: event,
      });
      activeNotifications.set(event.id, notification);
      notification.onclick = () => {
        window.focus();
        emitAction(event);
      };
      notification.onclose = () => {
        activeNotifications.delete(event.id);
      };
    },
    clear: id => {
      if (id) {
        activeNotifications.get(id)?.close();
        activeNotifications.delete(id);
        return;
      }

      for (const notification of activeNotifications.values()) notification.close();
      activeNotifications.clear();
    },
    onAction: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
