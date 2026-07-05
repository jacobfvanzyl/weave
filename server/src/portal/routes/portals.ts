import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { defineRoute } from '../../server/routes';
import { productProjectRepository } from '../../products/project-repository';
import { getPortalConnection, listPortalConnections, requestPortalTool } from '../registry';
import { portalRepository } from '../store';

const agentId = 'mageHandAgent';
const projectThreadPrefix = '__project__';
const portalSettingsThreadPrefix = '__portal_settings__';

const createId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const optionalString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

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

const hashText = async (value: string) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes)).slice(0, 12).map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const portalSettingsThreadId = async (resourceId: string) =>
  `${portalSettingsThreadPrefix}${await hashText(resourceId)}`;

const getPrimaryPortalId = async (memory: any, resourceId: string) => {
  const threadId = await portalSettingsThreadId(resourceId);
  const thread = await memory.getThreadById({ threadId }).catch(() => undefined);
  const metadata = thread?.metadata as Record<string, unknown> | undefined;
  return optionalString(metadata?.primaryPortalId);
};

const getStoredPrimaryPortalId = async (memory: any, resourceId: string) => {
  const stored = await portalRepository.getPrimaryPortalId(resourceId);
  if (stored) return stored;

  const legacy = await getPrimaryPortalId(memory, resourceId);
  if (legacy) await portalRepository.setPrimaryPortalId(resourceId, legacy).catch(() => undefined);
  return legacy;
};

const isProjectThread = (thread: { id: string; metadata?: unknown }) => {
  const metadata = thread.metadata as Record<string, unknown> | undefined;
  return thread.id.startsWith(projectThreadPrefix) || metadata?.kind === 'project';
};

const getProjectPortalIds = async (memory: any, resourceId: string) => {
  const portalIds = new Set<string>();
  const projects = await productProjectRepository.list(resourceId, { includeHidden: true });
  for (const project of projects) {
    const projectPortalId = optionalString(project.portalId);
    if (projectPortalId) portalIds.add(projectPortalId);
    const notesPortalId = optionalString(project.notesStorage?.portalId);
    if (notesPortalId) portalIds.add(notesPortalId);
    for (const workspace of project.workspaces) {
      const workspacePortalId = optionalString(workspace?.portalId);
      if (workspacePortalId) portalIds.add(workspacePortalId);
    }
  }
  if (portalIds.size > 0) return [...portalIds];

  const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
  for (const thread of result.threads.filter(isProjectThread)) {
    const metadata = thread.metadata as Record<string, any> | undefined;
    const projectPortalId = optionalString(metadata?.portalId);
    if (projectPortalId) portalIds.add(projectPortalId);
    const notesPortalId = optionalString(metadata?.notesStorage?.portalId);
    if (notesPortalId) portalIds.add(notesPortalId);
    const workspaces = Array.isArray(metadata?.workspaces) ? metadata.workspaces : [];
    for (const workspace of workspaces) {
      const workspacePortalId = optionalString(workspace?.portalId);
      if (workspacePortalId) portalIds.add(workspacePortalId);
    }
  }
  return [...portalIds];
};

const resolvePortalTokenId = async (memory: any, resourceId: string) => {
  const projectPortalIds = await getProjectPortalIds(memory, resourceId);
  if (projectPortalIds.length > 0) return projectPortalIds[0];
  return await getStoredPrimaryPortalId(memory, resourceId) ?? createId('portal');
};

const assertPortalForUser = (portalId: string | undefined, resourceId: string) => {
  if (!portalId) throw new Error('portalId is required for Portal-backed operations');
  const portal = getPortalConnection(portalId);
  if (!portal || portal.userId !== resourceId) throw new Error('portal is offline or unavailable');
  return portal;
};

const errorResponse = (c: any, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[portal]', error);
  return c.json({ error: message }, 500);
};

export const portalRoutes = [
  defineRoute('/portal/:portalId/browse', {
    method: 'GET',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const portalId = c.req.param('portalId');
        assertPortalForUser(portalId, resourceId);
        const rootId = c.req.query('rootId') || 'default';
        const path = c.req.query('path') || '';
        const result = await requestPortalTool({
          portalId,
          tool: 'portal.fs.browse',
          args: { rootId, path },
          timeoutMs: 10_000,
        });
        return c.json(result as any);
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/portal', {
    method: 'GET',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const memory = await getMemory(c);
        const primaryPortalId = await getStoredPrimaryPortalId(memory, resourceId);
        const portals = listPortalConnections(resourceId);
        const effectivePrimaryPortalId = primaryPortalId ?? portals[0]?.portalId;
        return c.json({
          portals: portals.map((portal) => ({ ...portal, primary: portal.portalId === effectivePrimaryPortalId })),
        });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/portal/:portalId/primary', {
    method: 'PATCH',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const portalId = c.req.param('portalId');
        assertPortalForUser(portalId, resourceId);
        await portalRepository.setPrimaryPortalId(resourceId, portalId);
        const portals = listPortalConnections(resourceId).map((portal) => ({
          ...portal,
          primary: portal.portalId === portalId,
        }));
        return c.json({ ok: true, primaryPortalId: portalId, portals });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/portal/token', {
    method: 'POST',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const memory = await getMemory(c);
        const portalId = await resolvePortalTokenId(memory, resourceId);
        const token = `mhb_${crypto.randomUUID().replace(/-/g, '')}`;
        await portalRepository.saveToken({ ownerId: resourceId, portalId, token });
        await portalRepository.setPrimaryPortalId(resourceId, portalId);
        return c.json({ portalId, token });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
];
