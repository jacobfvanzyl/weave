import { readFileSync } from 'node:fs';
import { productProjectRepository } from '../../../products/project-repository';
import { listPortalConnections, requestPortalTool, resolvePortalForTarget } from '../../../portal/registry';
import { portalRepository } from '../../../portal/store';
import { registerResolvedContextSkills } from './skill-source';

export type WeaveContextFileKind = 'config' | 'mcp' | 'prompt' | 'skill' | 'agents';

export type WeaveContextFile = {
  kind: WeaveContextFileKind;
  path: string;
  content: string;
  size?: number;
  updatedAt?: string;
};

export type WeaveContextSnapshot = {
  scope: 'global' | 'project';
  portalId?: string;
  basePath?: string;
  workspacePath?: string;
  files: WeaveContextFile[];
  checkedAt: string;
};

export type AgentRuntimeConfig = {
  instructions: string;
  model: string;
  reasoningEffort: string;
  serviceTier?: string;
  memory: Record<string, unknown>;
};

export type RuntimeProjectContext = {
  thread?: any;
  threadMetadata?: Record<string, unknown>;
  project?: Record<string, any>;
  workspace?: Record<string, any>;
  projectKind?: 'general' | 'git' | 'notes';
  portalId?: string;
  projectSnapshot?: WeaveContextSnapshot;
  agentFiles: WeaveContextFile[];
};

export type ResolvedAgentContext = RuntimeProjectContext & {
  config: AgentRuntimeConfig;
  globalSnapshot?: WeaveContextSnapshot;
};

export type AgentContextInput = {
  mastra: any;
  resourceId: string;
  threadId?: unknown;
  projectId?: unknown;
  workspaceId?: unknown;
};

const agentId = 'mageHandAgent';
const projectThreadId = (projectId: string) => `__project__${projectId}`;
const portalSettingsThreadIdPrefix = '__portal_settings__';
const globalSnapshotRefreshMs = 30_000;
const projectSnapshotRefreshMs = 30_000;

export const agentContextRequestContextKey = 'weave.agentContext';
export const contextSkillPathsRequestContextKey = 'weave.contextSkillPaths';

export const singletonBaseInstructions = readFileSync(new URL('./base-instructions.md', import.meta.url), 'utf8')
  .trim();

export const singletonAgentConfig: AgentRuntimeConfig = {
  instructions: singletonBaseInstructions,
  model: process.env.WEAVE_DEFAULT_MODEL ?? 'openai/gpt-5.5',
  reasoningEffort: 'high',
  serviceTier: undefined,
  memory: {},
};

const globalSnapshots = new Map<string, WeaveContextSnapshot>();
const projectSnapshots = new Map<string, WeaveContextSnapshot>();

const nowIso = () => new Date().toISOString();

const hashText = async (value: string) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes)).slice(0, 12).map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const getMemory = async (mastra: any) => {
  const agent = await mastra?.getAgent(agentId);
  const memory = await agent?.getMemory();
  if (!memory) throw new Error(`${agentId} has no memory configured`);
  return memory;
};

const stale = (snapshot: WeaveContextSnapshot | undefined, refreshMs: number) =>
  !snapshot || Date.now() - Date.parse(snapshot.checkedAt) > refreshMs;

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const getLegacyPrimaryPortalId = async (memory: any, resourceId: string) => {
  const threadId = `${portalSettingsThreadIdPrefix}${await hashText(resourceId)}`;
  const thread = await memory.getThreadById({ threadId }).catch(() => undefined);
  const metadata = thread?.metadata as Record<string, unknown> | undefined;
  return optionalString(metadata?.primaryPortalId);
};

const getPrimaryPortalId = async (memory: any, resourceId: string) => {
  const stored = await portalRepository.getPrimaryPortalId(resourceId);
  if (stored) return stored;

  const legacy = await getLegacyPrimaryPortalId(memory, resourceId);
  if (legacy) await portalRepository.setPrimaryPortalId(resourceId, legacy).catch(() => undefined);
  return legacy;
};

