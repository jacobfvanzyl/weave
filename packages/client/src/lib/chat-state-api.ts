import type { UIMessage } from 'ai';
import { getAuthHeaders, getMastraUrl } from './mastra-client';
import type { ChatThread, PlanStepStatus, ThreadPlan, ThreadPlanStep } from '../stores/chat-store';

type ServerThread = {
  id: string;
  title?: string;
  resourceId: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
};

export type BranchCleanupStatus =
  | 'not_requested'
  | 'not_applicable'
  | 'not_pushed'
  | 'not_merged'
  | 'deleted'
  | 'failed';

export type BranchCleanupTargetKind =
  | 'upstream'
  | 'same_name_remote'
  | 'default_branch';

export type BranchCleanup = {
  requested: boolean;
  status: BranchCleanupStatus;
  eligible?: boolean;
  branch?: string;
  targetRef?: string;
  targetKind?: BranchCleanupTargetKind;
  error?: string;
};

export type RemovedWorkspaceSnapshot = {
  id: string;
  projectId: string;
  name: string;
  path?: string;
  branch?: string;
  removedAt: string;
};

export type Workspace = {
  id: string;
  projectId: string;
  portalId?: string;
  mountId?: string;
  workspaceKind: 'primary' | 'worktree';
  source?: 'primary' | 'git' | 'notes' | 'adopted' | 'legacy';
  name: string;
  path?: string;
  status: 'ready' | 'offline' | 'creating' | 'dirty' | 'missing' | 'virtual' | 'error';
  locked?: boolean;
  branch?: string;
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  detached?: boolean;
  baseBranch?: string;
  sortOrder?: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceRemovalPreview = {
  workspace: Workspace;
  activeThreadCount: number;
  archivedThreadCount: number;
  branchCleanup: BranchCleanup;
};

export type DeleteWorkspaceOptions = {
  mode: 'detach' | 'remove';
  force?: boolean;
  deleteLocalBranch?: boolean;
};

export type DeleteWorkspaceResult = WorkspaceRemovalPreview & {
  project: Project;
  mode: 'detach' | 'remove';
  force?: boolean;
  removedWorkspace?: RemovedWorkspaceSnapshot;
};

export type WorkspaceGitState = {
  projectId: string;
  workspaceId: string;
  path?: string;
  status: Workspace['status'];
  branch?: string;
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  detached?: boolean;
  checkedAt: string;
  lastError?: string;
};

export type WorkspaceBranchOption = {
  name: string;
  ref: string;
  kind: 'local' | 'remote';
  current?: boolean;
};

export type DiscoveredWorktree = {
  path?: string;
  branch?: string;
  commit?: string;
  head?: string;
  detached?: boolean;
  adopted?: boolean;
  workspaceId?: string;
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
  workspaces: Workspace[];
  createdAt: string;
  updatedAt: string;
};

const toRemovedWorkspace = (value: unknown): RemovedWorkspaceSnapshot | undefined => {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  const id = typeof record?.id === 'string' ? record.id : undefined;
  const projectId = typeof record?.projectId === 'string' ? record.projectId : undefined;
  const name = typeof record?.name === 'string' ? record.name : undefined;
  const removedAt = typeof record?.removedAt === 'string' ? record.removedAt : undefined;
  if (!id || !projectId || !name || !removedAt) return undefined;
  return {
    id,
    projectId,
    name,
    path: typeof record?.path === 'string' ? record.path : undefined,
    branch: typeof record?.branch === 'string' ? record.branch : undefined,
    removedAt,
  };
};

const isPlanStepStatus = (value: unknown): value is PlanStepStatus =>
  value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'blocked';

const toPlanStep = (value: unknown): ThreadPlanStep | undefined => {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const step = typeof record?.step === 'string'
    ? record.step
    : typeof record?.text === 'string'
      ? record.text
      : undefined;
  if (!step || !isPlanStepStatus(record?.status)) return undefined;
  return {
    step,
    status: record.status,
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
  };
};

const toThreadPlan = (value: unknown): ThreadPlan | undefined => {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const sourcePlan = Array.isArray(record?.checklist)
    ? record.checklist
    : Array.isArray(record?.plan)
      ? record.plan
      : undefined;
  if (!sourcePlan) return undefined;

  const plan = sourcePlan.map(toPlanStep).filter((item): item is ThreadPlanStep => Boolean(item));
  if (plan.length === 0) return undefined;

  return {
    plan,
    completed: typeof record?.completed === 'number' ? record.completed : plan.filter(item => item.status === 'completed').length,
    total: typeof record?.total === 'number' ? record.total : plan.length,
    updatedAt: typeof record?.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
    ...(typeof record?.id === 'string' ? { id: record.id } : {}),
    ...(typeof record?.title === 'string' ? { title: record.title } : {}),
    ...(typeof record?.path === 'string' ? { path: record.path } : {}),
    ...(isPlanStepStatus(record?.status) ? { status: record.status } : {}),
    ...(typeof record?.contentHash === 'string' ? { contentHash: record.contentHash } : {}),
  };
};

const toChatThread = (thread: ServerThread): ChatThread => ({
  id: thread.id,
  title: thread.title || '...',
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  sortOrder: typeof thread.metadata?.sortOrder === 'number' ? thread.metadata.sortOrder : undefined,
  projectId: typeof thread.metadata?.projectId === 'string' ? thread.metadata.projectId : undefined,
  workspaceId: typeof thread.metadata?.workspaceId === 'string' ? thread.metadata.workspaceId : undefined,
  archived: thread.metadata?.archived === true,
  profileId: typeof thread.metadata?.profileId === 'string' ? thread.metadata.profileId : undefined,
  adHoc: thread.metadata?.adHoc === true,
  workspacePath: typeof thread.metadata?.workspacePath === 'string' ? thread.metadata.workspacePath : undefined,
  removedWorkspace: toRemovedWorkspace(thread.metadata?.removedWorkspace),
  latestPlan: toThreadPlan(thread.metadata?.latestPlan),
});

export class ApiError extends Error {
  status: number;
  code?: string;
  body?: unknown;

  constructor(message: string, status: number, options: { code?: string; body?: unknown } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = options.code;
    this.body = options.body;
  }
}

const parseJson = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    const text = await response.text();
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      throw new ApiError(
        typeof body.error === 'string' ? body.error : text,
        response.status,
        { code: typeof body.code === 'string' ? body.code : undefined, body },
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(text, response.status);
    }
  }

  return response.json() as Promise<T>;
};

