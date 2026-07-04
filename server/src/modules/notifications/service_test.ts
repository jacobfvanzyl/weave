import { clearNotificationHubForTests, observeServerNotifications, publishServerNotification } from './service.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const assertRejects = async (operation: () => unknown | Promise<unknown>, expectedMessage: string) => {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expectedMessage)) {
      throw new Error(`Expected error message to include ${expectedMessage}, received ${message}`);
    }
    return;
  }

  throw new Error('Expected operation to reject.');
};

Deno.test('notification hub replays buffered events after a sequence', async () => {
  clearNotificationHubForTests();
  publishServerNotification('owner-1', { kind: 'one', title: 'First', priority: 'normal' });
  const second = publishServerNotification('owner-1', { kind: 'two', title: 'Second', priority: 'high' });

  const reader = observeServerNotifications('owner-1', 1).getReader();
  const replayed = await reader.read();
  await reader.cancel();

  assertEquals(replayed.done, false);
  assertEquals(replayed.value?.sequence, second.sequence);
  assertEquals(replayed.value?.event.title, 'Second');
  assertEquals(replayed.value?.event.source, 'server');
});

Deno.test('notification hub isolates resource streams', async () => {
  clearNotificationHubForTests();
  const reader = observeServerNotifications('owner-1').getReader();
  publishServerNotification('owner-2', { kind: 'foreign', title: 'Foreign', priority: 'normal' });
  const ownerEvent = publishServerNotification('owner-1', { kind: 'local', title: 'Local', priority: 'normal' });

  const received = await reader.read();
  await reader.cancel();

  assertEquals(received.value?.sequence, ownerEvent.sequence);
  assertEquals(received.value?.event.kind, 'local');
});

Deno.test('notification hub validates required event fields', async () => {
  clearNotificationHubForTests();
  await assertRejects(
    () => publishServerNotification('owner-1', { kind: '', title: 'Missing kind', priority: 'normal' }),
    'Notification kind is required',
  );
  await assertRejects(
    () => publishServerNotification('owner-1', { kind: 'missing-title', title: '', priority: 'normal' }),
    'Notification title is required',
  );
});
