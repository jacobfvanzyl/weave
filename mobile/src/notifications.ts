import { Capacitor, type PermissionState } from '@capacitor/core';
import { LocalNotifications, type ActionPerformed } from '@capacitor/local-notifications';
import { setNativeNotificationAdapter } from '@weave/client/lib/notifications/registry';
import {
  parseWeaveNotificationEvent,
  type NativeNotificationAction,
  type NativeNotificationAdapter,
  type NotificationPermissionState,
  type WeaveNotificationEvent,
} from '@weave/client/lib/notifications/types';

const actionListeners = new Set<(action: NativeNotificationAction) => void>();
let isConfigured = false;

const toPermissionState = (permission: PermissionState): NotificationPermissionState => {
  if (permission === 'granted' || permission === 'denied') return permission;
  return 'prompt';
};

const toNativeNotificationId = (id: string) => {
  let hash = 2_166_136_261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return (hash >>> 0) % 2_147_483_647 || 1;
};

const emitNotificationAction = (action: ActionPerformed) => {
  const event = parseWeaveNotificationEvent(action.notification.extra?.weaveNotificationEvent);
  if (!event) return;

  for (const listener of actionListeners) {
    listener({
      event,
      actionId: action.actionId || 'default',
      ...(action.inputValue ? { inputValue: action.inputValue } : {}),
    });
  }
};

const createCapacitorNotificationAdapter = (): NativeNotificationAdapter => ({
  async getPermissionState() {
    try {
      const permission = await LocalNotifications.checkPermissions();
      return toPermissionState(permission.display);
    } catch {
      return 'unsupported';
    }
  },
  async requestPermission() {
    try {
      const permission = await LocalNotifications.requestPermissions();
      return toPermissionState(permission.display);
    } catch {
      return 'unsupported';
    }
  },
  async show(event: WeaveNotificationEvent) {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: toNativeNotificationId(event.id),
          title: event.title,
          body: event.body ?? '',
          autoCancel: true,
          extra: { weaveNotificationEvent: event },
          ...(event.target?.threadId ? { threadIdentifier: event.target.threadId, group: event.target.threadId } : {}),
          ...(event.priority === 'low' ? { interruptionLevel: 'passive' as const, relevanceScore: 0.1 } : {}),
          ...(event.priority === 'high' ? { interruptionLevel: 'active' as const, relevanceScore: 1 } : {}),
        },
      ],
    });
  },
  async clear(id?: string) {
    if (id) {
      const notificationId = toNativeNotificationId(id);
      await Promise.allSettled([
        LocalNotifications.cancel({ notifications: [{ id: notificationId }] }),
        LocalNotifications.getDeliveredNotifications().then(delivered => {
          const notifications = delivered.notifications.filter(notification => notification.id === notificationId);
          return notifications.length > 0
            ? LocalNotifications.removeDeliveredNotifications({ notifications })
            : undefined;
        }),
      ]);
      return;
    }

    const pending = await LocalNotifications.getPending().catch(() => ({ notifications: [] }));
    await Promise.allSettled([
      pending.notifications.length > 0
        ? LocalNotifications.cancel({ notifications: pending.notifications.map(notification => ({ id: notification.id })) })
        : undefined,
      LocalNotifications.removeAllDeliveredNotifications(),
    ]);
  },
  onAction(listener) {
    actionListeners.add(listener);
    return () => actionListeners.delete(listener);
  },
});

export const configureMobileNotifications = () => {
  if (isConfigured || !Capacitor.isNativePlatform()) return;
  isConfigured = true;

  setNativeNotificationAdapter(createCapacitorNotificationAdapter());
  void LocalNotifications.addListener('localNotificationActionPerformed', emitNotificationAction);
};