export type AuthUser = {
  id: string;
  name: string;
};

export const getAuthUser = async () => {
  const result = await parseJson<{ user: AuthUser }>(
    await fetch(`${getMastraUrl()}/chat-state/me`, { headers: getAuthHeaders() }),
  );

  return result.user;
};

export const listServerThreads = async () => {
  const result = await parseJson<{ threads: ServerThread[] }>(
    await fetch(`${getMastraUrl()}/chat-state/threads`, { headers: getAuthHeaders() }),
  );

  return result.threads.map(toChatThread);
};

export const createServerThread = async (threadId: string, projectId?: string, workspaceId?: string, title = '...', profileId?: string) => {
  const result = await parseJson<{ thread: ServerThread }>(
    await fetch(`${getMastraUrl()}/chat-state/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ threadId, title, projectId, workspaceId, profileId }),
    }),
  );

  return toChatThread(result.thread);
};

export const setServerThreadProfile = async (threadId: string, profileId: string | null) => {
  const result = await parseJson<{ thread: ServerThread }>(
    await fetch(`${getMastraUrl()}/chat-state/threads/${threadId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ profileId }),
    }),
  );

  return toChatThread(result.thread);
};

export const archiveServerThread = async (threadId: string, archived = true) => {
  const result = await parseJson<{ thread: ServerThread }>(
    await fetch(`${getMastraUrl()}/chat-state/threads/${threadId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ archived }),
    }),
  );

  return toChatThread(result.thread);
};

export const renameServerThread = async (threadId: string, title: string) => {
  const result = await parseJson<{ thread: ServerThread }>(
    await fetch(`${getMastraUrl()}/chat-state/threads/${threadId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ title }),
    }),
  );

  return toChatThread(result.thread);
};

