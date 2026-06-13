import { registerApiRoute } from '@mastra/core/server';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { collectWorkspaceGitStatesForProject, gitFieldsFromWorktree, stripProjectGitState } from '../projects/git-state';
import { getPortalConnection, listPortalConnections, requestPortalTool } from '../portal/registry';

const agentId = 'mageHandAgent';
const projectThreadPrefix = '__project__';
const portalThreadPrefix = '__portal__';
const portalSettingsThreadPrefix = '__portal_settings__';
const adHocProjectPrefix = 'project_ad_hoc_';
const adHocWorkspacePrefix = 'workspace_ad_hoc_';

export type Workspace = {
  id: string;
  projectId: string;
  portalId?: string;
  mountId?: string;
  workspaceKind: 'primary' | 'worktree';
  source?: 'primary' | 'git' | 'notes' | 'adopted' | 'legacy';
  name: string;
  path?: string;
  branch?: string;
  head?: string;
  detached?: boolean;
  baseBranch?: string;
  locked?: boolean;
  sortOrder?: number;
  status: 'ready' | 'offline' | 'creating' | 'dirty' | 'missing' | 'virtual' | 'error';
  lastError?: string;
  hidden?: boolean;
  systemKind?: 'adHoc';
  createdAt: string;
  updatedAt: string;
};

export type Project = {
  id: string;
  userId: string;
  name: string;
  projectKind: 'general' | 'git' | 'notes';
  description?: string;
  portalId?: string;
  portalRootId?: string;
  repoPath?: string;
  vaultPath?: string;
  gitRemote?: string;
  defaultBranch?: string;
  rootPathHint?: string;
  defaultProfileId?: string;
  sortOrder?: number;
  agentInstructions?: {
    path: string;
    content: string;
    size?: number;
    updatedAt?: string;
    checkedAt?: string;
  };
  hidden?: boolean;
  systemKind?: 'adHoc';
  workspaces: Workspace[];
  createdAt: string;
  updatedAt: string;
};

type BranchOption = {
  name: string;
  ref: string;
  kind: 'local' | 'remote';
  current?: boolean;
};

const createId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const nowIso = () => new Date().toISOString();
const projectThreadId = (projectId: string) => `${projectThreadPrefix}${projectId}`;
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
const normalizeBranchOption = (value: unknown): BranchOption | undefined => {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  const name = optionalString(record?.name);
  const ref = optionalString(record?.ref);
  if (!name || !ref) return undefined;
  return {
    name,
    ref,
    kind: record?.kind === 'remote' ? 'remote' : 'local',
    current: record?.current === true ? true : undefined,
  };
};

const getTopThreadSortOrder = async (memory: any, resourceId: string, projectId: string, workspaceId?: string) => {
  const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
  const orders = result.threads
    .filter((thread: any) => {
      const metadata = (thread.metadata ?? {}) as Record<string, unknown>;
      if (metadata.archived === true) return false;
      return metadata.projectId === projectId && metadata.workspaceId === workspaceId;
    })
    .map((thread: any) => (thread.metadata as Record<string, unknown> | undefined)?.sortOrder)
    .filter((value: unknown): value is number => typeof value === 'number');
  return orders.length ? Math.min(...orders) - 1 : 0;
};

const isProjectThread = (thread: { id: string; metadata?: unknown }) => {
  const metadata = thread.metadata as Record<string, unknown> | undefined;
  return thread.id.startsWith(projectThreadPrefix) || metadata?.kind === 'project';
};

const isVisibleUserProject = (project: Project) => !project.hidden && project.systemKind !== 'adHoc';

