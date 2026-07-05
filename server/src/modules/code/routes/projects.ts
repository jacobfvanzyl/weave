import { defineRoute } from '../../../server/routes';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { productProjectRepository } from '../../../products/project-repository';
import type { ProductId, Project, Workspace } from '../../../products/types';
import {
  collectWorkspaceGitStatesForProject,
  gitFieldsFromWorktree,
  stripProjectGitState,
  workspaceStateFromGitFields,
} from '../projects/git-state';
import { getPortalConnection, listPortalConnections } from '../../../portal/registry';
import { callerForOwner, internalServices } from '../../../services';
import { sanitizeNotesStorageMetadata } from '../../notes/storage/resolver';
import type { NotesStorageMetadata } from '../../notes/storage/types';
import {
  type BranchCleanup,
  createProjectWorktree,
  fetchWorkspaceUpstream,
  inspectProjectGit,
  inspectWorkspaceBranchCleanup,
  listProjectBranches,
  listProjectWorktrees,
  PortalToolFailure,
  pullWorkspaceUpstream,
  removeWorkspaceWorktree,
  switchWorkspaceBranch,
  validateProjectWorktree,
} from '../git/service';
import { hasActiveThreadRun } from '../../chat/service';

const agentId = 'mageHandAgent';
const projectThreadPrefix = '__project__';
const adHocProjectPrefix = 'project_ad_hoc_';
const adHocWorkspacePrefix = 'workspace_ad_hoc_';

type RemovedWorkspaceSnapshot = {
  id: string;
  projectId: string;
  name: string;
  path?: string;
  branch?: string;
  removedAt: string;
};

const createId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const nowIso = () => new Date().toISOString();
const projectThreadId = (projectId: string) => `${projectThreadPrefix}${projectId}`;
const portalRequesterForOwner = (resourceId: string) =>
  internalServices.tools.portalToolRequester(callerForOwner(resourceId, 'ui'));

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
const timestampString = (value: unknown) =>
  typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : '';
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
const productProjectKinds: Record<ProductId, Project['projectKind']> = {
  code: 'git',
  notes: 'notes',
  chat: 'general',
};

const productForRequestPath = (c: any): ProductId | undefined => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/code/')) return 'code';
  if (path.startsWith('/notes/')) return 'notes';
  if (path.startsWith('/chat/')) return 'chat';
  return undefined;
};

const projectKindForRequest = (c: any, requested: unknown): Project['projectKind'] => {
  const product = productForRequestPath(c);
  if (product) return productProjectKinds[product];
  return requested === 'git' || requested === 'notes' ? requested : 'general';
};

const assertProjectProduct = (c: any, project: Project | undefined) => {
  const product = productForRequestPath(c);
  if (!project || !product) return project;
  const expectedKind = productProjectKinds[product];
  return project.projectKind === expectedKind || (project.systemKind === 'adHoc' && product === 'code')
    ? project
    : undefined;
};

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
    notesStorage: sanitizeNotesStorageMetadata(metadata.notesStorage),
    gitRemote: metadata.gitRemote,
    defaultBranch: metadata.defaultBranch,
    rootPathHint: metadata.rootPathHint,
    sortOrder: typeof metadata.sortOrder === 'number' ? metadata.sortOrder : undefined,
    agentInstructions: metadata.agentInstructions,
    hidden: metadata.hidden === true,
    systemKind: metadata.systemKind === 'adHoc' ? 'adHoc' : undefined,
    workspaces: Array.isArray(metadata.workspaces) ? metadata.workspaces : [],
    createdAt: typeof thread.createdAt === 'string' ? thread.createdAt : metadata.createdAt ?? nowIso(),
    updatedAt: typeof thread.updatedAt === 'string' ? thread.updatedAt : metadata.updatedAt ?? nowIso(),
  });
};

const legacyProjectsFromMemory = async (memory: any, resourceId: string) => {
  const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
  return result.threads.filter(isProjectThread).map((thread: any) => toProject(thread));
};

export const migrateLegacyProjectsForOwner = (memory: any, resourceId: string) =>
  productProjectRepository.migrateLegacyProjects(resourceId, () => legacyProjectsFromMemory(memory, resourceId));