export const deleteServerThread = async (threadId: string) => {
  await parseJson<{ ok: true }>(
    await fetch(`${getMastraUrl()}/chat-state/threads/${threadId}`, { method: 'DELETE', headers: getAuthHeaders() }),
  );
};

export const listProjects = async () => {
  const result = await parseJson<{ projects: Project[] }>(
    await fetch(`${getMastraUrl()}/projects`, { headers: getAuthHeaders() }),
  );

  return result.projects;
};

export const listWorkspaceGitStates = async () => {
  const result = await parseJson<{ states: WorkspaceGitState[] }>(
    await fetch(`${getMastraUrl()}/projects/workspaces/git-state`, { headers: getAuthHeaders() }),
  );

  return result.states;
};

export const listProjectBranches = async (projectId: string) => {
  const result = await parseJson<{ branches: WorkspaceBranchOption[] }>(
    await fetch(`${getMastraUrl()}/projects/${projectId}/branches`, { headers: getAuthHeaders() }),
  );

  return result.branches;
};

export type PortalRoot = {
  id: string;
  name?: string;
};

export type PortalConnection = {
  portalId: string;
  userId: string;
  name?: string;
  capabilities: string[];
  roots: PortalRoot[];
  status: 'online' | 'offline';
  primary?: boolean;
};

export type PortalBrowseEntry = {
  name: string;
  type: 'directory' | 'file' | 'other';
  hidden?: boolean;
};

export type PortalBrowseResult = {
  ok?: boolean;
  rootId: string;
  path: string;
  realPath?: string;
  entries: PortalBrowseEntry[];
  isGitRepo?: boolean;
  git?: Record<string, unknown>;
  error?: string;
};

export type CreateProjectInput = {
  name: string;
  projectKind?: 'general' | 'git' | 'notes';
  portalId?: string;
  rootId?: string;
  repoPath?: string;
  vaultPath?: string;
};

export type WorkspaceBranchMode = 'newBranch' | 'existingBranch' | 'detached';

export type CreateWorkspaceInput = {
  name: string;
  mode?: WorkspaceBranchMode;
  branch?: string;
  base?: string;
  path?: string;
};

export type UpdateWorkspaceInput = {
  name?: string;
  branch?: string;
  createBranch?: boolean;
  base?: string;
};

const normalizePortalRoots = (roots: unknown): PortalRoot[] => Array.isArray(roots)
  ? roots.flatMap(root => {
      const record = root && typeof root === 'object' ? root as Record<string, unknown> : undefined;
      const id = typeof record?.id === 'string' ? record.id.trim() : '';
      if (!id) return [];
      return [{ id, name: typeof record?.name === 'string' ? record.name : undefined }];
    })
  : [];

const normalizePortalConnection = (portal: unknown): PortalConnection | undefined => {
  const record = portal && typeof portal === 'object' ? portal as Record<string, unknown> : undefined;
  if (typeof record?.portalId !== 'string' || typeof record.userId !== 'string') return undefined;
  return {
    portalId: record.portalId,
    userId: record.userId,
    name: typeof record.name === 'string' ? record.name : undefined,
    capabilities: Array.isArray(record.capabilities) ? record.capabilities.filter((item): item is string => typeof item === 'string') : [],
    roots: normalizePortalRoots(record.roots),
    status: record.status === 'online' ? 'online' : 'offline',
    primary: record.primary === true,
  };
};