const toProject = (thread: any): Project => {
  const metadata = (thread.metadata ?? {}) as Partial<Project> & { workspaces?: Workspace[] };
  const id = typeof metadata.id === 'string' ? metadata.id : thread.id.replace(projectThreadPrefix, '');
  return stripProjectGitState({
    id,
    userId: thread.resourceId,
    name: typeof metadata.name === 'string' ? metadata.name : thread.title || 'Untitled Project',
    projectKind: metadata.projectKind === 'git' || metadata.projectKind === 'notes' ? metadata.projectKind : 'general',
    description: metadata.description,
    portalId: metadata.portalId,
    portalRootId: metadata.portalRootId,
    repoPath: metadata.repoPath,
    vaultPath: metadata.vaultPath,
    gitRemote: metadata.gitRemote,
    defaultBranch: metadata.defaultBranch,
    rootPathHint: metadata.rootPathHint,
    defaultProfileId: metadata.defaultProfileId,
    sortOrder: typeof metadata.sortOrder === 'number' ? metadata.sortOrder : undefined,
    agentInstructions: metadata.agentInstructions,
    hidden: metadata.hidden === true,
    systemKind: metadata.systemKind === 'adHoc' ? 'adHoc' : undefined,
    workspaces: Array.isArray(metadata.workspaces) ? metadata.workspaces : [],
    createdAt: typeof thread.createdAt === 'string' ? thread.createdAt : metadata.createdAt ?? nowIso(),
    updatedAt: typeof thread.updatedAt === 'string' ? thread.updatedAt : metadata.updatedAt ?? nowIso(),
  });
};

const saveProject = async (memory: any, resourceId: string, project: Project) => {
  const threadId = projectThreadId(project.id);
  const metadata = { kind: 'project', ...stripProjectGitState(project) };
  const existing = await memory.getThreadById({ threadId }).catch(() => undefined);

  if (existing) {
    return memory.updateThread({ id: threadId, title: project.name, metadata });
  }

  return memory.createThread({ resourceId, threadId, title: project.name, metadata, saveThread: true });
};

const getProject = async (memory: any, resourceId: string, projectId: string) => {
  const thread = await memory.getThreadById({ threadId: projectThreadId(projectId) }).catch(() => undefined);
  if (!thread || thread.resourceId !== resourceId || !isProjectThread(thread)) return undefined;
  return toProject(thread);
};

const errorResponse = (c: any, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[projects]', error);
  return c.json({ error: message }, 500);
};

const assertPortalForUser = (portalId: string | undefined, resourceId: string) => {
  if (!portalId) throw new Error('portalId is required for Portal-backed projects');
  const portal = getPortalConnection(portalId);
  if (!portal || portal.userId !== resourceId) throw new Error('portal is offline or unavailable');
  return portal;
};

const assertGitProjectReady = (project: Project, resourceId: string) => {
  if (project.projectKind !== 'git') throw new Error('only git projects can have git workspaces');
  assertPortalForUser(project.portalId, resourceId);
  if (!project.portalRootId || !project.repoPath) throw new Error('git project is missing Portal repo binding');
};

const isPrimaryWorkspace = (workspace: Workspace) => workspace.locked === true || workspace.workspaceKind === 'primary' || workspace.source === 'primary';

const normalizeRemote = (value: unknown) => optionalString(value)?.replace(/\.git$/, '').toLowerCase();
const normalizeWorkspacePath = (workspace: Pick<Workspace, 'path'>) => normalizePath(workspace.path)?.toLowerCase();
const assertUniqueWorkspace = (project: Project, candidate: Pick<Workspace, 'path'>, ignoreId?: string) => {
  const candidatePath = normalizeWorkspacePath(candidate);
  const duplicatePath = candidatePath && project.workspaces.some(item => item.id !== ignoreId && normalizeWorkspacePath(item) === candidatePath);
  if (duplicatePath) throw new Error('workspace path is already attached to this Project');
};

const portalToolError = (result: { ok?: boolean; error?: unknown }) => {
  if (result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : 'Portal tool failed');
};

const hashText = async (value: string) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes)).slice(0, 12).map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const portalSettingsThreadId = async (resourceId: string) => `${portalSettingsThreadPrefix}${await hashText(resourceId)}`;

const getPrimaryPortalId = async (memory: any, resourceId: string) => {
  const threadId = await portalSettingsThreadId(resourceId);
  const thread = await memory.getThreadById({ threadId }).catch(() => undefined);
  const metadata = thread?.metadata as Record<string, unknown> | undefined;
  return typeof metadata?.primaryPortalId === 'string' ? metadata.primaryPortalId : undefined;
};

const setPrimaryPortalId = async (memory: any, resourceId: string, portalId: string) => {
  const threadId = await portalSettingsThreadId(resourceId);
  const now = nowIso();
  const metadata = { kind: 'portal-settings', primaryPortalId: portalId, updatedAt: now };
  const existing = await memory.getThreadById({ threadId }).catch(() => undefined);
  if (existing) return memory.updateThread({ id: threadId, title: 'Portal settings', metadata });
  return memory.createThread({ resourceId, threadId, title: 'Portal settings', metadata, saveThread: true });
};

