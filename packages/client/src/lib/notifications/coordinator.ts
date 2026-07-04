import { useChatStore } from '../../stores/chat-store';
import { useNotificationSettingsStore } from '../../stores/notification-store';
import { useWorkspaceSurfaceStore } from '../../stores/workspace-surface-store';
import { getNativeNotificationAdapter } from './registry';
import type {
  NativeNotificationAction,
  NativeNotificationShowResult,
  NotificationPermissionState,
  WeaveNotificationEvent,
} from './types';

const dedupeTtlMs = 10 * 60 * 1000;
const recentDedupeKeys = new Map<string, number>();

type DispatchNotificationOptions = {
  isForegroundTargetActive?: (event: WeaveNotificationEvent) => boolean;
  suppressForegroundTarget?: boolean;
  now?: number;
};

const pruneDedupeKeys = (now: number) => {
  for (const [key, timestamp] of recentDedupeKeys) {
    if (now - timestamp > dedupeTtlMs) recentDedupeKeys.delete(key);
  }
};

const isDocumentFocused = () =>
  typeof document !== 'undefined'
  && document.visibilityState === 'visible'
  && (typeof document.hasFocus !== 'function' || document.hasFocus());

const isForegroundTargetActive = (event: WeaveNotificationEvent) =>
  Boolean(event.target?.threadId && useWorkspaceSurfaceStore.getState().threadId === event.target.threadId && isDocumentFocused());

const isExplicitTestNotification = (event: WeaveNotificationEvent) => event.kind === 'notification.test';

const recordDeliveryFailure = (
  event: WeaveNotificationEvent,
  result: Extract<NativeNotificationShowResult, { delivered: false }>,
) => {
  useNotificationSettingsStore.getState().setLastDeliveryFailure({
    message: result.message ?? 'The operating system rejected the notification.',
    createdAt: new Date().toISOString(),
    eventKind: event.kind,
  });
};

const clearDeliveryFailure = () => {
  useNotificationSettingsStore.getState().setLastDeliveryFailure(undefined);
};

export const getNativeNotificationPermissionState = async (): Promise<NotificationPermissionState> => {
  const adapter = getNativeNotificationAdapter();
  return adapter ? await adapter.getPermissionState() : 'unsupported';
};

export const requestNativeNotificationPermission = async (): Promise<NotificationPermissionState> => {
  const adapter = getNativeNotificationAdapter();
  return adapter ? await adapter.requestPermission() : 'unsupported';
};

export const dispatchNotificationEvent = async (
  event: WeaveNotificationEvent,
  options: DispatchNotificationOptions = {},
) => {
  const shouldSuppressForeground = options.suppressForegroundTarget ?? !isExplicitTestNotification(event);
  const foregroundCheck = options.isForegroundTargetActive ?? isForegroundTargetActive;
  if (shouldSuppressForeground && foregroundCheck(event)) return { delivered: false, reason: 'foreground' as const };

  const now = options.now ?? Date.now();
  pruneDedupeKeys(now);
  const dedupeKey = event.dedupeKey ?? event.id;
  if (recentDedupeKeys.has(dedupeKey)) return { delivered: false, reason: 'duplicate' as const };

  const adapter = getNativeNotificationAdapter();
  if (!adapter) return { delivered: false, reason: 'unsupported' as const };

  const permission = await adapter.getPermissionState();
  if (permission !== 'granted') return { delivered: false, reason: permission as Exclude<NotificationPermissionState, 'granted'> };

  try {
    const result = await adapter.show(event);
    if (result?.delivered === false) {
      recordDeliveryFailure(event, result);
      return { delivered: false, reason: result.reason };
    }
  } catch (error) {
    recordDeliveryFailure(event, {
      delivered: false,
      reason: 'failed',
      message: error instanceof Error ? error.message : 'The operating system rejected the notification.',
    });
    return { delivered: false, reason: 'failed' as const };
  }

  clearDeliveryFailure();
  recentDedupeKeys.set(dedupeKey, now);
  return { delivered: true as const };
};

export const handleNativeNotificationAction = (action: NativeNotificationAction) => {
  const { event } = action;
  const threadId = event.target?.threadId;
  if (threadId) {
    useChatStore.getState().selectThread(threadId);
    return;
  }

  if (event.target?.url && typeof window !== 'undefined') {
    window.location.href = event.target.url;
  }
};

export const clearNotificationCoordinatorForTests = () => {
  recentDedupeKeys.clear();
};