export const listPortals = async () => {
  const result = await parseJson<{ portals: unknown[] }>(
    await fetch(`${getMastraUrl()}/portals`, { headers: getAuthHeaders() }),
  );

  return result.portals.flatMap(portal => normalizePortalConnection(portal) ?? []);
};

export const browsePortal = async (portalId: string, rootId = 'default', path = '') => {
  const params = new URLSearchParams({ rootId, path });
  return parseJson<PortalBrowseResult>(
    await fetch(`${getMastraUrl()}/portals/${portalId}/browse?${params}`, { headers: getAuthHeaders() }),
  );
};

export const setPrimaryPortal = async (portalId: string) => {
  const result = await parseJson<{ ok: true; primaryPortalId: string; portals: unknown[] }>(
    await fetch(`${getMastraUrl()}/portals/${portalId}/primary`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
    }),
  );

  return {
    primaryPortalId: result.primaryPortalId,
    portals: result.portals.flatMap(portal => normalizePortalConnection(portal) ?? []),
  };
};

export const createProject = async (input: string | CreateProjectInput) => {
  const body = typeof input === 'string' ? { name: input, projectKind: 'general' } : input;
  const result = await parseJson<{ project: Project }>(
    await fetch(`${getMastraUrl()}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(body),
    }),
  );

  return result.project;
};

export const deleteProject = async (projectId: string) => {
  await parseJson<{ ok: true }>(
    await fetch(`${getMastraUrl()}/projects/${projectId}`, { method: 'DELETE', headers: getAuthHeaders() }),
  );
};

export const setProjectProfile = async (projectId: string, profileId: string | null) => {
  const result = await parseJson<{ project: Project }>(
    await fetch(`${getMastraUrl()}/projects/${projectId}/profile`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ profileId }),
    }),
  );

  return result.project;
};

export const reorderProjects = async (projectIds: string[]) => {
  const result = await parseJson<{ projects: Project[] }>(
    await fetch(`${getMastraUrl()}/projects/reorder`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ projectIds }),
    }),
  );

  return result.projects;
};

export const createWorkspace = async (projectId: string, input: string | CreateWorkspaceInput) => {
  const body = typeof input === 'string'
    ? { name: input, mode: 'newBranch' satisfies WorkspaceBranchMode, branch: input }
    : input;
  const result = await parseJson<{ project: Project; workspace: Workspace }>(
    await fetch(`${getMastraUrl()}/projects/${projectId}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(body),
    }),
  );

  return result.workspace;
};

export const updateWorkspace = async (projectId: string, workspaceId: string, input: UpdateWorkspaceInput) => {
  const result = await parseJson<{ project: Project; workspace: Workspace }>(
    await fetch(`${getMastraUrl()}/projects/${projectId}/workspaces/${workspaceId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(input),
    }),
  );

  return result.workspace;
};

export const fetchWorkspaceGitUpstream = async (projectId: string, workspaceId: string) => {
  const result = await parseJson<{ state: WorkspaceGitState }>(
    await fetch(`${getMastraUrl()}/projects/${projectId}/workspaces/${workspaceId}/git/fetch`, {
      method: 'POST',
      headers: getAuthHeaders(),
    }),
  );

  return result.state;
};

export const pullWorkspaceGitUpstream = async (projectId: string, workspaceId: string) => {
  const result = await parseJson<{ state: WorkspaceGitState }>(
    await fetch(`${getMastraUrl()}/projects/${projectId}/workspaces/${workspaceId}/git/pull`, {
      method: 'POST',
      headers: getAuthHeaders(),
    }),
  );

  return result.state;
};

export const adoptWorkspace = async (projectId: string, path: string, name?: string) => {
  const result = await parseJson<{ project: Project; workspace: Workspace }>(
    await fetch(`${getMastraUrl()}/projects/${projectId}/workspaces/adopt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ path, name }),
    }),
  );

  return result.workspace;
};

