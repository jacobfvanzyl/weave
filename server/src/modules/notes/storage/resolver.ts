import { findPortalForProject, getPortalConnection, resolvePortalForTarget } from '../../../portal/registry';
import { productProjectRepository } from '../../../products/project-repository';
import { portalToolScope } from '../../../services/providers/portal-provider';
import type { ToolService } from '../../../services/tool-service';
import { callerForOwner, type ServiceCaller, ServiceError } from '../../../services/types';
import { getNotesVaultBackend } from './registry';
import type {
  NotesProject,
  NotesStorageMetadata,
  NotesVaultBackend,
  NotesVaultTarget,
  NotesWorkspace,
  ResolvedNotesVault,
} from './types';

const projectThreadPrefix = '__project__';

type ThreadLike = {
  id: string;
  resourceId: string;
  metadata?: unknown;
};

type NotesVaultServiceCallerInput = {
  resourceId: string;
  project: NotesProject;
  storage: NotesStorageMetadata;
};

export type NotesVaultResolverDependencies = {
  findPortalForProject?: (resourceId: string, projectId: string) => { portalId?: string } | undefined;
  getBackend?: (kind: string) => NotesVaultBackend | undefined;
  getPortalConnection?: (portalId: string) => { userId: string } | undefined;
  resolvePortalForTarget?: (input: {
    userId: string;
    portalId?: string;
    projectId?: string;
    rootId?: string;
    repoPath?: string;
    workspacePath?: string;
  }) => { portalId: string; userId: string } | undefined;
  tools?: ToolService;
  callerKind?: ServiceCaller['kind'];
  correlation?: ServiceCaller['correlation'];
  createServiceCaller?: (input: NotesVaultServiceCallerInput) => ServiceCaller;
};

export class NotesVaultBackendNotRegisteredError extends Error {
  constructor(kind: string) {
    super(`Notes vault backend is not registered: ${kind}`);
    this.name = 'NotesVaultBackendNotRegisteredError';
  }
}

export const projectThreadId = (projectId: string) => `${projectThreadPrefix}${projectId}`;

export const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const isSensitiveStorageKey = (key: string) => /secret|token|password|credential|accesskey|privatekey/i.test(key);

const normalizeNotesStorageMetadata = (value: unknown): NotesStorageMetadata | undefined => {
  if (!isRecord(value) || typeof value.kind !== 'string' || !value.kind.trim()) return undefined;
  const sanitized = Object.fromEntries(
    Object.entries(value).filter(([key]) => !isSensitiveStorageKey(key)),
  );
  return {
    ...sanitized,
    kind: value.kind.trim(),
    portalId: optionalString(value.portalId),
    rootId: optionalString(value.rootId),
    vaultPath: optionalString(value.vaultPath),
    workspacePath: optionalString(value.workspacePath),
  };
};

export const sanitizeNotesStorageMetadata = (value: unknown) => normalizeNotesStorageMetadata(value);

export const toNotesProject = (thread: ThreadLike): NotesProject => {
  const metadata = (isRecord(thread.metadata) ? thread.metadata : {}) as Partial<NotesProject> & {
    workspaces?: NotesWorkspace[];
  };
  return {
    id: typeof metadata.id === 'string' ? metadata.id : thread.id.replace(projectThreadPrefix, ''),
    userId: thread.resourceId,
    projectKind: metadata.projectKind === 'git' || metadata.projectKind === 'notes' ? metadata.projectKind : 'general',
    portalId: metadata.portalId,
    portalRootId: metadata.portalRootId,
    repoPath: metadata.repoPath,
    vaultPath: metadata.vaultPath,
    notesStorage: sanitizeNotesStorageMetadata(metadata.notesStorage),
    workspaces: Array.isArray(metadata.workspaces) ? metadata.workspaces : [],
  };
};

export const isProjectThread = (thread: { id: string; metadata?: unknown }) => {
  const metadata = isRecord(thread.metadata) ? thread.metadata : undefined;
  return thread.id.startsWith(projectThreadPrefix) || metadata?.kind === 'project';
};

export const getNotesProject = async (memory: any, resourceId: string, projectId: string) => {
  const persisted = await productProjectRepository.get(resourceId, projectId);
  if (persisted) return persisted as NotesProject;

  const thread = await memory.getThreadById({ threadId: projectThreadId(projectId) }).catch(() => undefined);
  if (!thread || thread.resourceId !== resourceId || !isProjectThread(thread)) return undefined;
  return toNotesProject(thread);
};