const discoverPortalContext = async (
  portalId: string,
  scope: 'global' | 'project',
  args: Record<string, unknown> = {},
) => {
  const result = await requestPortalTool({
    portalId,
    ...(typeof args.projectId === 'string' ? { projectId: args.projectId } : {}),
    ...(typeof args.workspaceId === 'string' ? { workspaceId: args.workspaceId } : {}),
    ...(typeof args.rootId === 'string' ? { rootId: args.rootId } : {}),
    ...(typeof args.repoPath === 'string' ? { repoPath: args.repoPath } : {}),
    ...(typeof args.workspacePath === 'string' ? { workspacePath: args.workspacePath } : {}),
    tool: 'portal.context.discover',
    args: { scope },
    timeoutMs: 10_000,
  }) as {
    ok?: boolean;
    error?: string;
    scope?: string;
    basePath?: string;
    workspacePath?: string;
    files?: Array<{
      kind?: unknown;
      path?: unknown;
      content?: unknown;
      size?: unknown;
      updatedAt?: unknown;
    }>;
  };
  if (result.ok === false) throw new Error(result.error ?? 'Portal context discovery failed');
  return {
    scope,
    portalId,
    basePath: optionalString(result.basePath),
    workspacePath: optionalString(result.workspacePath),
    files: Array.isArray(result.files)
      ? result.files.filter((file): file is WeaveContextFile => {
        const kind = file?.kind === 'config' ||
          file?.kind === 'mcp' ||
          file?.kind === 'prompt' ||
          file?.kind === 'skill' ||
          file?.kind === 'agents';
        return kind &&
          typeof file.content === 'string' &&
          typeof file.path === 'string' &&
          (file.size === undefined || typeof file.size === 'number') &&
          (file.updatedAt === undefined || typeof file.updatedAt === 'string');
      })
      : [],
    checkedAt: nowIso(),
  } satisfies WeaveContextSnapshot;
};

const loadGlobalSnapshot = async (memory: any, resourceId: string) => {
  const cached = globalSnapshots.get(resourceId);
  if (!stale(cached, globalSnapshotRefreshMs)) return cached;

  const primaryPortalId = await getPrimaryPortalId(memory, resourceId);
  const portals = listPortalConnections(resourceId);
  const portal = primaryPortalId ? portals.find((item) => item.portalId === primaryPortalId) : portals[0];
  if (!portal) return cached;

  try {
    const snapshot = await discoverPortalContext(portal.portalId, 'global');
    globalSnapshots.set(resourceId, snapshot);
    return snapshot;
  } catch (error) {
    console.warn('[agent-context] global context discovery failed', error);
    return cached;
  }
};

const resolveProjectPortalId = (
  resourceId: string,
  project: Record<string, any>,
  workspace: Record<string, any> | undefined,
) => {
  const portalId = optionalString(workspace?.portalId) ?? optionalString(project.portalId);
  return resolvePortalForTarget({
    userId: resourceId,
    portalId,
    projectId: optionalString(project.id),
    rootId: optionalString(project.portalRootId),
    repoPath: optionalString(project.repoPath),
    workspacePath: optionalString(workspace?.path),
  })?.portalId;
};

const loadProjectSnapshot = async (
  resourceId: string,
  project: Record<string, any>,
  workspace: Record<string, any> | undefined,
  portalId: string | undefined,
) => {
  if (!portalId) return undefined;
  const workspacePath = optionalString(workspace?.path);
  const key = `${portalId}:${workspacePath ?? project.id ?? ''}`;
  const cached = projectSnapshots.get(key);
  if (!stale(cached, projectSnapshotRefreshMs)) return cached;

  try {
    const snapshot = await discoverPortalContext(portalId, 'project', {
      projectId: project.id,
      workspaceId: workspace?.id,
      rootId: project.portalRootId,
      repoPath: project.repoPath,
      workspacePath,
    });
    projectSnapshots.set(key, snapshot);
    return snapshot;
  } catch (error) {
    console.warn('[agent-context] project context discovery failed', error);
    return cached;
  }
};

