import type { UIMessage } from 'ai';
import { RpcRemoteError } from '@weave/protocol';
import { rpcRequest } from './mastra-client';
import { productForProjectKind, type ProductId } from './products';
import { selectPreferredThreadProposal } from './proposal-review-state';
import type {
  ChatThread,
  PlanStepStatus,
  ProposalItemStatus,
  ProposalStatus,
  ThreadPlan,
  ThreadPlanStep,
  ThreadProposal,
  ThreadProposalItem,
} from '../stores/chat-store';

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

export type NotesStorageMetadata = {
  kind: string;
  bucket?: string;
  prefix?: string;
  portalId?: string;
  rootId?: string;
  vaultPath?: string;
  workspacePath?: string;
  [key: string]: unknown;
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
  notesStorage?: NotesStorageMetadata;
  gitRemote?: string;
  defaultBranch?: string;
  rootPathHint?: string;
  sortOrder?: number;
  workspaces: Workspace[];
  createdAt: string;
  updatedAt: string;
};

const productForProjectInput = (projectKind?: Project['projectKind']): ProductId =>
  projectKind ? productForProjectKind(projectKind) : 'chat';

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
    completed: typeof record?.completed === 'number'
      ? record.completed
      : plan.filter((item) => item.status === 'completed').length,
    total: typeof record?.total === 'number' ? record.total : plan.length,
    updatedAt: typeof record?.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
    ...(typeof record?.title === 'string' ? { title: record.title } : {}),
    ...(typeof record?.artifactPath === 'string'
      ? { artifactPath: record.artifactPath }
      : typeof record?.path === 'string'
      ? { artifactPath: record.path }
      : {}),
    ...(isPlanStepStatus(record?.status) ? { status: record.status } : {}),
  };
};

const isProposalStatus = (value: unknown): value is ProposalStatus =>
  value === 'draft' || value === 'ready' || value === 'partially_approved' || value === 'approved' ||
  value === 'changes_requested' || value === 'applied' || value === 'rejected' || value === 'stale';

const isProposalItemStatus = (value: unknown): value is ProposalItemStatus =>
  value === 'pending' || value === 'approved' || value === 'changes_requested' || value === 'rejected' ||
  value === 'applied' || value === 'stale';

const toProposalItem = (value: unknown): ThreadProposalItem | undefined => {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (typeof record?.id !== 'string' || !isProposalItemStatus(record.status)) return undefined;
  return {
    id: record.id,
    kind: typeof record.kind === 'string' ? record.kind : 'file_edit',
    status: record.status,
    title: typeof record.title === 'string' ? record.title : typeof record.path === 'string' ? record.path : record.id,
    path: typeof record.path === 'string' ? record.path : undefined,
    additions: typeof record.additions === 'number' ? record.additions : 0,
    deletions: typeof record.deletions === 'number' ? record.deletions : 0,
    viewed: record.viewed === true,
    currentHash: typeof record.current_hash === 'string' ? record.current_hash : undefined,
    proposedHash: typeof record.proposed_hash === 'string' ? record.proposed_hash : undefined,
    comment: typeof record.comment === 'string' ? record.comment : undefined,
  };
};

const toThreadProposal = (value: unknown): ThreadProposal | undefined => {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const sourceItems = Array.isArray(record?.items) ? record.items : undefined;
  if (!sourceItems) return undefined;
  const items = sourceItems.map(toProposalItem).filter((item): item is ThreadProposalItem => Boolean(item));
  if (items.length === 0) return undefined;
  const countsRecord = record?.counts && typeof record.counts === 'object' && !Array.isArray(record.counts)
    ? record.counts as Record<string, unknown>
    : {};
  const counts = Object.fromEntries(
    Object.entries(countsRecord).filter(([, count]) => typeof count === 'number'),
  ) as Record<string, number>;
  return {
    items,
    counts,
    updatedAt: typeof record?.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
    ...(typeof record?.id === 'string' ? { id: record.id } : {}),
    ...(typeof record?.title === 'string' ? { title: record.title } : {}),
    ...(typeof record?.path === 'string' ? { path: record.path } : {}),
    ...(typeof record?.planPath === 'string' ? { planPath: record.planPath } : {}),
    ...(isProposalStatus(record?.status) ? { status: record.status } : {}),
    ...(typeof record?.summary === 'string' ? { summary: record.summary } : {}),
    ...(typeof record?.contentHash === 'string' ? { contentHash: record.contentHash } : {}),
  };
};

