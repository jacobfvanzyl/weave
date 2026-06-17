export type GitWorkspace = {
  id: string;
  portalId?: string;
  path?: string;
};

export type GitProject = {
  id: string;
  projectKind: 'general' | 'git' | 'notes';
  portalId?: string;
  portalRootId?: string;
  repoPath?: string;
  workspaces: GitWorkspace[];
};

export type PortalToolRequester = (input: {
  portalId: string;
  projectId?: string;
  workspaceId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
  tool: string;
  args: unknown;
  timeoutMs?: number;
}) => Promise<unknown>;

export type PortalConnectionLookup = (portalId: string) => { userId: string } | undefined;

export type BranchOption = {
  name: string;
  ref: string;
  kind: 'local' | 'remote';
  current?: boolean;
};

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const normalizeBranch = (value: unknown) => optionalString(value)?.replace(/^refs\/heads\//, '');
const normalizePath = (value: unknown) => optionalString(value)?.replace(/\/+$/, '') || undefined;

export const portalToolError = (result: { ok?: boolean; error?: unknown }) => {
  if (result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : 'Portal tool failed');
};

export const assertGitProjectReady = (
  project: GitProject,
  resourceId: string,
  getPortal: PortalConnectionLookup,
) => {
  if (project.projectKind !== 'git') throw new Error('only git projects can have git workspaces');
  if (!project.portalId) throw new Error('portalId is required for Portal-backed projects');
  const portal = getPortal(project.portalId);
  if (!portal || portal.userId !== resourceId) throw new Error('portal is offline or unavailable');
  if (!project.portalRootId || !project.repoPath) throw new Error('git project is missing Portal repo binding');
  return portal;
};

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

const requestProjectGitTool = async (
  project: GitProject,
  input: {
    tool: string;
    args?: unknown;
    timeoutMs?: number;
    workspace?: GitWorkspace;
    portalId?: string;
    requestPortal: PortalToolRequester;
  },
) => input.requestPortal({
  portalId: input.portalId ?? input.workspace?.portalId ?? project.portalId!,
  projectId: project.id,
  workspaceId: input.workspace?.id,
  rootId: project.portalRootId,
  repoPath: project.repoPath,
  workspacePath: input.workspace?.path,
  tool: input.tool,
  args: input.args ?? {},
  timeoutMs: input.timeoutMs,
});

export const inspectProjectGit = async (
  portalId: string,
  rootId: string,
  repoPath: string,
  requestPortal: PortalToolRequester,
) => {
  const result = await requestPortal({
    portalId,
    tool: 'portal.git.inspect',
    args: { rootId, path: repoPath },
  }) as { ok?: boolean; error?: string; git?: Record<string, unknown> };
  portalToolError(result);
  return result.git ?? {};
};

export const listProjectBranches = async (
  project: GitProject,
  resourceId: string,
  adapters: { getPortal: PortalConnectionLookup; requestPortal: PortalToolRequester },
) => {
  assertGitProjectReady(project, resourceId, adapters.getPortal);
  const result = await requestProjectGitTool(project, {
    tool: 'portal.git.branches.list',
    args: {},
    timeoutMs: 10_000,
    requestPortal: adapters.requestPortal,
  }) as { ok?: boolean; error?: string; branches?: unknown[] };
  portalToolError(result);
  return Array.isArray(result.branches)
    ? result.branches.flatMap(branch => normalizeBranchOption(branch) ?? [])
    : [];
};

export const listProjectWorktrees = async (
  project: GitProject,
  resourceId: string,
  adapters: { getPortal: PortalConnectionLookup; requestPortal: PortalToolRequester },
) => {
  assertGitProjectReady(project, resourceId, adapters.getPortal);
  const result = await requestProjectGitTool(project, {
    tool: 'portal.git.worktree.list',
    args: {},
    timeoutMs: 10_000,
    requestPortal: adapters.requestPortal,
  }) as { ok?: boolean; error?: string; worktrees?: Array<Record<string, unknown>> };
  portalToolError(result);
  return result.worktrees ?? [];
};

export const createProjectWorktree = async (
  project: GitProject,
  resourceId: string,
  args: Record<string, unknown>,
  adapters: { getPortal: PortalConnectionLookup; requestPortal: PortalToolRequester },
) => {
  assertGitProjectReady(project, resourceId, adapters.getPortal);
  const result = await requestProjectGitTool(project, {
    tool: 'portal.git.worktree.create',
    args,
    timeoutMs: 60_000,
    requestPortal: adapters.requestPortal,
  }) as { ok?: boolean; error?: string; worktree?: Record<string, unknown> };
  portalToolError(result);
  return result.worktree ?? {};
};

export const validateProjectWorktree = async (
  project: GitProject,
  resourceId: string,
  path: string,
  adapters: { getPortal: PortalConnectionLookup; requestPortal: PortalToolRequester },
) => {
  assertGitProjectReady(project, resourceId, adapters.getPortal);
  const result = await requestProjectGitTool(project, {
    tool: 'portal.git.worktree.validate',
    args: { path },
    timeoutMs: 10_000,
    requestPortal: adapters.requestPortal,
  }) as { ok?: boolean; error?: string; worktree?: Record<string, unknown> };
  portalToolError(result);
  return result.worktree ?? {};
};

export const switchWorkspaceBranch = async (
  project: GitProject,
  workspace: GitWorkspace,
  resourceId: string,
  args: Record<string, unknown>,
  adapters: { getPortal: PortalConnectionLookup; requestPortal: PortalToolRequester },
) => {
  assertGitProjectReady(project, resourceId, adapters.getPortal);
  const result = await requestProjectGitTool(project, {
    workspace,
    tool: 'portal.git.worktree.switch',
    args,
    timeoutMs: 60_000,
    requestPortal: adapters.requestPortal,
  }) as { ok?: boolean; error?: string; worktree?: Record<string, unknown> };
  portalToolError(result);
  return result.worktree ?? {};
};

export const removeWorkspaceWorktree = async (
  project: GitProject,
  workspace: GitWorkspace,
  resourceId: string,
  args: Record<string, unknown>,
  adapters: { getPortal: PortalConnectionLookup; requestPortal: PortalToolRequester },
) => {
  assertGitProjectReady(project, resourceId, adapters.getPortal);
  const result = await requestProjectGitTool(project, {
    workspace,
    tool: 'portal.git.worktree.remove',
    args,
    timeoutMs: 60_000,
    requestPortal: adapters.requestPortal,
  }) as { ok?: boolean; error?: string };
  portalToolError(result);
  return result;
};

export const requestWorkspaceGitOperation = async (
  project: GitProject,
  workspace: GitWorkspace,
  resourceId: string,
  input: {
    operation: 'status' | 'diff' | 'log' | 'show';
    args?: Record<string, unknown>;
    timeoutMs?: number;
    adapters: { getPortal: PortalConnectionLookup; requestPortal: PortalToolRequester };
  },
) => {
  assertGitProjectReady(project, resourceId, input.adapters.getPortal);
  const result = await requestProjectGitTool(project, {
    workspace,
    tool: `portal.git.${input.operation}`,
    args: input.args ?? {},
    timeoutMs: input.timeoutMs ?? 30_000,
    requestPortal: input.adapters.requestPortal,
  }) as { ok?: boolean; error?: string } & Record<string, unknown>;
  portalToolError(result);
  return result;
};

export const fetchWorkspaceUpstream = async (
  project: GitProject,
  workspace: GitWorkspace,
  resourceId: string,
  adapters: { getPortal: PortalConnectionLookup; requestPortal: PortalToolRequester },
) => {
  assertGitProjectReady(project, resourceId, adapters.getPortal);
  const result = await requestProjectGitTool(project, {
    workspace,
    tool: 'portal.git.fetch',
    args: {},
    timeoutMs: 60_000,
    requestPortal: adapters.requestPortal,
  }) as { ok?: boolean; error?: string } & Record<string, unknown>;
  portalToolError(result);
  return result;
};

export const pullWorkspaceUpstream = async (
  project: GitProject,
  workspace: GitWorkspace,
  resourceId: string,
  adapters: { getPortal: PortalConnectionLookup; requestPortal: PortalToolRequester },
) => {
  assertGitProjectReady(project, resourceId, adapters.getPortal);
  const result = await requestProjectGitTool(project, {
    workspace,
    tool: 'portal.git.pull',
    args: {},
    timeoutMs: 60_000,
    requestPortal: adapters.requestPortal,
  }) as { ok?: boolean; error?: string } & Record<string, unknown>;
  portalToolError(result);
  return result;
};

export const gitFieldsFromWorktree = (worktree: Record<string, unknown>) => ({
  branch: normalizeBranch(worktree.branch),
  head: optionalString(worktree.commit) ?? optionalString(worktree.head),
  upstream: optionalString(worktree.upstream),
  ahead: typeof worktree.ahead === 'number' ? worktree.ahead : undefined,
  behind: typeof worktree.behind === 'number' ? worktree.behind : undefined,
  detached: worktree.detached === true,
});

export const normalizeGitPath = normalizePath;
