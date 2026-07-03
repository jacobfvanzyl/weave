import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { issueClientToolToken } from '../../client-tools/registry';
import { defineRoute } from '../../server/routes';

const getResourceId = (c: any) => {
  const resourceId = c.get('requestContext')?.get(MASTRA_RESOURCE_ID_KEY);
  if (typeof resourceId !== 'string' || !resourceId) throw new Error('Authenticated resource missing');
  return resourceId;
};

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const errorResponse = (c: any, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ error: message }, /Authenticated/.test(message) ? 401 : 400);
};

const getClientToolWsUrl = (c: any) => {
  const configured = process.env.WEAVE_PORTAL_WS_PUBLIC_URL?.replace(/\/+$/, '');
  if (configured) return `${configured}/clients/connect`;

  const url = new URL(c.req.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.port = process.env.WEAVE_PORTAL_WS_PUBLIC_PORT ?? process.env.WEAVE_PORTAL_WS_PORT ?? '4112';
  url.pathname = '/clients/connect';
  url.search = '';
  url.hash = '';
  return url.toString();
};

export const editorContextRoutes = [
  defineRoute('/editor-context/client-token', {
    method: 'POST',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
        const clientId = optionalString(body.clientId);
        const token = issueClientToolToken({ resourceId, clientId });
        return c.json({
          token,
          wsUrl: getClientToolWsUrl(c),
        });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
];
