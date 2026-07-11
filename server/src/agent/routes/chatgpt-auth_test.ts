import { Hono } from 'hono';
import { createOwnerAuthMiddleware, type OwnerAuthConfig } from '../../owner/auth.ts';
import { mountRoute } from '../../server/routes.ts';
import type { ServerVariables } from '../../server/types.ts';
import { createChatGPTAuthRoutes } from './chatgpt-auth.ts';

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

Deno.test('ChatGPT auth routes require owner auth and bind login operations to that owner', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const authService = {
    startBrowserLogin: (ownerId: string) => {
      calls.push({ operation: 'start', ownerId });
      return { url: 'https://auth.openai.com/test', state: 'state-1', expiresAt: 123 };
    },
    completeBrowserLogin: async (input: { ownerId: string; code: string; state: string }) => {
      calls.push({ operation: 'complete', ...input });
      return { access: 'hidden', accountId: 'account-1', expires: 456 };
    },
    getAuthStatus: async (ownerId: string) => {
      calls.push({ operation: 'status', ownerId });
      return { connected: true, accountId: 'account-1', expires: 456 };
    },
  };
  const auth: OwnerAuthConfig = {
    token: 'owner-token',
    owner: { id: 'owner-1', name: 'Owner One', role: 'owner' },
  };
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use('*', createOwnerAuthMiddleware({ auth, mastra: {} as never }));
  for (const route of createChatGPTAuthRoutes(authService as never)) mountRoute(app, route);

  assertEquals((await app.request('/agent/chatgpt/auth-status')).status, 401);
  const headers = { authorization: 'Bearer owner-token' };
  const start = await app.request('/agent/chatgpt/login/start', { method: 'POST', headers });
  assertEquals(start.status, 200);
  assertEquals(await start.json(), { url: 'https://auth.openai.com/test', state: 'state-1', expiresAt: 123 });

  const complete = await app.request('/agent/chatgpt/login/complete', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'code-1', state: 'state-1' }),
  });
  assertEquals(complete.status, 200);
  assertEquals(await complete.json(), { connected: true, accountId: 'account-1', expires: 456 });

  const status = await app.request('/agent/chatgpt/auth-status', { headers });
  assertEquals(await status.json(), { connected: true, accountId: 'account-1', expires: 456 });
  assertEquals(calls, [
    { operation: 'start', ownerId: 'owner-1' },
    { operation: 'complete', ownerId: 'owner-1', code: 'code-1', state: 'state-1' },
    { operation: 'status', ownerId: 'owner-1' },
  ]);
});

Deno.test('ChatGPT login completion rejects malformed JSON without token exchange', async () => {
  let completed = false;
  const authService = {
    startBrowserLogin: () => ({ url: '', state: '', expiresAt: 0 }),
    completeBrowserLogin: async ({ code, state }: { code: string; state: string }) => {
      completed = true;
      if (!code || !state) throw new Error('Authorization code is required.');
      return { access: 'hidden' };
    },
    getAuthStatus: async () => ({ connected: false }),
  };
  const auth: OwnerAuthConfig = {
    token: 'owner-token',
    owner: { id: 'owner-1', name: 'Owner One', role: 'owner' },
  };
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use('*', createOwnerAuthMiddleware({ auth, mastra: {} as never }));
  for (const route of createChatGPTAuthRoutes(authService as never)) mountRoute(app, route);

  const response = await app.request('/agent/chatgpt/login/complete', {
    method: 'POST',
    headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
    body: '{not-json',
  });
  assertEquals(response.status, 400);
  assertEquals(completed, true);
  const body = await response.json();
  assertEquals(body, { error: 'Authorization code is required.' });
});