const saveProject = async (memory: any, resourceId: string, project: Project) => {
  await migrateLegacyProjectsForOwner(memory, resourceId);
  const durableProject = await productProjectRepository.save(stripProjectGitState(project));
  const threadId = projectThreadId(project.id);
  const metadata = { kind: 'project', ...durableProject };
  const existing = await memory.getThreadById({ threadId }).catch(() => undefined);

  if (existing) {
    await memory.updateThread({ id: threadId, title: durableProject.name, metadata });
    return durableProject;
  }

  await memory.createThread({ resourceId, threadId, title: durableProject.name, metadata, saveThread: true });
  return durableProject;
};

const getProject = async (memory: any, resourceId: string, projectId: string) => {
  await migrateLegacyProjectsForOwner(memory, resourceId);
  return productProjectRepository.get(resourceId, projectId);
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

const isPrimaryWorkspace = (workspace: Workspace) =>
  workspace.locked === true || workspace.workspaceKind === 'primary' || workspace.source === 'primary';

const normalizeRemote = (value: unknown) => optionalString(value)?.replace(/\.git$/, '').toLowerCase();
const normalizeWorkspacePath = (workspace: Pick<Workspace, 'path'>) => normalizePath(workspace.path)?.toLowerCase();
const assertUniqueWorkspace = (project: Project, candidate: Pick<Workspace, 'path'>, ignoreId?: string) => {
  const candidatePath = normalizeWorkspacePath(candidate);
  const duplicatePath = candidatePath &&
    project.workspaces.some((item) => item.id !== ignoreId && normalizeWorkspacePath(item) === candidatePath);
  if (duplicatePath) throw new Error('workspace path is already attached to this Project');
};

const portalToolError = (result: { ok?: boolean; error?: unknown }) => {
  if (result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : 'Portal tool failed');
};

const hashText = async (value: string) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes)).slice(0, 12).map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const pathBasename = (path: string) => path.split('/').filter(Boolean).pop() || path;
const isRootedPath = (path: string) => path.startsWith('/') || path === '~' || path.startsWith('~/');

const validateAdHocPath = async (resourceId: string, portalId: string, workspacePath: string) => {
  assertPortalForUser(portalId, resourceId);
  const result = await portalRequesterForOwner(resourceId)({
    portalId,
    tool: 'portal.fs.pathStat',
    args: { path: workspacePath },
    timeoutMs: 10_000,
  }) as { ok?: boolean; error?: string; path?: string; isDirectory?: boolean };
  portalToolError(result);
  const realPath = normalizePath(result.path);
  if (!realPath || result.isDirectory !== true) {
    throw new Error('Ad-hoc path must be an existing directory reachable by Portal');
  }
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
  const workspace = project.workspaces.find((item) => item.id === workspaceId);
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
  const nextProject = {
    ...project,
    hidden: true,
    systemKind: 'adHoc' as const,
    workspaces: [...project.workspaces, nextWorkspace],
    updatedAt: at,
  };
  await saveProject(memory, resourceId, nextProject);
  return { project: nextProject, workspace: nextWorkspace };
};

const getAllProjects = async (memory: any, resourceId: string) => {
  await migrateLegacyProjectsForOwner(memory, resourceId);
  return productProjectRepository.list(resourceId, { includeHidden: true });
};

const getThreadsForWorkspace = async (memory: any, resourceId: string, projectId: string, workspaceId: string) => {
  const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
  return result.threads.filter((thread: any) => {
    const metadata = thread.metadata as Record<string, unknown> | undefined;
    return metadata?.mode === 'project' &&
      metadata.projectId === projectId &&
      metadata.workspaceId === workspaceId;
  });
};

const threadIsArchived = (thread: any) => {
  const metadata = thread.metadata as Record<string, unknown> | undefined;
  return metadata?.archived === true;
};

const workspaceRemovalThreadCounts = (threads: any[]) => ({
  activeThreadCount: threads.filter((thread) => !threadIsArchived(thread)).length,
  archivedThreadCount: threads.filter(threadIsArchived).length,
});

