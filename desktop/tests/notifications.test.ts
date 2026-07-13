import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchNotificationEvent, clearNotificationCoordinatorForTests } from '../../packages/client/src/lib/notifications/coordinator';
import { createDesktopNotificationAdapter } from '../../packages/client/src/lib/notifications/adapters/desktop';
import { clearNativeNotificationAdapterForTests, setNativeNotificationAdapter } from '../../packages/client/src/lib/notifications/registry';
import { sendTestNotification } from '../../packages/client/src/lib/notifications/test-notification';
import { parseWeaveNotificationEvent, type NativeNotificationAdapter, type WeaveNotificationEvent } from '../../packages/client/src/lib/notifications/types';
import { useNotificationSettingsStore } from '../../packages/client/src/stores/notification-store';

const event: WeaveNotificationEvent = {
  id: 'notification-1',
  kind: 'thread.completed',
  title: 'Thread completed',
  body: 'A background Weave thread finished.',
  createdAt: '2026-07-04T10:00:00.000Z',
  dedupeKey: 'thread-1:completed',
  priority: 'normal',
  target: { threadId: 'thread-1', projectId: 'project-1', workspaceId: 'workspace-1' },
  source: 'client',
};

const createAdapter = () => {
  const show = vi.fn<NativeNotificationAdapter['show']>();
  const adapter: NativeNotificationAdapter = {
    getPermissionState: vi.fn<NativeNotificationAdapter['getPermissionState']>(() => 'granted'),
    requestPermission: vi.fn<NativeNotificationAdapter['requestPermission']>(async () => 'granted'),
    show,
    clear: vi.fn(),
    onAction: vi.fn(() => () => undefined),
  };
  return { adapter, show };
};

afterEach(() => {
  clearNativeNotificationAdapterForTests();
  clearNotificationCoordinatorForTests();
  useNotificationSettingsStore.setState({
    lastDeliveryFailure: undefined,
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('notification event contract', () => {
  it('parses valid wire events and rejects malformed events', () => {
    expect(parseWeaveNotificationEvent(event)).toMatchObject({
      id: 'notification-1',
      kind: 'thread.completed',
      title: 'Thread completed',
      priority: 'normal',
      source: 'client',
      target: { threadId: 'thread-1' },
    });

    expect(parseWeaveNotificationEvent({ ...event, priority: 'urgent' })).toBeUndefined();
    expect(parseWeaveNotificationEvent({ ...event, source: 'push' })).toBeUndefined();
    expect(parseWeaveNotificationEvent({ ...event, title: '' })).toBeUndefined();
  });
});

describe('notification coordinator', () => {
  it('delivers events when OS permission is granted', async () => {
    const { adapter, show } = createAdapter();
    setNativeNotificationAdapter(adapter);

    const result = await dispatchNotificationEvent(event, { isForegroundTargetActive: () => false });

    expect(result).toEqual({ delivered: true });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(event);
  });

  it('suppresses delivery when OS permission is denied', async () => {
    const { adapter, show } = createAdapter();
    vi.mocked(adapter.getPermissionState).mockResolvedValue('denied');
    setNativeNotificationAdapter(adapter);

    const result = await dispatchNotificationEvent(event, { isForegroundTargetActive: () => false });

    expect(result).toEqual({ delivered: false, reason: 'denied' });
    expect(show).toHaveBeenCalledTimes(0);
  });

  it('dedupes delivered events by dedupe key', async () => {
    const { adapter, show } = createAdapter();
    setNativeNotificationAdapter(adapter);

    const first = await dispatchNotificationEvent(event, { now: 1_000, isForegroundTargetActive: () => false });
    const second = await dispatchNotificationEvent({ ...event, id: 'notification-2' }, {
      now: 1_500,
      isForegroundTargetActive: () => false,
    });

    expect(first).toEqual({ delivered: true });
    expect(second).toEqual({ delivered: false, reason: 'duplicate' });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(event);
  });

  it('suppresses notifications for an active foreground target', async () => {
    const { adapter, show } = createAdapter();
    setNativeNotificationAdapter(adapter);

    const result = await dispatchNotificationEvent(event, { isForegroundTargetActive: () => true });

    expect(result).toEqual({ delivered: false, reason: 'foreground' });
    expect(show).toHaveBeenCalledTimes(0);
  });

  it('records native delivery failures without consuming the dedupe key', async () => {
    const { adapter, show } = createAdapter();
    show
      .mockResolvedValueOnce({
        delivered: false,
        reason: 'failed',
        message: 'macOS blocked the notification.',
      })
      .mockResolvedValueOnce({ delivered: true });
    setNativeNotificationAdapter(adapter);

    const failed = await dispatchNotificationEvent(event, { now: 1_000, isForegroundTargetActive: () => false });
    expect(useNotificationSettingsStore.getState().lastDeliveryFailure?.message).toBe('macOS blocked the notification.');

    const retried = await dispatchNotificationEvent({ ...event, id: 'notification-2' }, {
      now: 1_500,
      isForegroundTargetActive: () => false,
    });

    expect(failed).toEqual({ delivered: false, reason: 'failed' });
    expect(retried).toEqual({ delivered: true });
    expect(show).toHaveBeenCalledTimes(2);
    expect(useNotificationSettingsStore.getState().lastDeliveryFailure).toBeUndefined();
  });

  it('sends explicit test notifications after requesting OS permission', async () => {
    const { adapter, show } = createAdapter();
    setNativeNotificationAdapter(adapter);

    const result = await sendTestNotification();

    expect(result).toEqual({ delivered: true });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'notification.test',
      title: 'Weave test notification',
      source: 'client',
    }));
  });

  it('delivers server test notifications through the same OS permission gate', async () => {
    const { adapter, show } = createAdapter();
    setNativeNotificationAdapter(adapter);

    const result = await dispatchNotificationEvent({
      ...event,
      id: 'server-test-notification-1',
      kind: 'notification.test',
      title: 'Server test',
      source: 'server',
    });

    expect(result).toEqual({ delivered: true });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'notification.test',
      title: 'Server test',
      source: 'server',
    }));
  });
});


describe('desktop notification adapter', () => {
  it('proxies delivery and actions through the Electron bridge', async () => {
    const remove = vi.fn();
    const actionListener = vi.fn();
    const bridge = {
      nativeNotificationsGetPermissionState: vi.fn(async () => 'granted' as const),
      nativeNotificationsRequestPermission: vi.fn(async () => 'granted' as const),
      nativeNotificationsShow: vi.fn(async () => ({ delivered: true as const })),
      nativeNotificationsClear: vi.fn(async () => undefined),
      onNativeNotificationAction: vi.fn((listener: (action: { event: WeaveNotificationEvent; actionId: string }) => void) => {
        listener({ event, actionId: 'default' });
        return remove;
      }),
    };
    vi.stubGlobal('window', { weaveDesktop: bridge });

    const adapter = createDesktopNotificationAdapter();
    expect(adapter).toBeDefined();

    await adapter?.show(event);
    const unsubscribe = adapter?.onAction(actionListener);
    unsubscribe?.();

    expect(bridge.nativeNotificationsShow).toHaveBeenCalledWith(event);
    expect(actionListener).toHaveBeenCalledWith({ event, actionId: 'default' });
    expect(remove).toHaveBeenCalled();
  });
});