const getProjectContext = async (
  memory: any,
  resourceId: string,
  thread: any | undefined,
  threadMetadata: Record<string, unknown> | undefined,
): Promise<RuntimeProjectContext> => {
  if (threadMetadata?.mode !== 'project' || typeof threadMetadata.projectId !== 'string') {
    return { thread, threadMetadata, agentFiles: [] };
  }

  let project = await productProjectRepository.get(resourceId, threadMetadata.projectId) as
    | Record<string, any>
    | undefined;
  if (!project) {
    const projectThread = await memory.getThreadById({ threadId: projectThreadId(threadMetadata.projectId) }).catch(
      () => undefined,
    );
    const projectMetadata = projectThread?.metadata as Record<string, any> | undefined;
    if (!projectThread || projectThread.resourceId !== resourceId || projectMetadata?.kind !== 'project') {
      return { thread, threadMetadata, agentFiles: [] };
    }
    project = projectMetadata;
    await productProjectRepository.save(projectMetadata as any).catch(() => undefined);
  }

  const workspace = Array.isArray(project.workspaces) && typeof threadMetadata.workspaceId === 'string'
    ? project.workspaces.find((item: any) => item?.id === threadMetadata.workspaceId)
    : undefined;
  const portalId = resolveProjectPortalId(resourceId, project, workspace);
  const projectSnapshot = await loadProjectSnapshot(resourceId, project, workspace, portalId);
  return {
    thread,
    threadMetadata,
    project,
    workspace,
    projectKind: project.projectKind === 'git' || project.projectKind === 'notes' ? project.projectKind : 'general',
    portalId,
    projectSnapshot,
    agentFiles: projectSnapshot?.files.filter((file) => file.kind === 'agents') ?? [],
  };
};

const getRuntimeProjectContext = async (
  memory: any,
  resourceId: string,
  input: Pick<AgentContextInput, 'threadId' | 'projectId' | 'workspaceId'>,
): Promise<RuntimeProjectContext> => {
  if (typeof input.threadId === 'string') {
    const thread = await memory.getThreadById({ threadId: input.threadId }).catch(() => undefined);
    if (thread?.resourceId === resourceId) {
      return getProjectContext(memory, resourceId, thread, thread.metadata as Record<string, unknown> | undefined);
    }
  }

  const draftProjectId = optionalString(input.projectId);
  if (!draftProjectId) return { agentFiles: [] };

  const draftWorkspaceId = optionalString(input.workspaceId);
  return getProjectContext(memory, resourceId, undefined, {
    mode: 'project',
    projectId: draftProjectId,
    ...(draftWorkspaceId ? { workspaceId: draftWorkspaceId } : {}),
  });
};

export const resolveAgentContext = async (input: AgentContextInput): Promise<ResolvedAgentContext> => {
  const memory = await getMemory(input.mastra);
  const [globalSnapshot, projectContext] = await Promise.all([
    loadGlobalSnapshot(memory, input.resourceId),
    getRuntimeProjectContext(memory, input.resourceId, input),
  ]);

  return {
    ...projectContext,
    config: singletonAgentConfig,
    globalSnapshot,
  };
};

export const putAgentContext = (requestContext: any, resolved: ResolvedAgentContext) => {
  requestContext?.set?.(agentContextRequestContextKey, resolved);
  requestContext?.set?.(contextSkillPathsRequestContextKey, registerResolvedContextSkills(resolved));
};

export const getAgentContext = (requestContext: any) =>
  requestContext?.get?.(agentContextRequestContextKey) as ResolvedAgentContext | undefined;

export const hasWorkspaceBinding = (context: ResolvedAgentContext | undefined) =>
  context?.threadMetadata?.mode === 'project' &&
  typeof context.threadMetadata.workspaceId === 'string' &&
  Boolean(context.workspace);

export const hasPortalWorkspaceBinding = (context: ResolvedAgentContext | undefined) =>
  hasWorkspaceBinding(context) && typeof context?.portalId === 'string' && context.portalId.length > 0;

export const isPortalBackedNotesContext = (context: ResolvedAgentContext | undefined) => {
  if (context?.projectKind !== 'notes') return false;
  const storage = context.project?.notesStorage;
  return !storage || storage.kind === 'portal';
};

export const __agentContextResolverTest = {
  getRuntimeProjectContext,
  hasPortalWorkspaceBinding,
  hasWorkspaceBinding,
  isPortalBackedNotesContext,
  singletonAgentConfig,
};