export const fetchWorkspaceRemovalPreview = async (projectId: string, workspaceId: string) => {
  return parseJson<WorkspaceRemovalPreview>(
    await fetch(`${getMastraUrl()}/projects/${projectId}/workspaces/${workspaceId}/removal-preview`, {
      headers: getAuthHeaders(),
    }),
  );
};

export const deleteWorkspace = async (
  projectId: string,
  workspaceId: string,
  input: 'detach' | 'remove' | DeleteWorkspaceOptions,
) => {
  const options = typeof input === 'string' ? { mode: input } : input;
  const params = new URLSearchParams({ mode: options.mode });
  if (options.force) params.set('force', 'true');
  if (options.deleteLocalBranch) params.set('deleteLocalBranch', 'true');

  const result = await parseJson<DeleteWorkspaceResult>(
    await fetch(`${getMastraUrl()}/projects/${projectId}/workspaces/${workspaceId}?${params}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    }),
  );

  return result;
};

export const discoverWorkspaces = async (projectId: string) => {
  const result = await parseJson<{ worktrees: DiscoveredWorktree[] }>(
    await fetch(`${getMastraUrl()}/projects/${projectId}/workspaces/discover`, { headers: getAuthHeaders() }),
  );

  return result.worktrees;
};

export const reorderWorkspaces = async (projectId: string, workspaceIds: string[]) => {
  const result = await parseJson<{ project: Project }>(
    await fetch(`${getMastraUrl()}/projects/${projectId}/workspaces/reorder`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ workspaceIds }),
    }),
  );

  return result.project;
};

export const createProjectThread = async (projectId: string, threadId: string, workspaceId?: string, title = '...', profileId?: string) => {
  const result = await parseJson<{ thread: ServerThread; workspace: Workspace }>(
    await fetch(`${getMastraUrl()}/projects/${projectId}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ threadId, title, workspaceId, profileId }),
    }),
  );

  return { thread: toChatThread(result.thread), workspace: result.workspace };
};

export const reorderThreads = async (scope: { plain?: true; projectId?: string; workspaceId?: string }, threadIds: string[]) => {
  await parseJson<{ ok: true }>(
    await fetch(`${getMastraUrl()}/chat-state/threads/reorder`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ scope, threadIds }),
    }),
  );
};

export const listServerMessages = async (threadId: string) => {
  const result = await parseJson<{ messages: UIMessage[] }>(
    await fetch(`${getMastraUrl()}/chat-state/threads/${threadId}/messages`, { headers: getAuthHeaders() }),
  );

  return result.messages;
};

export type ThreadRunState = {
  active: boolean;
  status: 'idle' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'error';
  runId?: string;
  startedAt?: string;
  updatedAt?: string;
  error?: string;
};

export const getThreadRunState = async (threadId: string) => {
  const result = await parseJson<{ run: ThreadRunState }>(
    await fetch(`${getMastraUrl()}/chat/${threadId}/run`, { headers: getAuthHeaders() }),
  );

  return result.run;
};

export const cancelThreadRun = async (threadId: string) => {
  const result = await parseJson<{ ok: true; run: ThreadRunState }>(
    await fetch(`${getMastraUrl()}/chat/${threadId}/cancel`, { method: 'POST', headers: getAuthHeaders() }),
  );

  return result.run;
};

export type ContextUsage = {
  tokens: number;
  contextWindow?: number;
  percent?: number;
  source?: 'provider' | 'estimate';
  updatedAt?: string;
  totalProcessedTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
};

export const getThreadContextUsage = async (threadId: string, contextWindow?: number) => {
  const params = contextWindow ? `?${new URLSearchParams({ contextWindow: String(contextWindow) })}` : '';
  return parseJson<ContextUsage>(
    await fetch(`${getMastraUrl()}/chat-state/threads/${threadId}/context-usage${params}`, { headers: getAuthHeaders() }),
  );
};