export const parseNotesVaultTarget = (body: Record<string, unknown>): NotesVaultTarget => {
  const target = body.target && typeof body.target === 'object' ? body.target as Record<string, unknown> : body;
  return {
    projectId: optionalString(target.projectId),
    workspaceId: optionalString(target.workspaceId),
    portalId: optionalString(target.portalId),
    rootId: optionalString(target.rootId),
    repoPath: optionalString(target.repoPath),
    workspacePath: optionalString(target.workspacePath),
  };
};

type DirectResolverDependencies = Required<
  Pick<
    NotesVaultResolverDependencies,
    'findPortalForProject' | 'getBackend' | 'getPortalConnection' | 'resolvePortalForTarget'
  >
>;

type NormalizedResolverDependencies = DirectResolverDependencies & NotesVaultResolverDependencies;

const defaultDependencies = (): DirectResolverDependencies => ({
  findPortalForProject,
  getBackend: getNotesVaultBackend,
  getPortalConnection,
  resolvePortalForTarget,
});

const normalizeStorageForProject = (
  project: NotesProject,
  workspace: NotesWorkspace,
  target: NotesVaultTarget,
): NotesStorageMetadata => {
  const configuredStorage = sanitizeNotesStorageMetadata(project.notesStorage);
  if (configuredStorage) {
    if (configuredStorage.kind !== 'portal') return configuredStorage;
    return {
      ...configuredStorage,
      portalId: configuredStorage.portalId ?? workspace.portalId ?? project.portalId ?? target.portalId,
      rootId: configuredStorage.rootId ?? project.portalRootId ?? target.rootId,
      vaultPath: configuredStorage.vaultPath ?? project.vaultPath ?? target.repoPath,
      workspacePath: configuredStorage.workspacePath ?? workspace.path ?? target.workspacePath,
    };
  }

  return {
    kind: 'portal',
    portalId: workspace.portalId ?? project.portalId ?? target.portalId,
    rootId: project.portalRootId ?? target.rootId,
    vaultPath: project.vaultPath ?? target.repoPath,
    workspacePath: workspace.path ?? target.workspacePath,
  };
};

const createServiceCaller = (
  resourceId: string,
  project: NotesProject,
  storage: NotesStorageMetadata,
  deps: NotesVaultResolverDependencies,
) =>
  deps.createServiceCaller?.({ resourceId, project, storage }) ??
    callerForOwner(resourceId, deps.callerKind ?? 'ui', deps.correlation);

const resolvePortalStorage = (
  storage: NotesStorageMetadata,
  project: NotesProject,
  resourceId: string,
  deps: NormalizedResolverDependencies,
) => {
  const mountedPortal = deps.findPortalForProject(resourceId, project.id);
  const resolvedPortal = deps.resolvePortalForTarget({
    userId: resourceId,
    portalId: storage.portalId,
    projectId: project.id,
    rootId: storage.rootId,
    repoPath: storage.vaultPath,
    workspacePath: storage.workspacePath,
  });
  const portalId = resolvedPortal?.portalId ?? storage.portalId ?? mountedPortal?.portalId;
  if (!portalId) throw new Error('No online Portal is available for this vault.');
  const portal = deps.getPortalConnection(portalId);
  if (!portal || portal.userId !== resourceId) throw new Error('Portal is offline or unavailable.');
  return { ...storage, kind: 'portal', portalId };
};

const resolvePortalStorageWithService = async (
  storage: NotesStorageMetadata,
  project: NotesProject,
  resourceId: string,
  deps: NormalizedResolverDependencies,
) => {
  if (!deps.tools) return resolvePortalStorage(storage, project, resourceId, deps);

  try {
    const caller = createServiceCaller(resourceId, project, storage, deps);
    const resolved = await deps.tools.resolvePortalTarget(
      caller,
      portalToolScope({
        portalId: storage.portalId,
        projectId: project.id,
        rootId: storage.rootId,
        repoPath: storage.vaultPath,
        workspacePath: storage.workspacePath,
      }),
    );
    return {
      ...storage,
      kind: 'portal',
      portalId: resolved.portalId,
      rootId: storage.rootId ?? resolved.rootId,
    };
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'provider_offline') {
      throw new Error(
        storage.portalId ? 'Portal is offline or unavailable.' : 'No online Portal is available for this vault.',
      );
    }
    throw error;
  }
};