const removedWorkspaceSnapshot = (
  workspace: Workspace,
  removedAt: string,
  branchCleanup?: BranchCleanup,
): RemovedWorkspaceSnapshot => ({
  id: workspace.id,
  projectId: workspace.projectId,
  name: workspace.name,
  ...(workspace.path ? { path: workspace.path } : {}),
  ...(branchCleanup?.branch ? { branch: branchCleanup.branch } : {}),
  removedAt,
});

const archiveRemovedWorkspaceThreads = async (
  memory: any,
  threads: any[],
  removedWorkspace: RemovedWorkspaceSnapshot,
) => {
  await Promise.all(threads.map((thread) => {
    const metadata = { ...((thread.metadata ?? {}) as Record<string, unknown>) };
    delete metadata.workspaceId;
    metadata.archived = true;
    metadata.removedWorkspace = removedWorkspace;
    return memory.updateThread({
      id: thread.id,
      title: thread.title,
      metadata,
    });
  }));
};

const dirtyWorktreeResponse = (c: any, error: unknown) => {
  if (error instanceof PortalToolFailure && error.code === 'dirty-worktree') {
    return c.json({ code: 'dirty-worktree', error: error.message }, 409);
  }
  return undefined;
};

const createGitProject = async (
  c: any,
  resourceId: string,
  baseProject: Project,
  body: Record<string, unknown>,
): Promise<Project> => {
  const portalId = optionalString(body?.portalId);
  const rootId = optionalString(body?.rootId);
  const repoPath = optionalString(body?.repoPath);
  assertPortalForUser(portalId, resourceId);
  if (!rootId) throw new Error('rootId is required for git projects');
  if (!repoPath) throw new Error('repoPath is required for git projects');

  const git = await inspectProjectGit(portalId!, rootId, repoPath, portalRequesterForOwner(resourceId));
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
    agentInstructions:
      typeof git.agentsMd === 'object' && git.agentsMd && typeof (git.agentsMd as any).content === 'string'
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

const createVirtualNotesWorkspace = (baseProject: Project, name: string): Workspace => ({
  id: createId('workspace'),
  projectId: baseProject.id,
  workspaceKind: 'primary',
  source: 'notes',
  name: name || baseProject.name,
  locked: true,
  sortOrder: 0,
  status: 'ready',
  createdAt: baseProject.createdAt,
  updatedAt: baseProject.createdAt,
});

const createNotesProject = async (
  _c: any,
  resourceId: string,
  baseProject: Project,
  body: Record<string, unknown>,
): Promise<Project> => {
  const requestedStorage = sanitizeNotesStorageMetadata(body?.notesStorage);
  if (requestedStorage && requestedStorage.kind !== 'portal') {
    return {
      ...baseProject,
      notesStorage: requestedStorage,
      workspaces: [createVirtualNotesWorkspace(baseProject, optionalString(body?.workspaceName) ?? baseProject.name)],
    };
  }

  const portalId = optionalString(body?.portalId) ?? requestedStorage?.portalId;
  const rootId = optionalString(body?.rootId) ?? requestedStorage?.rootId;
  const vaultPath = optionalString(body?.vaultPath ?? body?.repoPath) ??
    requestedStorage?.vaultPath ??
    requestedStorage?.workspacePath ??
    '';
  assertPortalForUser(portalId, resourceId);
  if (!rootId) throw new Error('rootId is required for notes projects');

  const result = (isRootedPath(vaultPath)
    ? await portalRequesterForOwner(resourceId)({
      portalId: portalId!,
      tool: 'portal.fs.pathStat',
      args: { rootId, path: vaultPath },
      timeoutMs: 10_000,
    }) as { ok?: boolean; error?: string; path?: string; isDirectory?: boolean }
    : await portalRequesterForOwner(resourceId)({
      portalId: portalId!,
      tool: 'portal.fs.browse',
      args: { rootId, path: vaultPath },
      timeoutMs: 10_000,
    })) as { ok?: boolean; error?: string; path?: string; realPath?: string; isDirectory?: boolean };
  portalToolError(result);
  const realPath = normalizePath(isRootedPath(vaultPath) ? result.path : result.realPath);
  if (!realPath || result.isDirectory === false) {
    throw new Error('Selected vault folder could not be resolved. Restart Portal and select the folder again.');
  }
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
    vaultPath: realPath,
    notesStorage: {
      kind: 'portal',
      portalId,
      rootId,
      vaultPath: realPath,
      workspacePath: realPath,
    },
    workspaces: [primaryWorkspace],
  };
};

