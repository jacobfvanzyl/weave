import { defineRoute } from '../../server/routes';
import {
  completeCodexBrowserLogin,
  getCodexAuthStatus,
  startCodexBrowserLogin,
} from '../mastra/providers/chatgpt-codex-auth';

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const htmlResponse = (title: string, message: string, status = 200) =>
  new Response(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p><script>setTimeout(() => window.close(), 1200)</script></body></html>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

export const chatgptAuthRoutes = [
  defineRoute('/agent/chatgpt/login/start', {
    method: 'POST',
    handler: async c => {
      const login = await startCodexBrowserLogin();
      return jsonResponse(login);
    },
  }),
  defineRoute('/agent/chatgpt/login/callback', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
      const url = new URL(c.req.url);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');

      if (error) return htmlResponse('ChatGPT Login Failed', error, 400);
      if (!code || !state) return htmlResponse('ChatGPT Login Failed', 'Missing code or state.', 400);

      try {
        await completeCodexBrowserLogin({ code, state });
        return htmlResponse('ChatGPT Connected', 'You can close this window and return to Mage Hand.');
      } catch (loginError) {
        const message = loginError instanceof Error ? loginError.message : String(loginError);
        return htmlResponse('ChatGPT Login Failed', message, 400);
      }
    },
  }),
  defineRoute('/agent/chatgpt/auth-status', {
    method: 'GET',
    handler: async () => jsonResponse(await getCodexAuthStatus()),
  }),
];
