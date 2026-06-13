import { registerApiRoute } from '@mastra/core/server';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { getPortalConnection, listPortalConnections, requestPortalTool } from '../portal/registry';
import { issueWindowSessionToken } from '../portal/window-relay';

const windowSessionCapability = 'portal.window.session';
const windowListCapability = 'portal.window.list';

const getResourceId = (c: any) => {
  const resourceId = c.get('requestContext')?.get(MASTRA_RESOURCE_ID_KEY);
  if (typeof resourceId !== 'string' || !resourceId) throw new Error('Authenticated resource missing');
  return resourceId;
};

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const getWindowWsUrl = (c: any) => {
  const configured = process.env.WEAVE_PORTAL_WS_PUBLIC_URL?.replace(/\/+$/, '');
  if (configured) return `${configured}/windows/connect`;

  const url = new URL(c.req.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.port = process.env.WEAVE_PORTAL_WS_PUBLIC_PORT ?? process.env.WEAVE_PORTAL_WS_PORT ?? '4112';
  url.pathname = '/windows/connect';
  url.search = '';
  url.hash = '';
  return url.toString();
};

const assertWindowPortal = (
  resourceId: string,
  portalId?: string,
  capability = windowSessionCapability,
) => {
  const portal = portalId
    ? getPortalConnection(portalId)
    : listPortalConnections(resourceId).find(connection =>
      connection.status === 'online' && connection.capabilities.includes(capability)
    );

  if (!portal || portal.userId !== resourceId) throw new Error('Portal is offline or unavailable.');
  if (!portal.capabilities.includes(capability)) throw new Error('Portal does not support window streaming.');
  return portal;
};

const errorResponse = (c: any, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message) ? 404 : /Portal|window|streaming/i.test(message) ? 400 : 500;
  return c.json({ error: message }, status);
};

export const windowSessionRoutes = [
  registerApiRoute('/window-sessions/windows', {
    method: 'GET',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const portalId = optionalString(c.req.query('portalId'));
        const portal = assertWindowPortal(resourceId, portalId, windowListCapability);
        const result = await requestPortalTool({
          portalId: portal.portalId,
          tool: windowListCapability,
          args: {},
          timeoutMs: 10_000,
        });
        return c.json({ portalId: portal.portalId, ...(result as Record<string, unknown>) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/window-sessions/token', {
    method: 'POST',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
        const portal = assertWindowPortal(resourceId, optionalString(body.portalId));
        const sessionId = `window_${crypto.randomUUID().replace(/-/g, '')}`;
        const windowId = optionalString(body.windowId);
        const token = issueWindowSessionToken({
          resourceId,
          portalId: portal.portalId,
          sessionId,
          windowId,
        });
        return c.json({
          token,
          sessionId,
          portalId: portal.portalId,
          wsUrl: getWindowWsUrl(c),
        });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
];
