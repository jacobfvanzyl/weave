import { useNotificationSettingsStore } from '../../stores/notification-store';
import {
  dispatchNotificationEvent,
  getNativeNotificationPermissionState,
  requestNativeNotificationPermission,
} from './coordinator';
import type { NotificationPermissionState, WeaveNotificationEvent } from './types';

const testNotificationBody = 'If you can see this, native notification delivery is working.';

const permissionFailureMessage = (permission: Exclude<NotificationPermissionState, 'granted'>) => {
  if (permission === 'unsupported') return 'Native notifications are not available in this environment.';
  if (permission === 'prompt') return 'Notification permission is still required before Weave can show notifications.';
  return 'The OS rejected the test notification. On macOS, run a signed Weave build and allow Weave in System Settings.';
};

export const createTestNotificationEvent = (): WeaveNotificationEvent => ({
  id: `client:test-notification:${Date.now()}`,
  kind: 'notification.test',
  title: 'Weave test notification',
  body: testNotificationBody,
  createdAt: new Date().toISOString(),
  priority: 'normal',
  source: 'client',
});

export const sendTestNotification = async () => {
  let permission = await getNativeNotificationPermissionState();
  if (permission !== 'granted' && permission !== 'unsupported') {
    permission = await requestNativeNotificationPermission();
  }

  if (permission !== 'granted') {
    useNotificationSettingsStore.getState().setLastDeliveryFailure({
      message: permissionFailureMessage(permission),
      createdAt: new Date().toISOString(),
      eventKind: 'notification.test',
    });
    return { delivered: false as const, reason: permission };
  }

  return dispatchNotificationEvent(createTestNotificationEvent(), {
    suppressForegroundTarget: false,
  });
};
