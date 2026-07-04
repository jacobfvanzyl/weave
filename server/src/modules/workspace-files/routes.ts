import { defineRoute } from '../../server/routes';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { productProjectRepository } from '../../products/project-repository';
import type { Project } from '../../products/types';
import { issueWorkspaceFileWatchToken } from '../../portal/workspace-file-watch-relay';
import { requestPortalTool, resolvePortalForTarget } from '../../portal/registry';
import {
  optionalString,
  parseNotesVaultTarget,
  resolveNotesVaultForProject,
  type NotesVaultResolverDependencies,
} from '../notes/storage/resolver';
import type {
  NotesProject,
  NotesVaultBackend,
  NotesVaultDeleteInput,
  NotesVaultIndexInput,
  NotesVaultMkdirInput,
  NotesStorageMetadata,
  NotesVaultMoveInput,
  NotesVaultReadInput,
  NotesVaultUploadInput,
  NotesVaultWriteInput,
  ResolvedNotesVaultBinding,
} from '../notes/storage/types';

const agentId = 'mageHandAgent';
const projectThreadPrefix = '__project__';

type WorkspaceFileAction =
  | 'list'
  | 'read'
  | 'write'
  | 'mkdir'
  | 'move'
  | 'delete'
  | 'upload'
  | 'index'
  | 'hash'
  | 'diffPreview';

type WorkspaceFileTarget = {
  projectId?: string;
  workspaceId?: string;
  portalId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
};

type LegacyWorkspace = {
  id: string;
  portalId?: string;
  path?: string;
};

type WorkspaceFileProject = Project | {
  id: string;
  userId: string;
  projectKind: 'general' | 'git' | 'notes';
  portalId?: string;
  portalRootId?: string;
  repoPath?: string;
  vaultPath?: string;
  notesStorage?: NotesStorageMetadata;
  workspaces: LegacyWorkspace[];
};

type WorkspaceFileRouteDeps = NotesVaultResolverDependencies;

type NotesActionInput = {
  index: NotesVaultIndexInput;
  read: NotesVaultReadInput;
  write: NotesVaultWriteInput;
  mkdir: NotesVaultMkdirInput;
  move: NotesVaultMoveInput;
  delete: NotesVaultDeleteInput;
  upload: NotesVaultUploadInput;
};

const projectThreadId = (projectId: string) => `${projectThreadPrefix}${projectId}`;

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

const toLegacyProject = (thread: any): WorkspaceFileProject => {
  const metadata = (thread.metadata ?? {}) as Partial<WorkspaceFileProject> & { workspaces?: LegacyWorkspace[] };
  return {
    id: typeof metadata.id === 'string' ? metadata.id : thread.id.replace(projectThreadPrefix, ''),
    userId: thread.resourceId,
    projectKind: metadata.projectKind === 'git' || metadata.projectKind === 'notes' ? metadata.projectKind : 'general',
    portalId: metadata.portalId,
    portalRootId: metadata.portalRootId,
    repoPath: metadata.repoPath,
    vaultPath: metadata.vaultPath,
    notesStorage: metadata.notesStorage,
    workspaces: Array.isArray(metadata.workspaces) ? metadata.workspaces : [],
  };
};

const getProject = async (memory: any, resourceId: string, projectId: string) => {
  const persisted = await productProjectRepository.get(resourceId, projectId);
  if (persisted) return persisted as WorkspaceFileProject;

  const thread = await memory.getThreadById({ threadId: projectThreadId(projectId) }).catch(() => undefined);
  if (!thread || thread.resourceId !== resourceId) return undefined;
  const metadata = thread.metadata as Record<string, unknown> | undefined;
  if (!thread.id.startsWith(projectThreadPrefix) && metadata?.kind !== 'project') return undefined;
  return toLegacyProject(thread);
};

