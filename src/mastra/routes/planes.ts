import { registerApiRoute } from '@mastra/core/server';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { getPortalConnection, listPortalConnections, requestPortalTool } from '../portal/registry';

const agentId = 'mageHandAgent';
const planeThreadPrefix = '__plane__';
const portalThreadPrefix = '__portal__';

export type Demiplane = {
  id: string;
  planeId: string;
  portalId?: string;
  mountId?: string;
  workspaceKind: 'primary' | 'worktree';
  source?: 'primary' | 'worktrunk' | 'adopted' | 'legacy';
  name: string;
  path?: string;
  branch?: string;
  baseBranch?: string;
  locked?: boolean;
  sortOrder?: number;
  status: 'ready' | 'offline' | 'creating' | 'dirty' | 'missing' | 'virtual' | 'error';
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type Plane = {
  id: string;
  userId: string;
  name: string;
  projectKind: 'standard' | 'git';
  description?: string;
  portalId?: string;
  portalRootId?: string;
  repoPath?: string;
  gitRemote?: string;
  defaultBranch?: string;
  rootPathHint?: string;
  sortOrder?: number;
  agentInstructions?: {
    path: string;
    content: string;
    size?: number;
    updatedAt?: string;
    checkedAt?: string;
  };
  demiplanes: Demiplane[];
  createdAt: string;
  updatedAt: string;
};

const createId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const nowIso = () => new Date().toISOString();
const planeThreadId = (planeId: string) => `${planeThreadPrefix}${planeId}`;
const portalThreadId = (portalId: string) => `${portalThreadPrefix}${portalId}`;

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

const cleanName = (value: unknown) => (typeof value === 'string' ? value.trim().slice(0, 80) : '');
const optionalString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const normalizeBranch = (value: unknown) => optionalString(value)?.replace(/^refs\/heads\//, '');
const normalizePath = (value: unknown) => optionalString(value)?.replace(/\/+$/, '') || undefined;
const timestampString = (value: unknown) => typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : '';

const getTopThreadSortOrder = async (memory: any, resourceId: string, planeId: string, demiplaneId?: string) => {
  const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
  const orders = result.threads
    .filter((thread: any) => {
      const metadata = (thread.metadata ?? {}) as Record<string, unknown>;
      if (metadata.archived === true) return false;
      return metadata.planeId === planeId && metadata.demiplaneId === demiplaneId;
    })
    .map((thread: any) => (thread.metadata as Record<string, unknown> | undefined)?.sortOrder)
    .filter((value: unknown): value is number => typeof value === 'number');
  return orders.length ? Math.min(...orders) - 1 : 0;
};

const isPlaneThread = (thread: { id: string; metadata?: unknown }) => {
  const metadata = thread.metadata as Record<string, unknown> | undefined;
  return thread.id.startsWith(planeThreadPrefix) || metadata?.kind === 'plane';
};

const toPlane = (thread: any): Plane => {
  const metadata = (thread.metadata ?? {}) as Partial<Plane> & { demiplanes?: Demiplane[] };
  const id = typeof metadata.id === 'string' ? metadata.id : thread.id.replace(planeThreadPrefix, '');
  return {
    id,
    userId: thread.resourceId,
    name: typeof metadata.name === 'string' ? metadata.name : thread.title || 'Untitled Plane',
    projectKind: metadata.projectKind === 'git' ? 'git' : 'standard',
    description: metadata.description,
    portalId: metadata.portalId,
    portalRootId: metadata.portalRootId,
    repoPath: metadata.repoPath,
    gitRemote: metadata.gitRemote,
    defaultBranch: metadata.defaultBranch,
    rootPathHint: metadata.rootPathHint,
    sortOrder: typeof metadata.sortOrder === 'number' ? metadata.sortOrder : undefined,
    agentInstructions: metadata.agentInstructions,
    demiplanes: Array.isArray(metadata.demiplanes) ? metadata.demiplanes : [],
    createdAt: typeof thread.createdAt === 'string' ? thread.createdAt : metadata.createdAt ?? nowIso(),
    updatedAt: typeof thread.updatedAt === 'string' ? thread.updatedAt : metadata.updatedAt ?? nowIso(),
  };
};

const savePlane = async (memory: any, resourceId: string, plane: Plane) => {
  const threadId = planeThreadId(plane.id);
  const metadata = { kind: 'plane', ...plane };
  const existing = await memory.getThreadById({ threadId }).catch(() => undefined);

  if (existing) {
    return memory.updateThread({ id: threadId, title: plane.name, metadata });
  }

  return memory.createThread({ resourceId, threadId, title: plane.name, metadata, saveThread: true });
};

const getPlane = async (memory: any, resourceId: string, planeId: string) => {
  const thread = await memory.getThreadById({ threadId: planeThreadId(planeId) }).catch(() => undefined);
  if (!thread || thread.resourceId !== resourceId || !isPlaneThread(thread)) return undefined;
  return toPlane(thread);
};

const errorResponse = (c: any, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[planes]', error);
  return c.json({ error: message }, 500);
};

const assertPortalForUser = (portalId: string | undefined, resourceId: string) => {
  if (!portalId) throw new Error('portalId is required for git projects');
  const portal = getPortalConnection(portalId);
  if (!portal || portal.userId !== resourceId) throw new Error('portal is offline or unavailable');
  return portal;
};

const assertGitPlaneReady = (plane: Plane, resourceId: string) => {
  if (plane.projectKind !== 'git') throw new Error('standard projects cannot have workspaces');
  assertPortalForUser(plane.portalId, resourceId);
  if (!plane.portalRootId || !plane.repoPath) throw new Error('git project is missing Portal repo binding');
};

const isPrimaryDemiplane = (demiplane: Demiplane) => demiplane.locked === true || demiplane.workspaceKind === 'primary' || demiplane.source === 'primary';

const normalizeDemiplanePath = (demiplane: Pick<Demiplane, 'path'>) => normalizePath(demiplane.path)?.toLowerCase();
const normalizeDemiplaneBranch = (demiplane: Pick<Demiplane, 'branch'>) => normalizeBranch(demiplane.branch)?.toLowerCase();

const assertUniqueDemiplane = (plane: Plane, candidate: Pick<Demiplane, 'path' | 'branch'>, ignoreId?: string) => {
  const candidatePath = normalizeDemiplanePath(candidate);
  const candidateBranch = normalizeDemiplaneBranch(candidate);
  const duplicatePath = candidatePath && plane.demiplanes.some(item => item.id !== ignoreId && normalizeDemiplanePath(item) === candidatePath);
  if (duplicatePath) throw new Error('workspace path is already attached to this Plane');
  const duplicateBranch = candidateBranch && plane.demiplanes.some(item => item.id !== ignoreId && normalizeDemiplaneBranch(item) === candidateBranch);
  if (duplicateBranch) throw new Error('workspace branch is already attached to this Plane');
};

const portalToolError = (result: { ok?: boolean; error?: unknown }) => {
  if (result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : 'Portal tool failed');
};

const getActiveThreadsForDemiplane = async (memory: any, resourceId: string, planeId: string, demiplaneId: string) => {
  const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
  return result.threads.filter((thread: any) => {
    const metadata = thread.metadata as Record<string, unknown> | undefined;
    return metadata?.mode === 'plane'
      && metadata.planeId === planeId
      && metadata.demiplaneId === demiplaneId
      && metadata.archived !== true;
  });
};

const createGitPlane = async (c: any, resourceId: string, basePlane: Plane, body: Record<string, unknown>): Promise<Plane> => {
  const portalId = optionalString(body?.portalId);
  const rootId = optionalString(body?.rootId);
  const repoPath = optionalString(body?.repoPath);
  assertPortalForUser(portalId, resourceId);
  if (!rootId) throw new Error('rootId is required for git projects');
  if (!repoPath) throw new Error('repoPath is required for git projects');

  const result = await requestPortalTool({
    portalId: portalId!,
    tool: 'portal.git.inspect',
    args: { rootId, path: repoPath },
  }) as { ok?: boolean; error?: string; git?: Record<string, unknown> };
  if (result.ok === false) throw new Error(result.error ?? 'git inspect failed');

  const git = result.git ?? {};
  const defaultBranch = normalizeBranch(git.defaultBranch) ?? normalizeBranch(git.currentBranch) ?? 'main';
  const repoRoot = normalizePath(git.root);
  const at = basePlane.createdAt;
  const primaryWorkspace: Demiplane = {
    id: createId('demiplane'),
    planeId: basePlane.id,
    workspaceKind: 'primary',
    source: 'primary',
    name: defaultBranch,
    portalId,
    path: repoRoot,
    branch: defaultBranch,
    locked: true,
    sortOrder: 0,
    status: 'ready',
    createdAt: at,
    updatedAt: at,
  };

  return {
    ...basePlane,
    portalId,
    portalRootId: rootId,
    repoPath,
    gitRemote: optionalString(git.remote),
    defaultBranch,
    agentInstructions: typeof git.agentsMd === 'object' && git.agentsMd && typeof (git.agentsMd as any).content === 'string'
      ? {
          path: optionalString((git.agentsMd as any).path) ?? 'AGENTS.md',
          content: String((git.agentsMd as any).content).slice(0, 32_000),
          size: typeof (git.agentsMd as any).size === 'number' ? (git.agentsMd as any).size : undefined,
          updatedAt: optionalString((git.agentsMd as any).updatedAt),
        }
      : undefined,
    demiplanes: [primaryWorkspace],
  };
};

export const planesRoutes = [
  registerApiRoute('/planes', {
    method: 'GET',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const memory = await getMemory(c);
        const result = await memory.listThreads({
          filter: { resourceId },
          perPage: false,
          orderBy: { field: 'updatedAt', direction: 'DESC' },
        });
        const planes = result.threads.filter(isPlaneThread).map(toPlane).sort((a, b) =>
          (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
          || timestampString(b.updatedAt).localeCompare(timestampString(a.updatedAt)),
        );
        return c.json({ planes });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/planes', {
    method: 'POST',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const body = await c.req.json();
        const name = cleanName(body?.name);
        if (!name) return c.json({ error: 'name is required' }, 400);

        const projectKind = body?.projectKind === 'git' ? 'git' : 'standard';
        const at = nowIso();
        const memory = await getMemory(c);
        const basePlane: Plane = {
          id: createId('plane'),
          userId: resourceId,
          name,
          projectKind,
          description: optionalString(body?.description),
          demiplanes: [],
          createdAt: at,
          updatedAt: at,
        };

        const plane = projectKind === 'standard'
          ? basePlane
          : await createGitPlane(c, resourceId, basePlane, body);

        const thread = await savePlane(memory, resourceId, plane);
        return c.json({ plane: toPlane(thread) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/planes/reorder', {
    method: 'PATCH',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const body = await c.req.json();
        const planeIds = Array.isArray(body?.planeIds) ? body.planeIds.filter((id: unknown) => typeof id === 'string') : [];
        const memory = await getMemory(c);
        const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
        const planeThreads = result.threads.filter(isPlaneThread);
        const byId = new Map(planeThreads.map(thread => [toPlane(thread).id, thread]));
        if (planeIds.length !== byId.size || planeIds.some(id => !byId.has(id))) return c.json({ error: 'planeIds must include all planes for this user' }, 400);

        await Promise.all(planeIds.map((planeId, index) => {
          const thread = byId.get(planeId)!;
          const plane = { ...toPlane(thread), sortOrder: index, updatedAt: nowIso() };
          return savePlane(memory, resourceId, plane);
        }));

        const updated = await memory.listThreads({ filter: { resourceId }, perPage: false });
        const planes = updated.threads.filter(isPlaneThread).map(toPlane).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        return c.json({ planes });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/planes/:planeId', {
    method: 'DELETE',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const planeId = c.req.param('planeId');
        const memory = await getMemory(c);
        const plane = await getPlane(memory, resourceId, planeId);
        if (!plane) return c.json({ error: 'plane not found' }, 404);

        const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
        const planeThreads = result.threads.filter(thread => {
          const metadata = thread.metadata as Record<string, unknown> | undefined;
          return metadata?.mode === 'plane' && metadata.planeId === planeId;
        });

        await Promise.all([
          memory.deleteThread(planeThreadId(planeId)),
          ...planeThreads.map(thread => memory.deleteThread(thread.id)),
        ]);

        return c.json({ ok: true });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/planes/:planeId', {
    method: 'GET',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const memory = await getMemory(c);
        const plane = await getPlane(memory, resourceId, c.req.param('planeId'));
        if (!plane) return c.json({ error: 'plane not found' }, 404);
        return c.json({ plane });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/planes/:planeId/demiplanes/discover', {
    method: 'GET',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const planeId = c.req.param('planeId');
        const memory = await getMemory(c);
        const plane = await getPlane(memory, resourceId, planeId);
        if (!plane) return c.json({ error: 'plane not found' }, 404);
        assertGitPlaneReady(plane, resourceId);

        const result = await requestPortalTool({
          portalId: plane.portalId!,
          planeId,
          rootId: plane.portalRootId,
          repoPath: plane.repoPath,
          tool: 'portal.worktrunk.list',
          args: {},
          timeoutMs: 10_000,
        }) as { ok?: boolean; error?: string; worktrees?: Array<Record<string, unknown>> };
        portalToolError(result);
        const worktrees = (result.worktrees ?? []).map(worktree => {
          const path = normalizePath(worktree.path);
          const branch = normalizeBranch(worktree.branch);
          const demiplane = plane.demiplanes.find(item => normalizePath(item.path) === path || normalizeBranch(item.branch) === branch);
          return { ...worktree, path, branch, adopted: Boolean(demiplane), demiplaneId: demiplane?.id };
        });
        return c.json({ worktrees });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/planes/:planeId/demiplanes', {
    method: 'POST',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const planeId = c.req.param('planeId');
        const body = await c.req.json();
        const name = cleanName(body?.name);
        if (!name) return c.json({ error: 'name is required' }, 400);

        const memory = await getMemory(c);
        const plane = await getPlane(memory, resourceId, planeId);
        if (!plane) return c.json({ error: 'plane not found' }, 404);
        assertGitPlaneReady(plane, resourceId);
        assertUniqueDemiplane(plane, { branch: name });

        const result = await requestPortalTool({
          portalId: plane.portalId!,
          planeId,
          rootId: plane.portalRootId,
          repoPath: plane.repoPath,
          tool: 'portal.worktrunk.create',
          args: { branch: name },
          timeoutMs: 60_000,
        }) as { ok?: boolean; error?: string; worktree?: Record<string, unknown> };
        portalToolError(result);

        const worktree = result.worktree ?? {};
        const path = normalizePath(worktree.path);
        const branch = normalizeBranch(worktree.branch) ?? name;
        if (!path) throw new Error('Worktrunk did not return a worktree path');
        assertUniqueDemiplane(plane, { path, branch });

        const at = nowIso();
        const demiplane: Demiplane = {
          id: createId('demiplane'),
          planeId,
          workspaceKind: 'worktree',
          source: 'worktrunk',
          name,
          portalId: plane.portalId,
          path,
          branch,
          status: 'ready',
          locked: false,
          sortOrder: plane.demiplanes.length,
          createdAt: at,
          updatedAt: at,
        };
        const nextPlane = { ...plane, demiplanes: [...plane.demiplanes, demiplane], updatedAt: at };
        const thread = await savePlane(memory, resourceId, nextPlane);
        return c.json({ plane: toPlane(thread), demiplane });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/planes/:planeId/demiplanes/adopt', {
    method: 'POST',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const planeId = c.req.param('planeId');
        const body = await c.req.json();
        const path = optionalString(body?.path);
        if (!path) return c.json({ error: 'path is required' }, 400);

        const memory = await getMemory(c);
        const plane = await getPlane(memory, resourceId, planeId);
        if (!plane) return c.json({ error: 'plane not found' }, 404);
        assertGitPlaneReady(plane, resourceId);

        const result = await requestPortalTool({
          portalId: plane.portalId!,
          planeId,
          rootId: plane.portalRootId,
          repoPath: plane.repoPath,
          tool: 'portal.git.worktree.validate',
          args: { path },
          timeoutMs: 10_000,
        }) as { ok?: boolean; error?: string; worktree?: Record<string, unknown> };
        portalToolError(result);

        const worktree = result.worktree ?? {};
        const normalizedPath = normalizePath(worktree.path);
        const branch = normalizeBranch(worktree.branch);
        if (!normalizedPath) throw new Error('validated worktree did not return a path');
        assertUniqueDemiplane(plane, { path: normalizedPath, branch });

        const at = nowIso();
        const name = cleanName(body?.name) || branch || normalizedPath.split('/').pop() || 'Workspace';
        const demiplane: Demiplane = {
          id: createId('demiplane'),
          planeId,
          workspaceKind: 'worktree',
          source: 'adopted',
          name,
          portalId: plane.portalId,
          path: normalizedPath,
          branch,
          status: 'ready',
          locked: false,
          sortOrder: plane.demiplanes.length,
          createdAt: at,
          updatedAt: at,
        };
        const nextPlane = { ...plane, demiplanes: [...plane.demiplanes, demiplane], updatedAt: at };
        const thread = await savePlane(memory, resourceId, nextPlane);
        return c.json({ plane: toPlane(thread), demiplane });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/planes/:planeId/demiplanes/:demiplaneId', {
    method: 'DELETE',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const planeId = c.req.param('planeId');
        const demiplaneId = c.req.param('demiplaneId');
        const mode = c.req.query('mode') === 'detach' ? 'detach' : 'remove';
        const memory = await getMemory(c);
        const plane = await getPlane(memory, resourceId, planeId);
        if (!plane) return c.json({ error: 'plane not found' }, 404);
        assertGitPlaneReady(plane, resourceId);

        const demiplane = plane.demiplanes.find(item => item.id === demiplaneId);
        if (!demiplane) return c.json({ error: 'demiplane not found' }, 404);
        if (isPrimaryDemiplane(demiplane)) return c.json({ error: 'primary workspace cannot be removed' }, 400);
        const activeThreads = await getActiveThreadsForDemiplane(memory, resourceId, planeId, demiplaneId);
        if (activeThreads.length > 0) return c.json({ error: 'workspace has active threads; archive or delete them before removing the workspace' }, 409);

        if (mode === 'remove') {
          const result = await requestPortalTool({
            portalId: demiplane.portalId ?? plane.portalId!,
            planeId,
            rootId: plane.portalRootId,
            repoPath: plane.repoPath,
            tool: 'portal.worktrunk.remove',
            args: { branch: demiplane.branch, path: demiplane.path },
            timeoutMs: 60_000,
          }) as { ok?: boolean; error?: string };
          portalToolError(result);
        }

        const nextPlane = { ...plane, demiplanes: plane.demiplanes.filter(item => item.id !== demiplaneId), updatedAt: nowIso() };
        const thread = await savePlane(memory, resourceId, nextPlane);
        return c.json({ plane: toPlane(thread), demiplane, mode });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/planes/:planeId/demiplanes/reorder', {
    method: 'PATCH',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const planeId = c.req.param('planeId');
        const body = await c.req.json();
        const demiplaneIds = Array.isArray(body?.demiplaneIds) ? body.demiplaneIds.filter((id: unknown) => typeof id === 'string') : [];
        const memory = await getMemory(c);
        const plane = await getPlane(memory, resourceId, planeId);
        if (!plane) return c.json({ error: 'plane not found' }, 404);
        const existingIds = new Set(plane.demiplanes.map(demiplane => demiplane.id));
        if (demiplaneIds.length !== existingIds.size || demiplaneIds.some(id => !existingIds.has(id))) {
          return c.json({ error: 'demiplaneIds must include all demiplanes for this plane' }, 400);
        }

        const order = new Map(demiplaneIds.map((id, index) => [id, index]));
        const nextPlane = {
          ...plane,
          demiplanes: plane.demiplanes.map(demiplane => ({ ...demiplane, sortOrder: order.get(demiplane.id) ?? demiplane.sortOrder })),
          updatedAt: nowIso(),
        };
        const thread = await savePlane(memory, resourceId, nextPlane);
        return c.json({ plane: toPlane(thread) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/planes/:planeId/threads', {
    method: 'POST',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const planeId = c.req.param('planeId');
        const body = await c.req.json();
        const threadId = typeof body?.threadId === 'string' ? body.threadId : createId('thread');
        const title = typeof body?.title === 'string' ? body.title : '...';
        const memory = await getMemory(c);
        const plane = await getPlane(memory, resourceId, planeId);
        if (!plane) return c.json({ error: 'plane not found' }, 404);

        const at = nowIso();
        const requestedDemiplaneId = typeof body?.demiplaneId === 'string' ? body.demiplaneId : undefined;
        const demiplane = requestedDemiplaneId
          ? plane.demiplanes.find(item => item.id === requestedDemiplaneId)
          : undefined;
        if (requestedDemiplaneId && !demiplane) return c.json({ error: 'demiplane not found' }, 404);
        if (plane.projectKind === 'standard' && requestedDemiplaneId) return c.json({ error: 'standard projects cannot have workspace threads' }, 400);
        if (plane.projectKind === 'git' && !demiplane) return c.json({ error: 'git project threads must belong to a workspace' }, 400);

        const sortOrder = await getTopThreadSortOrder(memory, resourceId, planeId, demiplane?.id);
        const metadata = demiplane
          ? { mode: 'plane', planeId, demiplaneId: demiplane.id, sortOrder }
          : { mode: 'plane', planeId, sortOrder };
        const thread = await memory.createThread({
          resourceId,
          threadId,
          title,
          metadata,
          saveThread: true,
        });

        await savePlane(memory, resourceId, { ...plane, updatedAt: at });
        return c.json({ thread, demiplane });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/portals/:portalId/browse', {
    method: 'GET',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const portalId = c.req.param('portalId');
        assertPortalForUser(portalId, resourceId);
        const rootId = c.req.query('rootId') || 'default';
        const path = c.req.query('path') || '';
        const result = await requestPortalTool({
          portalId,
          tool: 'portal.fs.list',
          args: { rootId, path },
          timeoutMs: 10_000,
        });
        return c.json(result as any);
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/portals', {
    method: 'GET',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        return c.json({ portals: listPortalConnections(resourceId) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/portals/token', {
    method: 'POST',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const portalId = createId('portal');
        const token = `mhb_${crypto.randomUUID().replace(/-/g, '')}`;
        const memory = await getMemory(c);
        await memory.createThread({
          resourceId,
          threadId: portalThreadId(portalId),
          title: `Portal ${portalId.slice(-6)}`,
          metadata: { kind: 'portal-token', portalId, token, status: 'issued', createdAt: nowIso() },
          saveThread: true,
        });
        return c.json({ portalId, token });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
];