export const projectRoutes = [
  defineRoute('/code/projects', {
    method: 'GET',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const memory = await getMemory(c);
        await migrateLegacyProjectsForOwner(memory, resourceId);
        const projects = await productProjectRepository.list(resourceId, { product: productForRequestPath(c) });
        return c.json({ projects });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/code/projects/workspaces/git-state', {
    method: 'GET',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const memory = await getMemory(c);
        const checkedAt = nowIso();
        const projects: Project[] = (await getAllProjects(memory, resourceId))
          .filter((project: Project) => project.projectKind === 'git' && isVisibleUserProject(project));
        const states = (await Promise.all(projects.map((project: Project) =>
          collectWorkspaceGitStatesForProject(
            project,
            resourceId,
            checkedAt,
            portalRequesterForOwner(resourceId),
            getPortalConnection,
          )
        ))).flat();
        return c.json({ states });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/code/projects', {
    method: 'POST',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const body = await c.req.json();
        const name = cleanName(body?.name);
        if (!name) return c.json({ error: 'name is required' }, 400);

        const projectKind = projectKindForRequest(c, body?.projectKind);
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

        return c.json({ project: await saveProject(memory, resourceId, project) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/code/projects/reorder', {
    method: 'PATCH',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const body = await c.req.json();
        const projectIds = Array.isArray(body?.projectIds)
          ? body.projectIds.filter((id: unknown) => typeof id === 'string')
          : [];
        const memory = await getMemory(c);
        await migrateLegacyProjectsForOwner(memory, resourceId);
        const product = productForRequestPath(c);
        if (product) {
          await productProjectRepository.reorder(resourceId, product, projectIds);
          return c.json({ projects: await productProjectRepository.list(resourceId, { product }) });
        }

        const projects = await productProjectRepository.list(resourceId);
        const byId = new Map(projects.map((project) => [project.id, project]));
        if (projectIds.length !== byId.size || projectIds.some((id: string) => !byId.has(id))) {
          return c.json({ error: 'projectIds must include all visible projects for this user' }, 400);
        }
        await Promise.all(
          projectIds.map((projectId: string, index: number) =>
            saveProject(memory, resourceId, { ...byId.get(projectId)!, sortOrder: index, updatedAt: nowIso() })
          ),
        );
        return c.json({ projects });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/code/projects/:projectId', {
    method: 'DELETE',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const memory = await getMemory(c);
        const project = assertProjectProduct(c, await getProject(memory, resourceId, projectId));
        if (!project) return c.json({ error: 'project not found' }, 404);

        const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
        const projectThreads = (result.threads as any[]).filter((thread: any) => {
          const metadata = thread.metadata as Record<string, unknown> | undefined;
          return metadata?.mode === 'project' && metadata.projectId === projectId;
        });

        await Promise.all([
          productProjectRepository.delete(resourceId, projectId),
          memory.deleteThread(projectThreadId(projectId)),
          ...projectThreads.map((thread) => memory.deleteThread(thread.id)),
        ]);

        return c.json({ ok: true });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/code/projects/:projectId', {
    method: 'GET',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const memory = await getMemory(c);
        const project = assertProjectProduct(c, await getProject(memory, resourceId, c.req.param('projectId')));
        if (!project) return c.json({ error: 'project not found' }, 404);
        return c.json({ project });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/code/projects/:projectId/branches', {
    method: 'GET',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);
        assertGitProjectReady(project, resourceId);

        const branches = await listProjectBranches(project, resourceId, {
          getPortal: getPortalConnection,
          requestPortal: portalRequesterForOwner(resourceId),
        });
        return c.json({ branches });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/code/workspaces/resolve', {
    method: 'POST',
    handler: async (c) => {
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
        const projects: Project[] = (await getAllProjects(memory, resourceId))
          .filter((project: Project) =>
            project.projectKind === 'git' && !project.hidden && project.systemKind !== 'adHoc'
          );
        const exact = projects.flatMap((project: Project) =>
          project.workspaces.map((workspace: Workspace) => ({ project, workspace }))
        )
          .find((item: { project: Project; workspace: Workspace }) =>
            normalizeWorkspacePath(item.workspace) === workspacePath.toLowerCase()
          );

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
              validation = await validateProjectWorktree(project, resourceId, workspacePath, {
                getPortal: getPortalConnection,
                requestPortal: portalRequesterForOwner(resourceId),
              });
              const validatedPath = normalizePath(validation.path) ?? workspacePath;
              resolvedProject = project;
              resolvedWorkspace = project.workspaces.find((item: Workspace) =>
                normalizeWorkspacePath(item) === validatedPath.toLowerCase()
              );

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
              if (error instanceof Error && /portal is offline|portal is offline or unavailable/i.test(error.message)) {
                offline = true;
              }
            }
          }
        }

        if (!resolvedProject || !resolvedWorkspace) {
          if (allowAdHoc && portalId) {
            const adHoc = await ensureAdHocWorkspace(memory, resourceId, portalId, workspacePath);
            return c.json({
              resolved: true,
              adHoc: true,
              offline: false,
              project: adHoc.project,
              workspace: adHoc.workspace,
            });
          }
          const remoteMatches = remote
            ? projects.filter((project: Project) => normalizeRemote(project.gitRemote) === remote)
            : [];
          return c.json({
            resolved: false,
            offline,
            needsConfirmation: remoteMatches.length > 0,
            candidates: remoteMatches.map((project: Project) => ({
              projectId: project.id,
              name: project.name,
              gitRemote: project.gitRemote,
            })),
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

        return c.json({
          resolved: true,
          offline,
          adopted,
          project: resolvedProject,
          workspace: resolvedWorkspace,
          thread,
          validation,
        });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/code/projects/:projectId/workspaces/discover', {
    method: 'GET',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);
        assertGitProjectReady(project, resourceId);

        const discovered = await listProjectWorktrees(project, resourceId, {
          getPortal: getPortalConnection,
          requestPortal: portalRequesterForOwner(resourceId),
        });
        const worktrees = discovered.map((worktree) => {
          const path = normalizePath(worktree.path);
          const branch = normalizeBranch(worktree.branch);
          const workspace = project.workspaces.find((item) => normalizePath(item.path) === path);
          return { ...worktree, path, branch, adopted: Boolean(workspace), workspaceId: workspace?.id };
        });
        return c.json({ worktrees });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/code/projects/:projectId/workspaces', {
    method: 'POST',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const body = await c.req.json();
        const name = cleanName(body?.name);
        if (!name) return c.json({ error: 'name is required' }, 400);
        const mode = body?.mode === 'existingBranch' || body?.mode === 'detached' ? body.mode : 'newBranch';
        const branch = normalizeBranch(body?.branch);
        const base = normalizeBranch(body?.base);
        if (mode !== 'detached' && !branch) {
          return c.json({ error: 'branch is required for branch-backed workspaces' }, 400);
        }

        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);
        assertGitProjectReady(project, resourceId);

        const worktree = await createProjectWorktree(project, resourceId, {
          mode,
          name,
          branch,
          base,
          path: optionalString(body?.path),
        }, {
          getPortal: getPortalConnection,
          requestPortal: portalRequesterForOwner(resourceId),
        });
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
        return c.json({ project: await saveProject(memory, resourceId, nextProject), workspace });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/code/projects/:projectId/workspaces/adopt', {
    method: 'POST',
    handler: async (c) => {
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

        const worktree = await validateProjectWorktree(project, resourceId, path, {
          getPortal: getPortalConnection,
          requestPortal: portalRequesterForOwner(resourceId),
        });
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
        return c.json({ project: await saveProject(memory, resourceId, nextProject), workspace });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/code/projects/:projectId/workspaces/:workspaceId', {
    method: 'PATCH',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const workspaceId = c.req.param('workspaceId');
        const body = await c.req.json();
        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);
        assertGitProjectReady(project, resourceId);

        const workspace = project.workspaces.find((item) => item.id === workspaceId);
        if (!workspace) return c.json({ error: 'workspace not found' }, 404);
        const at = nowIso();
        const branch = normalizeBranch(body?.branch);
        const name = cleanName(body?.name);
        let nextWorkspace: Workspace = { ...workspace, ...(name ? { name } : {}), updatedAt: at };

        if (branch) {
          await switchWorkspaceBranch(project, workspace, resourceId, {
            branch,
            create: body?.createBranch === true,
            base: normalizeBranch(body?.base),
          }, {
            getPortal: getPortalConnection,
            requestPortal: portalRequesterForOwner(resourceId),
          });
        }

        const nextProject = {
          ...project,
          workspaces: project.workspaces.map((item) => item.id === workspaceId ? nextWorkspace : item),
          updatedAt: at,
        };
        return c.json({ project: await saveProject(memory, resourceId, nextProject), workspace: nextWorkspace });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/code/projects/:projectId/workspaces/:workspaceId/git/fetch', {
    method: 'POST',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const workspaceId = c.req.param('workspaceId');
        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);
        assertGitProjectReady(project, resourceId);

        const workspace = project.workspaces.find((item) => item.id === workspaceId);
        if (!workspace) return c.json({ error: 'workspace not found' }, 404);
        const status = await fetchWorkspaceUpstream(project, workspace, resourceId, {
          getPortal: getPortalConnection,
          requestPortal: portalRequesterForOwner(resourceId),
        });
        return c.json({ state: workspaceStateFromGitFields(project.id, workspace, status, nowIso()) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/code/projects/:projectId/workspaces/:workspaceId/git/pull', {
    method: 'POST',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const workspaceId = c.req.param('workspaceId');
        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);
        assertGitProjectReady(project, resourceId);

        const workspace = project.workspaces.find((item) => item.id === workspaceId);
        if (!workspace) return c.json({ error: 'workspace not found' }, 404);
        const status = await pullWorkspaceUpstream(project, workspace, resourceId, {
          getPortal: getPortalConnection,
          requestPortal: portalRequesterForOwner(resourceId),
        });
        return c.json({ state: workspaceStateFromGitFields(project.id, workspace, status, nowIso()) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/code/projects/:projectId/workspaces/:workspaceId/removal-preview', {
    method: 'GET',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const workspaceId = c.req.param('workspaceId');
        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);
        assertGitProjectReady(project, resourceId);

        const workspace = project.workspaces.find((item) => item.id === workspaceId);
        if (!workspace) return c.json({ error: 'workspace not found' }, 404);
        if (isPrimaryWorkspace(workspace)) return c.json({ error: 'primary workspace cannot be removed' }, 400);

        const workspaceThreads = await getThreadsForWorkspace(memory, resourceId, projectId, workspaceId);
        const branchCleanup = await inspectWorkspaceBranchCleanup(project, workspace, resourceId, {
          path: workspace.path,
          defaultBranch: project.defaultBranch,
        }, {
          getPortal: getPortalConnection,
          requestPortal: portalRequesterForOwner(resourceId),
        });
        return c.json({ workspace, ...workspaceRemovalThreadCounts(workspaceThreads), branchCleanup });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/code/projects/:projectId/workspaces/:workspaceId', {
    method: 'DELETE',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const workspaceId = c.req.param('workspaceId');
        const mode = c.req.query('mode') === 'detach' ? 'detach' : 'remove';
        const force = c.req.query('force') === 'true';
        const deleteLocalBranch = c.req.query('deleteLocalBranch') === 'true';
        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);
        assertGitProjectReady(project, resourceId);

        const workspace = project.workspaces.find((item) => item.id === workspaceId);
        if (!workspace) return c.json({ error: 'workspace not found' }, 404);
        if (isPrimaryWorkspace(workspace)) return c.json({ error: 'primary workspace cannot be removed' }, 400);
        const workspaceThreads = await getThreadsForWorkspace(memory, resourceId, projectId, workspaceId);
        const runningThreads = workspaceThreads.filter((thread: any) => hasActiveThreadRun(resourceId, thread.id));
        if (runningThreads.length > 0) {
          return c.json({
            code: 'workspace-thread-running',
            error: 'workspace has running threads; stop them before removing the workspace',
          }, 409);
        }

        let branchCleanup: BranchCleanup = {
          requested: deleteLocalBranch,
          status: deleteLocalBranch ? 'not_applicable' : 'not_requested',
        };
        if (mode === 'remove') {
          try {
            const result = await removeWorkspaceWorktree(project, workspace, resourceId, {
              path: workspace.path,
              force,
              deleteLocalBranch,
              defaultBranch: project.defaultBranch,
            }, {
              getPortal: getPortalConnection,
              requestPortal: portalRequesterForOwner(resourceId),
            });
            branchCleanup = result.branchCleanup;
          } catch (error) {
            const dirtyResponse = dirtyWorktreeResponse(c, error);
            if (dirtyResponse) return dirtyResponse;
            throw error;
          }
        }

        const removedAt = nowIso();
        const removedWorkspace = removedWorkspaceSnapshot(workspace, removedAt, branchCleanup);
        await archiveRemovedWorkspaceThreads(memory, workspaceThreads, removedWorkspace);

        const nextProject = {
          ...project,
          workspaces: project.workspaces.filter((item) => item.id !== workspaceId),
          updatedAt: removedAt,
        };
        return c.json({
          project: await saveProject(memory, resourceId, nextProject),
          workspace,
          mode,
          force,
          removedWorkspace,
          ...workspaceRemovalThreadCounts(workspaceThreads),
          branchCleanup,
        });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/code/projects/:projectId/workspaces/reorder', {
    method: 'PATCH',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const body = await c.req.json();
        const workspaceIds: string[] = Array.isArray(body?.workspaceIds)
          ? body.workspaceIds.filter((id: unknown): id is string => typeof id === 'string')
          : [];
        const memory = await getMemory(c);
        const project = await getProject(memory, resourceId, projectId);
        if (!project) return c.json({ error: 'project not found' }, 404);
        const existingIds = new Set(project.workspaces.map((workspace) => workspace.id));
        if (workspaceIds.length !== existingIds.size || workspaceIds.some((id: string) => !existingIds.has(id))) {
          return c.json({ error: 'workspaceIds must include all workspaces for this project' }, 400);
        }

        const order = new Map<string, number>(workspaceIds.map((id: string, index: number) => [id, index]));
        const nextProject: Project = {
          ...project,
          workspaces: project.workspaces.map((workspace) => ({
            ...workspace,
            sortOrder: order.get(workspace.id) ?? workspace.sortOrder,
          })),
          updatedAt: nowIso(),
        };
        return c.json({ project: await saveProject(memory, resourceId, nextProject) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/code/projects/:projectId/threads', {
    method: 'POST',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const projectId = c.req.param('projectId');
        const body = await c.req.json();
        const threadId = typeof body?.threadId === 'string' ? body.threadId : createId('thread');
        const title = typeof body?.title === 'string' ? body.title : '...';
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
          ? project.workspaces.find((item) => item.id === requestedWorkspaceId)
          : undefined;
        if (requestedWorkspaceId && !workspace) return c.json({ error: 'workspace not found' }, 404);
        const isAdHoc = project.systemKind === 'adHoc' && workspace?.systemKind === 'adHoc';
        if (project.projectKind === 'general' && requestedWorkspaceId && !isAdHoc) {
          return c.json({ error: 'general projects cannot have workspace threads' }, 400);
        }
        if (project.projectKind === 'git' && !workspace) {
          return c.json({ error: 'git project threads must belong to a workspace' }, 400);
        }
        if (project.projectKind === 'notes' && !workspace) {
          return c.json({ error: 'notes project threads must belong to the vault workspace' }, 400);
        }

        const sortOrder = await getTopThreadSortOrder(memory, resourceId, projectId, workspace?.id);
        const metadata = workspace
          ? {
            mode: 'project',
            projectId,
            workspaceId: workspace.id,
            sortOrder,
            ...(isAdHoc ? { adHoc: true, portalId: workspace.portalId, workspacePath: workspace.path } : {}),
          }
          : { mode: 'project', projectId, sortOrder };
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
];

const productProjectRoutePaths = new Set([
  '/code/projects',
  '/code/projects/reorder',
  '/code/projects/:projectId',
  '/code/projects/:projectId/threads',
]);

export const productProjectRoutes = projectRoutes.filter((route) => productProjectRoutePaths.has(route.path));