const prepareNotesVaultResolution = (
  project: NotesProject | undefined,
  resourceId: string,
  target: NotesVaultTarget,
  dependencies: NotesVaultResolverDependencies = {},
): {
  backend: NotesVaultBackend;
  deps: NormalizedResolverDependencies;
  project: NotesProject;
  storage: NotesStorageMetadata;
  workspace: NotesWorkspace;
} => {
  if (!project || project.userId !== resourceId) throw new Error('Project was not found.');
  if (project.projectKind !== 'notes') throw new Error('Notes file operations are only available for Notes Projects.');

  const workspace = target.workspaceId
    ? project.workspaces.find((item) => item.id === target.workspaceId)
    : project.workspaces[0];
  if (!workspace) throw new Error('Notes workspace was not found.');

  const deps = { ...defaultDependencies(), ...dependencies };
  const storage = normalizeStorageForProject(project, workspace, target);
  const backend = deps.getBackend(storage.kind);
  if (!backend) throw new NotesVaultBackendNotRegisteredError(storage.kind);
  return { backend, deps, project, storage, workspace };
};

export const resolveNotesVaultForProject = (
  project: NotesProject | undefined,
  resourceId: string,
  target: NotesVaultTarget,
  dependencies: NotesVaultResolverDependencies = {},
): ResolvedNotesVault => {
  const prepared = prepareNotesVaultResolution(project, resourceId, target, dependencies);
  if (prepared.storage.kind === 'portal' && prepared.deps.tools) {
    throw new Error('resolveNotesVaultForProjectAsync is required when resolving Notes vaults through ToolService.');
  }
  const resolvedStorage = prepared.storage.kind === 'portal'
    ? resolvePortalStorage(prepared.storage, prepared.project, resourceId, prepared.deps)
    : prepared.storage;

  return {
    backend: prepared.backend,
    binding: {
      resourceId,
      projectId: prepared.project.id,
      workspaceId: prepared.workspace.id,
      storage: resolvedStorage,
      project: prepared.project,
      workspace: prepared.workspace,
    },
  };
};

export const resolveNotesVaultForProjectAsync = async (
  project: NotesProject | undefined,
  resourceId: string,
  target: NotesVaultTarget,
  dependencies: NotesVaultResolverDependencies = {},
): Promise<ResolvedNotesVault> => {
  const prepared = prepareNotesVaultResolution(project, resourceId, target, dependencies);
  const resolvedStorage = prepared.storage.kind === 'portal'
    ? await resolvePortalStorageWithService(prepared.storage, prepared.project, resourceId, prepared.deps)
    : prepared.storage;

  return {
    backend: prepared.backend,
    binding: {
      resourceId,
      projectId: prepared.project.id,
      workspaceId: prepared.workspace.id,
      storage: resolvedStorage,
      project: prepared.project,
      workspace: prepared.workspace,
    },
  };
};

export const resolveNotesVault = async (
  memory: any,
  resourceId: string,
  target: NotesVaultTarget,
  dependencies: NotesVaultResolverDependencies = {},
) => {
  if (!target.projectId) throw new Error('Project is required for this vault.');
  const project = await getNotesProject(memory, resourceId, target.projectId);
  return resolveNotesVaultForProjectAsync(project, resourceId, target, dependencies);
};

export const resolveNotesVaultForThreadContext = async (
  context: any,
  dependencies: NotesVaultResolverDependencies = {},
) => {
  const threadId = context.agent?.threadId;
  const contextResourceId = context.agent?.resourceId;
  if (!threadId) throw new Error('This thread is not bound to an active Notes Project.');

  const agent = await context.mastra?.getAgent('mageHandAgent');
  const memory = await agent?.getMemory();
  const thread = await memory?.getThreadById({ threadId });
  const resourceId = typeof contextResourceId === 'string' && contextResourceId
    ? contextResourceId
    : thread?.resourceId;
  const metadata = isRecord(thread?.metadata) ? thread?.metadata : undefined;

  if (!thread || !resourceId || thread.resourceId !== resourceId) {
    throw new Error('This thread is not bound to an active Notes Project.');
  }
  if (metadata?.mode !== 'project' || typeof metadata.projectId !== 'string') {
    throw new Error('This thread is not bound to an active Notes Project.');
  }

  return resolveNotesVault(memory, resourceId, {
    projectId: metadata.projectId,
    workspaceId: typeof metadata.workspaceId === 'string' ? metadata.workspaceId : undefined,
  }, dependencies);
};
