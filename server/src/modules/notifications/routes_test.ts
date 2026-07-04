import { Hono } from 'hono';
import { createOwnerAuthMiddleware } from '../../owner/auth.ts';
import { mountRoute } from '../../server/routes.ts';
import type { ServerVariables, WeaveApp } from '../../server/types.ts';
import { clearNotificationHubForTests, observeServerNotifications } from './service.ts';
import { notificationRoutes } from './routes.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const createTestApp = () => {
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use('*', createOwnerAuthMiddleware({
    auth: {
      token: 'test-token',
      owner: { id: 'owner-1', name: 'Test Owner', role: 'owner' },
    },
    mastra: {} as ServerVariables['mastra'],
  }));
  for (const route of notificationRoutes) mountRoute(app as WeaveApp, route);
  return app;
};

Deno.test('notification test endpoint requires owner auth', async () => {
  clearNotificationHubForTests();
  const app = createTestApp();

  const response = await app.request('/notifications/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Server test', body: 'From endpoint' }),
  });

  assertEquals(response.status, 401);
});

Deno.test('notification test endpoint publishes to the authenticated owner stream', async () => {
  clearNotificationHubForTests();
  const app = createTestApp();
  const reader = observeServerNotifications('owner-1').getReader();

  const response = await app.request('/notifications/test', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title: 'Server test', body: 'From endpoint' }),
  });
  const json = await response.json();
  const received = await reader.read();
  await reader.cancel();

  assertEquals(response.status, 200);
  assertEquals(json.ok, true);
  assertEquals(json.sequence, 1);
  assertEquals(json.event.kind, 'notification.test');
  assertEquals(json.event.title, 'Server test');
  assertEquals(json.event.body, 'From endpoint');
  assertEquals(json.event.source, 'server');
  assertEquals(received.value?.event.title, 'Server test');
  assertEquals(received.value?.event.source, 'server');
});

Deno.test('notification test endpoint rejects missing titles', async () => {
  clearNotificationHubForTests();
  const app = createTestApp();

  const response = await app.request('/notifications/test', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ body: 'No title' }),
  });
  const json = await response.json();

  assertEquals(response.status, 400);
  assertEquals(json.error, 'Notification title is required.');
});
