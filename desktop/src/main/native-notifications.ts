import { BrowserWindow, Notification } from 'electron';
import type {
  NativeNotificationAction,
  NativeNotificationShowResult,
  NotificationPermissionState,
  WeaveNotificationEvent,
  WeaveNotificationPriority,
  WeaveNotificationSource,
  WeaveNotificationTarget,
} from '@weave/client/lib/notifications/types';

const activeNotifications = new Map<string, Notification>();
let lastKnownPermissionState: NotificationPermissionState | undefined;

const deliveryAckTimeoutMs = 5_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const isPriority = (value: unknown): value is WeaveNotificationPriority =>
  value === 'low' || value === 'normal' || value === 'high';

const isSource = (value: unknown): value is WeaveNotificationSource =>
  value === 'client' || value === 'server';

const parseTarget = (value: unknown): WeaveNotificationTarget | undefined => {
  if (!isRecord(value)) return undefined;
  const target: WeaveNotificationTarget = {
    ...(optionalString(value.threadId) ? { threadId: optionalString(value.threadId) } : {}),
    ...(optionalString(value.projectId) ? { projectId: optionalString(value.projectId) } : {}),
    ...(optionalString(value.workspaceId) ? { workspaceId: optionalString(value.workspaceId) } : {}),
    ...(optionalString(value.url) ? { url: optionalString(value.url) } : {}),
  };
  return Object.keys(target).length > 0 ? target : undefined;
};

export const parseNativeNotificationEvent = (value: unknown): WeaveNotificationEvent => {
  if (!isRecord(value)) throw new Error('Notification event must be an object.');
  const id = optionalString(value.id);
  const kind = optionalString(value.kind);
  const title = optionalString(value.title);
  const createdAt = optionalString(value.createdAt);
  const body = optionalString(value.body);
  const dedupeKey = optionalString(value.dedupeKey);
  if (!id || !kind || !title || !createdAt || !isPriority(value.priority) || !isSource(value.source)) {
    throw new Error('Notification event is invalid.');
  }

  const target = parseTarget(value.target);
  return {
    id,
    kind,
    title,
    ...(body ? { body } : {}),
    createdAt,
    ...(dedupeKey ? { dedupeKey } : {}),
    priority: value.priority,
    ...(target ? { target } : {}),
    source: value.source,
  };
};

const createMacOsFailureMessage = (error?: unknown) => {
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  return [
    'macOS blocked the notification. Electron native notifications require a code-signed Weave app on macOS.',
    'Run a signed build and allow Weave in System Settings > Notifications.',
    detail ? `Native error: ${detail}` : undefined,
  ].filter(Boolean).join(' ');
};

const createGenericFailureMessage = (error?: unknown) => {
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  return detail ? `The operating system rejected the notification: ${detail}` : 'The operating system rejected the notification.';
};

const formatDeliveryFailureMessage = (error?: unknown) =>
  process.platform === 'darwin' ? createMacOsFailureMessage(error) : createGenericFailureMessage(error);

const updatePermissionFromDelivery = (result: NativeNotificationShowResult) => {
  if (!Notification.isSupported()) {
    lastKnownPermissionState = 'unsupported';
    return;
  }

  lastKnownPermissionState = result.delivered ? 'granted' : 'denied';
};

const createPermissionProbeEvent = (): WeaveNotificationEvent => ({
  id: `client:notification-permission:${Date.now()}`,
  kind: 'notification.permission-check',
  title: 'Weave notifications enabled',
  body: 'Background thread completions can now send notifications.',
  createdAt: new Date().toISOString(),
  priority: 'low',
  source: 'client',
});

export const getNativeNotificationPermissionState = (): NotificationPermissionState => {
  if (!Notification.isSupported()) return 'unsupported';
  return lastKnownPermissionState ?? 'granted';
};

export const requestNativeNotificationPermission = async (): Promise<NotificationPermissionState> => {
  if (!Notification.isSupported()) return 'unsupported';
  if (process.platform !== 'darwin') {
    lastKnownPermissionState = 'granted';
    return 'granted';
  }

  const result = await showNativeNotification(createPermissionProbeEvent());
  updatePermissionFromDelivery(result);
  return result.delivered ? 'granted' : 'denied';
};

const focusMainWindow = () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
};

const emitNativeNotificationAction = (action: NativeNotificationAction) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('native-notification:action', action);
  }
};

export const showNativeNotification = async (event: WeaveNotificationEvent): Promise<NativeNotificationShowResult> => {
  if (!Notification.isSupported()) {
    const result: NativeNotificationShowResult = {
      delivered: false,
      reason: 'unsupported',
      message: 'Native notifications are not supported on this system.',
    };
    updatePermissionFromDelivery(result);
    return result;
  }

  activeNotifications.get(event.id)?.close();

  const notification = new Notification({
    id: event.id,
    title: event.title,
    body: event.body,
    silent: event.priority === 'low',
  });

  const delivery = new Promise<NativeNotificationShowResult>(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: NativeNotificationShowResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      updatePermissionFromDelivery(result);
      resolve(result);
    };
    timer = setTimeout(() => finish({ delivered: true }), deliveryAckTimeoutMs);

    notification.once('show', () => finish({ delivered: true }));
    notification.once('failed', (_event, error) => {
      const result: NativeNotificationShowResult = {
        delivered: false,
        reason: 'failed',
        message: formatDeliveryFailureMessage(error),
      };
      console.warn('[notifications] native notification failed', error);
      activeNotifications.delete(event.id);
      finish(result);
    });
  });

  activeNotifications.set(event.id, notification);
  notification.on('click', () => {
    focusMainWindow();
    emitNativeNotificationAction({ event, actionId: 'default' });
  });
  notification.on('close', () => {
    activeNotifications.delete(event.id);
  });
  notification.show();
  return delivery;
};

export const clearNativeNotifications = async (id?: string) => {
  if (id) {
    activeNotifications.get(id)?.close();
    activeNotifications.delete(id);
    return;
  }

  for (const notification of activeNotifications.values()) notification.close();
  activeNotifications.clear();
};
