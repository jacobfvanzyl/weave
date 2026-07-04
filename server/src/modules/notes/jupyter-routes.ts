import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { defineRoute } from '../../server/routes';
import { getPortalConnection, requestPortalTool } from '../../portal/registry';
import { issueJupyterSessionToken } from '../../portal/jupyter-relay';
import { type NotesVaultResolverDependencies, parseNotesVaultTarget, resolveNotesVault } from './storage/resolver';

const agentId = 'mageHandAgent';
const jupyterPreparationTimeoutMs = 120_000;

type NotesJupyterRouteDeps = NotesVaultResolverDependencies;

type NotesJupyterAction = 'status' | 'kernelspecs' | 'session';

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const getMemory = async (c: any) => {
  const mastra = c.get('mastra');
  const agent = await mastra?.getAgent(agentId);
  const memory = await agent?.getMemory();
  if (!memory) throw new Error(`${agentId} has no memory configured`);
  return memory;
};

const getResourceId = (c: any) => {
  const resourceId = c.get('requestContext')?.get(MASTRA_RESOURCE_ID_KEY);
  if (typeof resourceId !== 'string' || !resourceId) throw new Error('Authenticated resource missing');
  return resourceId;
};

const getNotesJupyterWsUrl = (c: any) => {
  const configured = process.env.WEAVE_PORTAL_WS_PUBLIC_URL?.replace(/\/+$/, '');
  if (configured) return `${configured}/jupyter/connect`;

  const url = new URL(c.req.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.port = process.env.WEAVE_PORTAL_WS_PUBLIC_PORT ?? process.env.WEAVE_PORTAL_WS_PORT ?? '4112';
  url.pathname = '/jupyter/connect';
  url.search = '';
  url.hash = '';
  return url.toString();
};

const errorResponse = (c: any, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message)
    ? 404
    : /Portal|Notes|Project|workspace|Jupyter|storage/.test(message)
    ? 400
    : 500;
  return c.json({ error: message }, status);
};

const portalToolForAction = (action: NotesJupyterAction) =>
  action === 'kernelspecs' ? 'portal.jupyter.kernelspecs' : `portal.jupyter.${action}`;

const cleanPortalResult = (result: unknown) => {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  if (record.ok === false) {
    throw new Error(typeof record.error === 'string' ? record.error : 'Portal Jupyter request failed.');
  }
  const { id: _id, type: _type, ...body } = record;
  return body;
};

const resolvePortalNotesTarget = async (
  c: any,
  body: Record<string, unknown>,
  deps: NotesJupyterRouteDeps,
) => {
  const resourceId = getResourceId(c);
  const memory = await getMemory(c);
  const target = parseNotesVaultTarget(body);
  const resolved = await resolveNotesVault(memory, resourceId, target, deps);
  const storage = resolved.binding.storage;

  if (storage.kind !== 'portal' || !storage.portalId) {
    throw new Error('Jupyter execution is only available for Portal-backed Notes storage.');
  }

  const portal = getPortalConnection(storage.portalId);
  if (!portal || portal.userId !== resourceId) throw new Error('Portal is offline or unavailable.');

  return {
    resourceId,
    portal,
    target: {
      portalId: storage.portalId,
      projectId: resolved.binding.projectId,
      workspaceId: resolved.binding.workspaceId,
      rootId: storage.rootId,
      repoPath: storage.vaultPath,
      workspacePath: storage.workspacePath,
    },
  };
};

const requireCapability = (portal: { capabilities: string[] }, capability: string) => {
  if (!portal.capabilities.includes(capability)) {
    throw new Error('The connected Portal does not support Jupyter execution yet.');
  }
};

const handleNotesJupyterRoute = async (
  c: any,
  action: NotesJupyterAction,
  timeoutMs = 10_000,
  deps: NotesJupyterRouteDeps = {},
) => {
  try {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const { resourceId, portal, target } = await resolvePortalNotesTarget(c, body, deps);
    const tool = portalToolForAction(action);
    requireCapability(portal, tool);

    const path = optionalString(body.path);
    const kernelName = optionalString(body.kernelName);
    const result = cleanPortalResult(
      await requestPortalTool({
        ...target,
        tool,
        args: {
          path,
          kernelName,
          language: optionalString(body.language),
        },
        timeoutMs,
      }),
    ) as Record<string, any>;

    if (action !== 'session') return c.json(result);

    const sessionId = optionalString(result.sessionId);
    if (!sessionId) throw new Error('Portal Jupyter session response did not include a sessionId.');
    if (!path) throw new Error('path is required.');

    const token = issueJupyterSessionToken({
      resourceId,
      ...target,
      sessionId,
      path,
      kernelName: optionalString(result.kernelName) ?? kernelName,
    });

    return c.json({
      ...result,
      token,
      portalId: target.portalId,
      wsUrl: getNotesJupyterWsUrl(c),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
};

export const notesJupyterRoutes = [
  defineRoute('/notes/jupyter/status', {
    method: 'POST',
    handler: async (c) => handleNotesJupyterRoute(c, 'status'),
  }),
  defineRoute('/notes/jupyter/kernelspecs', {
    method: 'POST',
    handler: async (c) => handleNotesJupyterRoute(c, 'kernelspecs', jupyterPreparationTimeoutMs),
  }),
  defineRoute('/notes/jupyter/session', {
    method: 'POST',
    handler: async (c) => handleNotesJupyterRoute(c, 'session', jupyterPreparationTimeoutMs),
  }),
];

export const __notesJupyterRoutesTest = {
  handleNotesJupyterRoute,
  resolvePortalNotesTarget,
};