const parseTarget = (body: Record<string, unknown>): WorkspaceFileTarget => {
  const target = body.target && typeof body.target === 'object'
    ? body.target as Record<string, unknown>
    : body;
  return {
    projectId: optionalString(target.projectId),
    workspaceId: optionalString(target.workspaceId),
    portalId: optionalString(target.portalId),
    rootId: optionalString(target.rootId),
    repoPath: optionalString(target.repoPath),
    workspacePath: optionalString(target.workspacePath),
  };
};

const resolveGitWorkspaceFileTarget = (
  resourceId: string,
  target: WorkspaceFileTarget,
  project: WorkspaceFileProject | undefined,
  requiredCapability?: string,
) => {
  if (!target.projectId || !target.workspaceId) throw new Error('Project and Workspace are required for workspace files.');
  if (!project || project.userId !== resourceId) throw new Error('Project was not found.');
  if (project.projectKind !== 'git') throw new Error('This workspace file operation is only available for Git Projects.');

  const workspace = project.workspaces.find(item => item.id === target.workspaceId);
  if (!workspace) throw new Error('Workspace was not found.');
  const portal = resolvePortalForTarget({
    userId: resourceId,
    portalId: target.portalId ?? workspace.portalId ?? project.portalId,
    projectId: target.projectId,
    rootId: project.portalRootId ?? target.rootId,
    repoPath: project.repoPath ?? target.repoPath,
    workspacePath: workspace.path ?? target.workspacePath,
  });
  if (!portal) throw new Error('No online Portal is available for this workspace.');
  if (requiredCapability && !portal.capabilities.includes(requiredCapability)) {
    throw new Error('The connected Portal does not support this workspace file operation yet.');
  }

  return {
    portalId: portal.portalId,
    projectId: target.projectId,
    workspaceId: target.workspaceId,
    rootId: project.portalRootId ?? target.rootId,
    repoPath: project.repoPath ?? target.repoPath,
    workspacePath: workspace.path ?? target.workspacePath,
  };
};

const cleanPortalResult = (result: unknown) => {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  if (record.ok === false) throw new Error(typeof record.error === 'string' ? record.error : 'Portal workspace file request failed.');
  const { id: _id, type: _type, ...body } = record;
  return body;
};

const cleanNotesResult = (
  result: unknown,
  action: 'index' | 'read' | 'write' | 'mkdir' | 'move' | 'delete' | 'upload',
) => {
  const body = cleanPortalResult(result) as Record<string, unknown>;
  if ((action === 'index' || action === 'read' || action === 'write') && body.ok === true) {
    const { ok: _ok, ...withoutOk } = body;
    return withoutOk;
  }
  return body;
};

const errorResponse = (c: any, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message) ? 404 : /Portal|workspace|Project|Workspace|backend|Git|Notes/.test(message) ? 400 : 500;
  return c.json({ error: message }, status);
};

const invokeNotesBackend = <TAction extends keyof NotesActionInput>(
  backend: NotesVaultBackend,
  binding: ResolvedNotesVaultBinding,
  action: TAction,
  input: NotesActionInput[TAction],
  timeoutMs?: number,
) => backend[action](binding, input as never, timeoutMs ? { timeoutMs } : undefined);

const notesActionInput = (
  action: 'index' | 'read' | 'write' | 'mkdir' | 'move' | 'delete' | 'upload',
  body: Record<string, unknown>,
): NotesActionInput[typeof action] => {
  if (action === 'index') return { path: optionalString(body.path) ?? '' };
  if (action === 'read') return { path: optionalString(body.path) ?? '' };
  if (action === 'write') {
    return {
      path: optionalString(body.path) ?? '',
      content: typeof body.content === 'string' ? body.content : undefined,
      version: optionalString(body.version),
    };
  }
  if (action === 'mkdir') return { path: optionalString(body.path) ?? '' };
  if (action === 'move') {
    return {
      fromPath: optionalString(body.fromPath) ?? '',
      toPath: optionalString(body.toPath) ?? '',
      overwrite: body.overwrite === true,
    };
  }
  if (action === 'delete') return { path: optionalString(body.path) ?? '', recursive: body.recursive === true };
  return {
    path: optionalString(body.path) ?? '',
    base64Content: typeof body.base64Content === 'string' ? body.base64Content : undefined,
    contentType: optionalString(body.contentType),
  };
};