const pathBasename = (path: string) => path.split('/').filter(Boolean).pop() || path;

const validateAdHocPath = async (resourceId: string, portalId: string, workspacePath: string) => {
  assertPortalForUser(portalId, resourceId);
  const result = await requestPortalTool({
    portalId,
    tool: 'portal.fs.stat',
    args: { path: workspacePath },
    timeoutMs: 10_000,
  }) as { ok?: boolean; error?: string; path?: string; isDirectory?: boolean };
  portalToolError(result);
  const realPath = normalizePath(result.path);
  if (!realPath || result.isDirectory !== true) throw new Error('Ad-hoc path must be an existing directory reachable by Portal');
  return realPath;
};

const ensureAdHocWorkspace = async (memory: any, resourceId: string, portalId: string, workspacePath: string) => {
  const realPath = await validateAdHocPath(resourceId, portalId, workspacePath);
  const adHocProjectId = `${adHocProjectPrefix}${await hashText(resourceId)}`;
  const workspaceId = `${adHocWorkspacePrefix}${await hashText(`${portalId}:${realPath}`)}`;
  const at = nowIso();
  const existing = await getProject(memory, resourceId, adHocProjectId);
  const project: Project = existing ?? {
    id: adHocProjectId,
    userId: resourceId,
    name: 'Ad-hoc',
    projectKind: 'general',
    hidden: true,
    systemKind: 'adHoc',
    workspaces: [],
    createdAt: at,
    updatedAt: at,
  };
  const workspace = project.workspaces.find(item => item.id === workspaceId);
  if (workspace) return { project, workspace };

  const nextWorkspace: Workspace = {
    id: workspaceId,
    projectId: adHocProjectId,
    portalId,
    workspaceKind: 'primary',
    source: 'adopted',
    name: pathBasename(realPath),
    path: realPath,
    locked: true,
    status: 'ready',
    hidden: true,
    systemKind: 'adHoc',
    sortOrder: project.workspaces.length,
    createdAt: at,
    updatedAt: at,
  };
  const nextProject = { ...project, hidden: true, systemKind: 'adHoc' as const, workspaces: [...project.workspaces, nextWorkspace], updatedAt: at };
  await saveProject(memory, resourceId, nextProject);
  return { project: nextProject, workspace: nextWorkspace };
};

const getAllProjects = async (memory: any, resourceId: string) => {
  const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
  return result.threads.filter(isProjectThread).map(toProject);
};

const getActiveThreadsForWorkspace = async (memory: any, resourceId: string, projectId: string, workspaceId: string) => {
  const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
  return result.threads.filter((thread: any) => {
    const metadata = thread.metadata as Record<string, unknown> | undefined;
    return metadata?.mode === 'project'
      && metadata.projectId === projectId
      && metadata.workspaceId === workspaceId
      && metadata.archived !== true;
  });
};

const createGitProject = async (c: any, resourceId: string, baseProject: Project, body: Record<string, unknown>): Promise<Project> => {
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
  const at = baseProject.createdAt;
  const primaryWorkspace: Workspace = {
    id: createId('workspace'),
    projectId: baseProject.id,
    workspaceKind: 'primary',
    source: 'primary',
    name: defaultBranch,
    portalId,
    path: repoRoot,
    locked: true,
    sortOrder: 0,
    status: 'ready',
    createdAt: at,
    updatedAt: at,
  };

  return {
    ...baseProject,
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
    workspaces: [primaryWorkspace],
  };
};