const toChatThread = (thread: ServerThread): ChatThread => {
  const latestProposal = selectPreferredThreadProposal(
    toThreadProposal(thread.metadata?.latestProposal),
    toThreadProposal(thread.metadata?.latestProposalDraft),
  );
  return {
    id: thread.id,
    title: thread.title || '...',
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    sortOrder: typeof thread.metadata?.sortOrder === 'number' ? thread.metadata.sortOrder : undefined,
    projectId: typeof thread.metadata?.projectId === 'string' ? thread.metadata.projectId : undefined,
    workspaceId: typeof thread.metadata?.workspaceId === 'string' ? thread.metadata.workspaceId : undefined,
    archived: thread.metadata?.archived === true,
    adHoc: thread.metadata?.adHoc === true,
    workspacePath: typeof thread.metadata?.workspacePath === 'string' ? thread.metadata.workspacePath : undefined,
    removedWorkspace: toRemovedWorkspace(thread.metadata?.removedWorkspace),
    latestPlan: toThreadPlan(thread.metadata?.latestPlan),
    latestProposal,
  };
};

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

export type AuthUser = {
  id: string;
  name: string;
};

export const getAuthUser = async () => {
  const result = await rpcRequest<{ owner?: AuthUser; user?: AuthUser }>('owner.get');

  return result.owner ?? result.user!;
};

export const listServerThreads = async () => {
  const result = await rpcRequest<{ threads: ServerThread[] }>('chat.thread.list');

  return result.threads.map(toChatThread);
};

export const createServerThread = async (threadId: string, projectId?: string, workspaceId?: string, title = '...') => {
  const result = await rpcRequest<{ thread: ServerThread }>('chat.thread.create', {
    threadId,
    title,
    projectId,
    workspaceId,
  });

  return toChatThread(result.thread);
};

export const archiveServerThread = async (threadId: string, archived = true) => {
  const result = await rpcRequest<{ thread: ServerThread }>('chat.thread.update', { threadId, archived });

  return toChatThread(result.thread);
};

export const renameServerThread = async (threadId: string, title: string) => {
  const result = await rpcRequest<{ thread: ServerThread }>('chat.thread.update', { threadId, title });

  return toChatThread(result.thread);
};

export const deleteServerThread = async (threadId: string) => {
  await rpcRequest('chat.thread.delete', { threadId });
};

export const listProjects = async () => {
  const result = await rpcRequest<{ projects: Project[] }>('code.project.list', { product: 'all' });

  return result.projects;
};

export const listProductProjects = async (product: ProductId) => {
  const result = await rpcRequest<{ projects: Project[] }>('code.project.list', { product });

  return result.projects;
};

export const listWorkspaceGitStates = async () => {
  const result = await rpcRequest<{ states: WorkspaceGitState[] }>('code.workspace.gitState.list');

  return result.states;
};