const portalArgs = (action: WorkspaceFileAction, body: Record<string, unknown>) => {
  if (action === 'list') return { path: optionalString(body.path) ?? '' };
  if (action === 'read') return { path: optionalString(body.path) ?? '' };
  if (action === 'hash') return { path: optionalString(body.path) ?? '' };
  if (action === 'diffPreview') {
    return {
      path: optionalString(body.path) ?? '',
      diff: typeof body.diff === 'string' ? body.diff : undefined,
    };
  }
  if (action === 'write') {
    return {
      path: optionalString(body.path) ?? '',
      content: typeof body.content === 'string' ? body.content : undefined,
      version: optionalString(body.version),
    };
  }
  if (action === 'mkdir') return { path: optionalString(body.path) ?? '' };
  if (action === 'move') {
    return {
      fromPath: optionalString(body.fromPath) ?? '',
      toPath: optionalString(body.toPath) ?? '',
      overwrite: body.overwrite === true,
    };
  }
  if (action === 'delete') return { path: optionalString(body.path) ?? '', recursive: body.recursive === true };
  if (action === 'upload') {
    return {
      path: optionalString(body.path) ?? '',
      base64Content: typeof body.base64Content === 'string' ? body.base64Content : undefined,
      contentType: optionalString(body.contentType),
    };
  }
  return { path: optionalString(body.path) ?? '' };
};

const portalToolForAction = (action: WorkspaceFileAction) =>
  action === 'diffPreview' ? 'portal.fs.diffPreview' : `portal.fs.${action}`;

const createNotesWorkspaceFileWatchTarget = (
  project: WorkspaceFileProject,
  resourceId: string,
  body: Record<string, unknown>,
  deps: WorkspaceFileRouteDeps = {},
) => {
  const notesTarget = parseNotesVaultTarget(body);
  const { binding } = resolveNotesVaultForProject(project as NotesProject, resourceId, notesTarget, deps);
  if (binding.storage.kind !== 'portal' || typeof binding.storage.portalId !== 'string' || !binding.storage.portalId) {
    throw new Error('Workspace file watching is only available for Portal-backed Notes Projects.');
  }

  return {
    portalId: binding.storage.portalId,
    projectId: binding.projectId,
    workspaceId: binding.workspaceId,
    rootId: binding.storage.rootId,
    repoPath: binding.storage.vaultPath,
    workspacePath: binding.storage.workspacePath,
  };
};