const createNotesProject = async (_c: any, resourceId: string, baseProject: Project, body: Record<string, unknown>): Promise<Project> => {
  const portalId = optionalString(body?.portalId);
  const rootId = optionalString(body?.rootId);
  const vaultPath = optionalString(body?.vaultPath ?? body?.repoPath) ?? '';
  assertPortalForUser(portalId, resourceId);
  if (!rootId) throw new Error('rootId is required for notes projects');

  const result = await requestPortalTool({
    portalId: portalId!,
    tool: 'portal.fs.list',
    args: { rootId, path: vaultPath },
    timeoutMs: 10_000,
  }) as { ok?: boolean; error?: string; path?: string; realPath?: string };
  portalToolError(result);
  const realPath = normalizePath(result.realPath);
  if (!realPath) throw new Error('Selected vault folder could not be resolved.');
  const at = baseProject.createdAt;
  const primaryWorkspace: Workspace = {
    id: createId('workspace'),
    projectId: baseProject.id,
    workspaceKind: 'primary',
    source: 'notes',
    name: pathBasename(realPath),
    portalId,
    path: realPath,
    locked: true,
    sortOrder: 0,
    status: 'ready',
    createdAt: at,
    updatedAt: at,
  };

  return {
    ...baseProject,
    portalId,
    portalRootId: rootId,
    vaultPath: typeof result.path === 'string' ? result.path : vaultPath,
    workspaces: [primaryWorkspace],
  };
};