export const listProjectBranches = async (projectId: string) => {
  const result = await rpcRequest<{ branches: WorkspaceBranchOption[] }>('code.project.branches.list', { projectId });

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
  notesStorage?: NotesStorageMetadata;
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

const normalizePortalRoots = (roots: unknown): PortalRoot[] =>
  Array.isArray(roots)
    ? roots.flatMap((root) => {
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
    capabilities: Array.isArray(record.capabilities)
      ? record.capabilities.filter((item): item is string => typeof item === 'string')
      : [],
    roots: normalizePortalRoots(record.roots),
    status: record.status === 'online' ? 'online' : 'offline',
    primary: record.primary === true,
  };
};

export const listPortals = async () => {
  const result = await rpcRequest<{ portals: unknown[] }>('portal.list');

  return result.portals.flatMap((portal) => normalizePortalConnection(portal) ?? []);
};

export const browsePortal = async (portalId: string, rootId = 'default', path = '') => {
  return await rpcRequest<PortalBrowseResult>('portal.browse', { portalId, rootId, path });
};

export const setPrimaryPortal = async (portalId: string) => {
  const result = await rpcRequest<{ ok: true; primaryPortalId: string; portals: unknown[] }>(
    'portal.primary.set',
    { portalId },
  );

  return {
    primaryPortalId: result.primaryPortalId,
    portals: result.portals.flatMap((portal) => normalizePortalConnection(portal) ?? []),
  };
};

export const createProject = async (input: string | CreateProjectInput) => {
  const body: CreateProjectInput = typeof input === 'string' ? { name: input, projectKind: 'general' } : input;
  const result = await rpcRequest<{ project: Project }>('code.project.create', {
    ...body,
    product: productForProjectInput(body.projectKind),
  });

  return result.project;
};

export const deleteProject = async (projectId: string, projectKind?: Project['projectKind']) => {
  await rpcRequest('code.project.delete', {
    projectId,
    product: projectKind ? productForProjectKind(projectKind) : 'all',
  });
};

export const reorderProjects = async (projectIds: string[], product: ProductId = 'code') => {
  const result = await rpcRequest<{ projects: Project[] }>('code.project.reorder', { projectIds, product });

  return result.projects;
};

export const reorderAllProjects = async (projectIds: string[]) => {
  const result = await rpcRequest<{ projects: Project[] }>('code.project.reorder', {
    projectIds,
    product: 'all',
  });

  return result.projects;
};

export const createWorkspace = async (projectId: string, input: string | CreateWorkspaceInput) => {
  const body = typeof input === 'string'
    ? { name: input, mode: 'newBranch' satisfies WorkspaceBranchMode, branch: input }
    : input;
  const result = await rpcRequest<{ project: Project; workspace: Workspace }>('code.workspace.create', {
    projectId,
    ...body,
  });

  return result.workspace;
};

export const updateWorkspace = async (projectId: string, workspaceId: string, input: UpdateWorkspaceInput) => {
  const result = await rpcRequest<{ project: Project; workspace: Workspace }>('code.workspace.update', {
    projectId,
    workspaceId,
    ...input,
  });

  return result.workspace;
};

export const fetchWorkspaceGitUpstream = async (projectId: string, workspaceId: string) => {
  const result = await rpcRequest<{ state: WorkspaceGitState }>('code.workspace.git.fetch', {
    projectId,
    workspaceId,
  });

  return result.state;
};

export const pullWorkspaceGitUpstream = async (projectId: string, workspaceId: string) => {
  const result = await rpcRequest<{ state: WorkspaceGitState }>('code.workspace.git.pull', {
    projectId,
    workspaceId,
  });

  return result.state;
};

export const adoptWorkspace = async (projectId: string, path: string, name?: string) => {
  const result = await rpcRequest<{ project: Project; workspace: Workspace }>('code.workspace.adopt', {
    projectId,
    path,
    name,
  });

  return result.workspace;
};

export const fetchWorkspaceRemovalPreview = async (projectId: string, workspaceId: string) => {
  return await rpcRequest<WorkspaceRemovalPreview>('code.workspace.removalPreview', { projectId, workspaceId });
};

export const deleteWorkspace = async (
  projectId: string,
  workspaceId: string,
  input: 'detach' | 'remove' | DeleteWorkspaceOptions,
) => {
  const options = typeof input === 'string' ? { mode: input } : input;
  const result = await rpcRequest<DeleteWorkspaceResult>('code.workspace.delete', {
    projectId,
    workspaceId,
    ...options,
  });

  return result;
};

export const discoverWorkspaces = async (projectId: string) => {
  const result = await rpcRequest<{ worktrees: DiscoveredWorktree[] }>('code.workspace.discover', { projectId });

  return result.worktrees;
};

export const reorderWorkspaces = async (projectId: string, workspaceIds: string[]) => {
  const result = await rpcRequest<{ project: Project }>('code.workspace.reorder', { projectId, workspaceIds });

  return result.project;
};

export const createProjectThread = async (
  projectId: string,
  threadId: string,
  workspaceId?: string,
  title = '...',
  projectKind?: Project['projectKind'],
) => {
  const result = await rpcRequest<{ thread: ServerThread; workspace: Workspace }>('code.project.threads.create', {
    projectId,
    threadId,
    title,
    workspaceId,
    product: projectKind ? productForProjectKind(projectKind) : 'code',
  });

  return { thread: toChatThread(result.thread), workspace: result.workspace };
};

export const reorderThreads = async (
  scope: { plain?: true; projectId?: string; workspaceId?: string },
  threadIds: string[],
) => {
  await rpcRequest('chat.thread.reorder', { scope, threadIds });
};

export const listServerMessages = async (threadId: string) => {
  const result = await rpcRequest<{ messages: UIMessage[] }>('chat.thread.messages.list', { threadId });

  return result.messages;
};

export type ThreadRunState = {
  active: boolean;
  status: 'idle' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'error';
  runId?: string;
  startedAt?: string;
  updatedAt?: string;
  durationMs?: number;
  error?: string;
};

export const getThreadRunState = async (threadId: string) => {
  const result = await rpcRequest<{ run: ThreadRunState }>('chat.run.get', { threadId });

  return result.run;
};

export const cancelThreadRun = async (threadId: string) => {
  const result = await rpcRequest<{ ok: true; run: ThreadRunState }>('chat.run.cancel', { threadId });

  return result.run;
};

export type ThreadSteeringResult =
  | { ok: true; accepted: true; runId: string; messageId: string }
  | { ok: false; reason: 'not_active' | 'stale_run'; run: ThreadRunState };

export type SendThreadSteeringMessageOptions = {
  runId?: string;
  timeoutMs?: number;
};

const defaultThreadSteeringTimeoutMs = 5_000;

export const sendThreadSteeringMessage = async (
  threadId: string,
  message: UIMessage,
  options: SendThreadSteeringMessageOptions = {},
): Promise<ThreadSteeringResult> => {
  try {
    return await rpcRequest<{ ok: true; accepted: true; runId: string; messageId: string }>(
      'chat.run.steer',
      { threadId, message, ...(options.runId ? { runId: options.runId } : {}) },
      { timeoutMs: options.timeoutMs ?? defaultThreadSteeringTimeoutMs },
    );
  } catch (error) {
    if (error instanceof RpcRemoteError && error.code === -32009) {
      const body = error.data as { run?: ThreadRunState } | undefined;
      if (body?.run) return {
        ok: false,
        reason: options.runId && body.run.runId !== options.runId ? 'stale_run' : 'not_active',
        run: body.run,
      };
    }
    throw error;
  }
};

export type ContextUsage = {
  modelId: string;
  tokens: number;
  contextWindow: number;
  contextLimitPercent: number;
  contextLimitTokens: number;
  percent: number;
  compactionEnabled: boolean;
  source?: 'provider' | 'estimate';
  updatedAt?: string;
  totalProcessedTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  compaction?: {
    generation: number;
    state: 'running' | 'completed' | 'failed' | 'cancelled';
    at: string;
    projectedTokens?: number;
  };
};

export const getThreadContextUsage = async (threadId: string, modelId: string) => {
  return await rpcRequest<ContextUsage>('chat.thread.contextUsage', { threadId, model: modelId });
};

export type CompactThreadResult = {
  status: 'completed' | 'not_needed';
};

export const compactThread = async (threadId: string, model: string, instructions?: string) =>
  await rpcRequest<CompactThreadResult>('chat.thread.compact', {
    threadId,
    model,
    ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
  });