const handleWorkspaceFileRoute = async (
  c: any,
  action: WorkspaceFileAction,
  timeoutMs = 10_000,
  deps: WorkspaceFileRouteDeps = {},
) => {
  try {
    const resourceId = getResourceId(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const target = parseTarget(body);
    const memory = await getMemory(c);
    if (!target.projectId) throw new Error('Project is required for workspace files.');
    const project = await getProject(memory, resourceId, target.projectId);
    if (!project) throw new Error('Project was not found.');

    if (project.projectKind === 'notes') {
      if (action === 'hash' || action === 'diffPreview') {
        throw new Error('This workspace file operation is only available for Git Projects.');
      }
      const notesAction = action as 'index' | 'read' | 'write' | 'mkdir' | 'move' | 'delete' | 'upload';
      const notesTarget = parseNotesVaultTarget(body);
      const { backend, binding } = resolveNotesVaultForProject(project as NotesProject, resourceId, notesTarget, deps);
      const result = await invokeNotesBackend(backend, binding, notesAction, notesActionInput(notesAction, body), timeoutMs);
      return c.json(cleanNotesResult(result, notesAction));
    }

    if (action === 'index') throw new Error('Workspace file indexing is only available for Notes Projects.');
    const requiredCapability = action === 'hash' || action === 'diffPreview' ? portalToolForAction(action) : undefined;
    const resolvedTarget = resolveGitWorkspaceFileTarget(resourceId, target, project, requiredCapability);
    const result = await requestPortalTool({
      ...resolvedTarget,
      tool: portalToolForAction(action),
      args: portalArgs(action, body),
      timeoutMs,
    });
    return c.json(cleanPortalResult(result));
  } catch (error) {
    return errorResponse(c, error);
  }
};

const handleWorkspaceFileWatchTokenRoute = async (
  c: any,
  deps: WorkspaceFileRouteDeps = {},
) => {
  try {
    const resourceId = getResourceId(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const target = parseTarget(body);
    const memory = await getMemory(c);
    if (!target.projectId) throw new Error('Project is required for workspace file watching.');
    const project = await getProject(memory, resourceId, target.projectId);
    if (!project) throw new Error('Project was not found.');

    const resolvedTarget = project.projectKind === 'notes'
      ? createNotesWorkspaceFileWatchTarget(project, resourceId, body, deps)
      : resolveGitWorkspaceFileTarget(resourceId, target, project, 'portal.fs.watch');
    const token = issueWorkspaceFileWatchToken({ resourceId, ...resolvedTarget });
    return c.json({
      token,
      portalId: resolvedTarget.portalId,
      wsUrl: getWorkspaceFileWatchWsUrl(c),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
};

const getWorkspaceFileWatchWsUrl = (c: any) => {
  const configured = process.env.WEAVE_PORTAL_WS_PUBLIC_URL?.replace(/\/+$/, '');
  if (configured) return `${configured}/workspace-files/watch/connect`;

  const url = new URL(c.req.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.port = process.env.WEAVE_PORTAL_WS_PUBLIC_PORT ?? process.env.WEAVE_PORTAL_WS_PORT ?? '4112';
  url.pathname = '/workspace-files/watch/connect';
  url.search = '';
  url.hash = '';
  return url.toString();
};

export const workspaceFileRoutes = [
  defineRoute('/workspace-files/list', {
    method: 'POST',
    handler: async c => handleWorkspaceFileRoute(c, 'list'),
  }),
  defineRoute('/workspace-files/read', {
    method: 'POST',
    handler: async c => handleWorkspaceFileRoute(c, 'read'),
  }),
  defineRoute('/workspace-files/write', {
    method: 'POST',
    handler: async c => handleWorkspaceFileRoute(c, 'write'),
  }),
  defineRoute('/workspace-files/mkdir', {
    method: 'POST',
    handler: async c => handleWorkspaceFileRoute(c, 'mkdir'),
  }),
  defineRoute('/workspace-files/move', {
    method: 'POST',
    handler: async c => handleWorkspaceFileRoute(c, 'move'),
  }),
  defineRoute('/workspace-files/delete', {
    method: 'POST',
    handler: async c => handleWorkspaceFileRoute(c, 'delete'),
  }),
  defineRoute('/workspace-files/upload', {
    method: 'POST',
    handler: async c => handleWorkspaceFileRoute(c, 'upload'),
  }),
  defineRoute('/workspace-files/index', {
    method: 'POST',
    handler: async c => handleWorkspaceFileRoute(c, 'index', 30_000),
  }),
  defineRoute('/workspace-files/hash', {
    method: 'POST',
    handler: async c => handleWorkspaceFileRoute(c, 'hash'),
  }),
  defineRoute('/workspace-files/diff-preview', {
    method: 'POST',
    handler: async c => handleWorkspaceFileRoute(c, 'diffPreview'),
  }),
  defineRoute('/workspace-files/watch-token', {
    method: 'POST',
    handler: handleWorkspaceFileWatchTokenRoute,
  }),
];

export const __workspaceFileRoutesTest = {
  cleanPortalResult,
  handleWorkspaceFileWatchTokenRoute,
  handleWorkspaceFileRoute,
  parseTarget,
};