export const projectRoutes = [
  registerApiRoute('/projects', {
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
        const projects: Project[] = result.threads.filter(isProjectThread).map((thread: any) => toProject(thread)).filter(isVisibleUserProject).sort((a: Project, b: Project) =>
          (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
          || timestampString(b.updatedAt).localeCompare(timestampString(a.updatedAt)),
        );
        return c.json({ projects });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/projects/workspaces/git-state', {
    method: 'GET',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const memory = await getMemory(c);
        const checkedAt = nowIso();
        const projects = (await getAllProjects(memory, resourceId))
          .filter(project => project.projectKind === 'git' && isVisibleUserProject(project));
        const states = (await Promise.all(projects.map(project =>
          collectWorkspaceGitStatesForProject(project, resourceId, checkedAt, requestPortalTool, getPortalConnection),
        ))).flat();
        return c.json({ states });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/projects', {
    method: 'POST',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const body = await c.req.json();
        const name = cleanName(body?.name);
        if (!name) return c.json({ error: 'name is required' }, 400);

        const projectKind = body?.projectKind === 'git' || body?.projectKind === 'notes' ? body.projectKind : 'general';
        const at = nowIso();
        const memory = await getMemory(c);
        const baseProject: Project = {
          id: createId('project'),
          userId: resourceId,
          name,
          projectKind,
          description: optionalString(body?.description),
          workspaces: [],
          createdAt: at,
          updatedAt: at,
        };

        const project = projectKind === 'general'
          ? baseProject
          : projectKind === 'git'
          ? await createGitProject(c, resourceId, baseProject, body)
          : await createNotesProject(c, resourceId, baseProject, body);

        const thread = await saveProject(memory, resourceId, project);
        return c.json({ project: toProject(thread) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/projects/reorder', {
    method: 'PATCH',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const body = await c.req.json();
        const projectIds = Array.isArray(body?.projectIds) ? body.projectIds.filter((id: unknown) => typeof id === 'string') : [];
        const memory = await getMemory(c);
        const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
        const visibleProjectEntries: Array<{ project: Project; thread: any }> = result.threads
          .filter(isProjectThread)
          .map((thread: any) => ({ project: toProject(thread), thread }))
          .filter((entry: { project: Project; thread: any }) => isVisibleUserProject(entry.project));
        const byId = new Map<string, any>(visibleProjectEntries.map(entry => [entry.project.id, entry.thread]));
        if (projectIds.length !== byId.size || projectIds.some((id: string) => !byId.has(id))) return c.json({ error: 'projectIds must include all visible projects for this user' }, 400);

        await Promise.all(projectIds.map((projectId: string, index: number) => {
          const thread = byId.get(projectId)!;
          const project = { ...toProject(thread), sortOrder: index, updatedAt: nowIso() };
          return saveProject(memory, resourceId, project);
        }));

        const updated = await memory.listThreads({ filter: { resourceId }, perPage: false });
        const projects: Project[] = updated.threads.filter(isProjectThread).map((thread: any) => toProject(thread)).filter(isVisibleUserProject).sort((a: Project, b: Project) =>
          (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
          || timestampString(b.updatedAt).localeCompare(timestampString(a.updatedAt)),
        );
        return c.json({ projects });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/projects/:projectId', {
    method: 'DELETE',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);

        const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
        const projectThreads = result.threads.filter(thread => {
          const metadata = thread.metadata as Record<string, unknown> | undefined;
          return metadata?.mode === 'project' && metadata.projectId === projectId;
        });

        await Promise.all([
          memory.deleteThread(projectThreadId(projectId)),
          ...projectThreads.map(thread => memory.deleteThread(thread.id)),
        ]);

        return c.json({ ok: true });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/projects/:projectId', {
    method: 'GET',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, c.req.param('projectId'));
        if (!project) return c.json({ error: 'project not found' }, 404);
        return c.json({ project });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/projects/:projectId/profile', {
    method: 'PATCH',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const body = await c.req.json();
        const hasProfileId = body?.profileId === null || typeof body?.profileId === 'string';
        if (!hasProfileId) return c.json({ error: 'profileId is required' }, 400);

        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);

        const profileId = optionalString(body.profileId);
        const nextProject = {
          ...project,
          ...(profileId ? { defaultProfileId: profileId } : { defaultProfileId: undefined }),
          updatedAt: nowIso(),
        };
        const thread = await saveProject(memory, resourceId, nextProject);
        return c.json({ project: toProject(thread) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/projects/:projectId/branches', {
    method: 'GET',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);
        assertGitProjectReady(project, resourceId);

        const result = await requestPortalTool({
          portalId: project.portalId!,
          projectId,
          rootId: project.portalRootId,
          repoPath: project.repoPath,
          tool: 'portal.git.branches.list',
          args: {},
          timeoutMs: 10_000,
        }) as { ok?: boolean; error?: string; branches?: unknown[] };
        portalToolError(result);
        const branches = Array.isArray(result.branches)
          ? result.branches.flatMap(branch => normalizeBranchOption(branch) ?? [])
          : [];
        return c.json({ branches });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/projects/resolve-workspace', {
    method: 'POST',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const body = await c.req.json();
        const workspacePath = normalizePath(body?.workspacePath ?? body?.gitTopLevel);
        const remote = normalizeRemote(body?.remote);
        const createThread = body?.createThread !== false;
        if (!workspacePath) return c.json({ error: 'workspacePath or gitTopLevel is required' }, 400);

        const memory = await getMemory(c);
        const allowAdHoc = body?.allowAdHoc === true;
        const portalId = optionalString(body?.portalId);
        const projects = (await getAllProjects(memory, resourceId)).filter(project => project.projectKind === 'git' && !project.hidden && project.systemKind !== 'adHoc');
        const exact = projects.flatMap(project => project.workspaces.map(workspace => ({ project, workspace })))
          .find(item => normalizeWorkspacePath(item.workspace) === workspacePath.toLowerCase());

        let resolvedProject = exact?.project;
        let resolvedWorkspace = exact?.workspace;
        let validation: Record<string, unknown> | undefined;
        let adopted = false;
        let offline = Boolean(resolvedProject?.portalId && !getPortalConnection(resolvedProject.portalId));

        if (!resolvedProject) {
          for (const project of projects) {
            if (remote && normalizeRemote(project.gitRemote) !== remote) continue;
            if (!project.portalId) continue;
            try {
              const result = await requestPortalTool({
                portalId: project.portalId,
                projectId: project.id,
                rootId: project.portalRootId,
                repoPath: project.repoPath,
                tool: 'portal.git.worktree.validate',
                args: { path: workspacePath },
                timeoutMs: 10_000,
              }) as { ok?: boolean; error?: string; worktree?: Record<string, unknown> };
              portalToolError(result);
              validation = result.worktree ?? {};
              const validatedPath = normalizePath(validation.path) ?? workspacePath;
              resolvedProject = project;
              resolvedWorkspace = project.workspaces.find(item => normalizeWorkspacePath(item) === validatedPath.toLowerCase());

              if (!resolvedWorkspace) {
                assertUniqueWorkspace(project, { path: validatedPath });
                const at = nowIso();
                const gitFields = gitFieldsFromWorktree(validation);
                resolvedWorkspace = {
                  id: createId('workspace'),
                  projectId: project.id,
                  workspaceKind: 'worktree',
                  source: 'adopted',
                  name: gitFields.branch || validatedPath.split('/').pop() || 'Workspace',
                  portalId: project.portalId,
                  path: validatedPath,
                  status: 'ready',
                  locked: false,
                  sortOrder: project.workspaces.length,
                  createdAt: at,
                  updatedAt: at,
                };
                resolvedProject = { ...project, workspaces: [...project.workspaces, resolvedWorkspace], updatedAt: at };
                await saveProject(memory, resourceId, resolvedProject);
                adopted = true;
              }
              break;
            } catch (error) {
              if (error instanceof Error && error.message === 'Portal is offline') offline = true;
            }
          }
        }

        if (!resolvedProject || !resolvedWorkspace) {
          if (allowAdHoc && portalId) {
            const adHoc = await ensureAdHocWorkspace(memory, resourceId, portalId, workspacePath);
            return c.json({ resolved: true, adHoc: true, offline: false, project: adHoc.project, workspace: adHoc.workspace });
          }
          const remoteMatches = remote ? projects.filter(project => normalizeRemote(project.gitRemote) === remote) : [];
          return c.json({
            resolved: false,
            offline,
            needsConfirmation: remoteMatches.length > 0,
            candidates: remoteMatches.map(project => ({ projectId: project.id, name: project.name, gitRemote: project.gitRemote })),
          });
        }

        let thread: unknown;
        if (createThread) {
          const sortOrder = await getTopThreadSortOrder(memory, resourceId, resolvedProject.id, resolvedWorkspace.id);
          thread = await memory.createThread({
            resourceId,
            threadId: createId('thread'),
            title: '...',
            metadata: { mode: 'project', projectId: resolvedProject.id, workspaceId: resolvedWorkspace.id, sortOrder },
            saveThread: true,
          });
        }

        return c.json({ resolved: true, offline, adopted, project: resolvedProject, workspace: resolvedWorkspace, thread, validation });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/projects/:projectId/workspaces/discover', {
    method: 'GET',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);
        assertGitProjectReady(project, resourceId);

        const result = await requestPortalTool({
          portalId: project.portalId!,
          projectId,
          rootId: project.portalRootId,
          repoPath: project.repoPath,
          tool: 'portal.git.worktree.list',
          args: {},
          timeoutMs: 10_000,
        }) as { ok?: boolean; error?: string; worktrees?: Array<Record<string, unknown>> };
        portalToolError(result);
        const worktrees = (result.worktrees ?? []).map(worktree => {
          const path = normalizePath(worktree.path);
          const branch = normalizeBranch(worktree.branch);
          const workspace = project.workspaces.find(item => normalizePath(item.path) === path);
          return { ...worktree, path, branch, adopted: Boolean(workspace), workspaceId: workspace?.id };
        });
        return c.json({ worktrees });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/projects/:projectId/workspaces', {
    method: 'POST',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const body = await c.req.json();
        const name = cleanName(body?.name);
        if (!name) return c.json({ error: 'name is required' }, 400);
        const mode = body?.mode === 'existingBranch' || body?.mode === 'detached' ? body.mode : 'newBranch';
        const branch = normalizeBranch(body?.branch);
        const base = normalizeBranch(body?.base);
        if (mode !== 'detached' && !branch) return c.json({ error: 'branch is required for branch-backed workspaces' }, 400);

        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);
        assertGitProjectReady(project, resourceId);

        const result = await requestPortalTool({
          portalId: project.portalId!,
          projectId,
          rootId: project.portalRootId,
          repoPath: project.repoPath,
          tool: 'portal.git.worktree.create',
          args: { mode, name, branch, base, path: optionalString(body?.path) },
          timeoutMs: 60_000,
        }) as { ok?: boolean; error?: string; worktree?: Record<string, unknown> };
        portalToolError(result);

        const worktree = result.worktree ?? {};
        const path = normalizePath(worktree.path);
        if (!path) throw new Error('Portal did not return a workspace path');
        assertUniqueWorkspace(project, { path });

        const at = nowIso();
        const workspace: Workspace = {
          id: createId('workspace'),
          projectId,
          workspaceKind: 'worktree',
          source: 'git',
          name,
          portalId: project.portalId,
          path,
          baseBranch: base,
          status: 'ready',
          locked: false,
          sortOrder: project.workspaces.length,
          createdAt: at,
          updatedAt: at,
        };
        const nextProject = { ...project, workspaces: [...project.workspaces, workspace], updatedAt: at };
        const thread = await saveProject(memory, resourceId, nextProject);
        return c.json({ project: toProject(thread), workspace });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/projects/:projectId/workspaces/adopt', {
    method: 'POST',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const body = await c.req.json();
        const path = optionalString(body?.path);
        if (!path) return c.json({ error: 'path is required' }, 400);

        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);
        assertGitProjectReady(project, resourceId);

        const result = await requestPortalTool({
          portalId: project.portalId!,
          projectId,
          rootId: project.portalRootId,
          repoPath: project.repoPath,
          tool: 'portal.git.worktree.validate',
          args: { path },
          timeoutMs: 10_000,
        }) as { ok?: boolean; error?: string; worktree?: Record<string, unknown> };
        portalToolError(result);

        const worktree = result.worktree ?? {};
        const normalizedPath = normalizePath(worktree.path);
        if (!normalizedPath) throw new Error('validated worktree did not return a path');
        assertUniqueWorkspace(project, { path: normalizedPath });

        const at = nowIso();
        const gitFields = gitFieldsFromWorktree(worktree);
        const name = cleanName(body?.name) || gitFields.branch || normalizedPath.split('/').pop() || 'Workspace';
        const workspace: Workspace = {
          id: createId('workspace'),
          projectId,
          workspaceKind: 'worktree',
          source: 'adopted',
          name,
          portalId: project.portalId,
          path: normalizedPath,
          status: 'ready',
          locked: false,
          sortOrder: project.workspaces.length,
          createdAt: at,
          updatedAt: at,
        };
        const nextProject = { ...project, workspaces: [...project.workspaces, workspace], updatedAt: at };
        const thread = await saveProject(memory, resourceId, nextProject);
        return c.json({ project: toProject(thread), workspace });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/projects/:projectId/workspaces/:workspaceId', {
    method: 'PATCH',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const workspaceId = c.req.param('workspaceId');
        const body = await c.req.json();
        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);
        assertGitProjectReady(project, resourceId);

        const workspace = project.workspaces.find(item => item.id === workspaceId);
        if (!workspace) return c.json({ error: 'workspace not found' }, 404);
        const at = nowIso();
        const branch = normalizeBranch(body?.branch);
        const name = cleanName(body?.name);
        let nextWorkspace: Workspace = { ...workspace, ...(name ? { name } : {}), updatedAt: at };

        if (branch) {
          const result = await requestPortalTool({
            portalId: workspace.portalId ?? project.portalId!,
            projectId,
            workspaceId,
            rootId: project.portalRootId,
            repoPath: project.repoPath,
            workspacePath: workspace.path,
            tool: 'portal.git.worktree.switch',
            args: {
              branch,
              create: body?.createBranch === true,
              base: normalizeBranch(body?.base),
            },
            timeoutMs: 60_000,
          }) as { ok?: boolean; error?: string; worktree?: Record<string, unknown> };
          portalToolError(result);
        }

        const nextProject = {
          ...project,
          workspaces: project.workspaces.map(item => item.id === workspaceId ? nextWorkspace : item),
          updatedAt: at,
        };
        const thread = await saveProject(memory, resourceId, nextProject);
        return c.json({ project: toProject(thread), workspace: nextWorkspace });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/projects/:projectId/workspaces/:workspaceId', {
    method: 'DELETE',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const workspaceId = c.req.param('workspaceId');
        const mode = c.req.query('mode') === 'detach' ? 'detach' : 'remove';
        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);
        assertGitProjectReady(project, resourceId);

        const workspace = project.workspaces.find(item => item.id === workspaceId);
        if (!workspace) return c.json({ error: 'workspace not found' }, 404);
        if (isPrimaryWorkspace(workspace)) return c.json({ error: 'primary workspace cannot be removed' }, 400);
        const activeThreads = await getActiveThreadsForWorkspace(memory, resourceId, projectId, workspaceId);
        if (activeThreads.length > 0) return c.json({ error: 'workspace has active threads; archive or delete them before removing the workspace' }, 409);

        if (mode === 'remove') {
          const result = await requestPortalTool({
            portalId: workspace.portalId ?? project.portalId!,
            projectId,
            rootId: project.portalRootId,
            repoPath: project.repoPath,
            tool: 'portal.git.worktree.remove',
            args: { path: workspace.path, deleteBranch: false },
            timeoutMs: 60_000,
          }) as { ok?: boolean; error?: string };
          portalToolError(result);
        }

        const nextProject = { ...project, workspaces: project.workspaces.filter(item => item.id !== workspaceId), updatedAt: nowIso() };
        const thread = await saveProject(memory, resourceId, nextProject);
        return c.json({ project: toProject(thread), workspace, mode });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/projects/:projectId/workspaces/reorder', {
    method: 'PATCH',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const body = await c.req.json();
        const workspaceIds = Array.isArray(body?.workspaceIds) ? body.workspaceIds.filter((id: unknown) => typeof id === 'string') : [];
        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);
        const existingIds = new Set(project.workspaces.map(workspace => workspace.id));
        if (workspaceIds.length !== existingIds.size || workspaceIds.some(id => !existingIds.has(id))) {
          return c.json({ error: 'workspaceIds must include all workspaces for this project' }, 400);
        }

        const order = new Map(workspaceIds.map((id, index) => [id, index]));
        const nextProject = {
          ...project,
          workspaces: project.workspaces.map(workspace => ({ ...workspace, sortOrder: order.get(workspace.id) ?? workspace.sortOrder })),
          updatedAt: nowIso(),
        };
        const thread = await saveProject(memory, resourceId, nextProject);
        return c.json({ project: toProject(thread) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/projects/:projectId/threads', {
    method: 'POST',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const body = await c.req.json();
        const threadId = typeof body?.threadId === 'string' ? body.threadId : createId('thread');
        const title = typeof body?.title === 'string' ? body.title : '...';
        const profileId = optionalString(body?.profileId);
        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);

        const at = nowIso();
        const requestedWorkspaceId = typeof body?.workspaceId === 'string'
          ? body.workspaceId
          : project.projectKind === 'notes'
          ? project.workspaces[0]?.id
          : undefined;
        const workspace = requestedWorkspaceId
          ? project.workspaces.find(item => item.id === requestedWorkspaceId)
          : undefined;
        if (requestedWorkspaceId && !workspace) return c.json({ error: 'workspace not found' }, 404);
        const isAdHoc = project.systemKind === 'adHoc' && workspace?.systemKind === 'adHoc';
        if (project.projectKind === 'general' && requestedWorkspaceId && !isAdHoc) return c.json({ error: 'general projects cannot have workspace threads' }, 400);
        if (project.projectKind === 'git' && !workspace) return c.json({ error: 'git project threads must belong to a workspace' }, 400);
        if (project.projectKind === 'notes' && !workspace) return c.json({ error: 'notes project threads must belong to the vault workspace' }, 400);

        const sortOrder = await getTopThreadSortOrder(memory, resourceId, projectId, workspace?.id);
        const metadata = workspace
          ? {
              mode: 'project',
              projectId,
              workspaceId: workspace.id,
              sortOrder,
              ...(profileId ? { profileId } : {}),
              ...(isAdHoc ? { adHoc: true, portalId: workspace.portalId, workspacePath: workspace.path } : {}),
            }
          : { mode: 'project', projectId, sortOrder, ...(profileId ? { profileId } : {}) };
        const thread = await memory.createThread({
          resourceId,
          threadId,
          title,
          metadata,
          saveThread: true,
        });

        await saveProject(memory, resourceId, { ...project, updatedAt: at });
        return c.json({ thread, workspace });
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
        const memory = await getMemory(c);
        const primaryPortalId = await getPrimaryPortalId(memory, resourceId);
        const portals = listPortalConnections(resourceId);
        const effectivePrimaryPortalId = primaryPortalId ?? portals[0]?.portalId;
        return c.json({ portals: portals.map(portal => ({ ...portal, primary: portal.portalId === effectivePrimaryPortalId })) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/portals/:portalId/primary', {
    method: 'PATCH',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const portalId = c.req.param('portalId');
        assertPortalForUser(portalId, resourceId);
        const memory = await getMemory(c);
        await setPrimaryPortalId(memory, resourceId, portalId);
        const portals = listPortalConnections(resourceId).map(portal => ({ ...portal, primary: portal.portalId === portalId }));
        return c.json({ ok: true, primaryPortalId: portalId, portals });
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
        const primaryPortalId = await getPrimaryPortalId(memory, resourceId);
        if (!primaryPortalId) await setPrimaryPortalId(memory, resourceId, portalId);
        return c.json({ portalId, token });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
];
