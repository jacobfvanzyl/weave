import { defineRoute } from '../../server/routes';
import { getOwner } from '../../owner/auth';
import { type ChatGPTCodexAuthService, chatGPTCodexAuthService } from '../mastra/providers/chatgpt-codex-auth';

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const errorStatus = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/required|state|different owner/i.test(message)) return 400;
  if (/token exchange/i.test(message)) return 502;
  return 500;
};

export const createChatGPTAuthRoutes = (
  authService: Pick<ChatGPTCodexAuthService, 'startBrowserLogin' | 'completeBrowserLogin' | 'getAuthStatus'> =
    chatGPTCodexAuthService,
) => [
  defineRoute('/agent/chatgpt/login/start', {
    method: 'POST',
    handler: async (c) => {
      const login = authService.startBrowserLogin(getOwner(c).id);
      return jsonResponse(login);
    },
  }),
  defineRoute('/agent/chatgpt/login/complete', {
    method: 'POST',
    handler: async (c) => {
      const body = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
      const code = typeof body?.code === 'string' ? body.code : '';
      const state = typeof body?.state === 'string' ? body.state : '';

      try {
        const credentials = await authService.completeBrowserLogin({ ownerId: getOwner(c).id, code, state });
        return jsonResponse({ connected: true, accountId: credentials.accountId, expires: credentials.expires });
      } catch (loginError) {
        const message = loginError instanceof Error ? loginError.message : String(loginError);
        return jsonResponse({ error: message }, errorStatus(loginError));
      }
    },
  }),
  defineRoute('/agent/chatgpt/auth-status', {
    method: 'GET',
    handler: async (c) => {
      try {
        return jsonResponse(await authService.getAuthStatus(getOwner(c).id));
      } catch (statusError) {
        const message = statusError instanceof Error ? statusError.message : String(statusError);
        return jsonResponse({ error: message }, 500);
      }
    },
  }),
];

export const chatgptAuthRoutes = createChatGPTAuthRoutes();
