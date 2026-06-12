export type WorkspaceGitStatus = 'ready' | 'offline' | 'creating' | 'dirty' | 'missing' | 'virtual' | 'error';

export type GitStateWorkspace = {
  id: string;
  path?: string;
  branch?: string;
  head?: string;
  detached?: boolean;
};

export type GitStateProject = {
  id: string;
  portalId?: string;
  portalRootId?: string;
  repoPath?: string;
  workspaces: GitStateWorkspace[];
};

export type WorkspaceGitState = {
  projectId: string;
  workspaceId: string;
  path?: string;
  status: WorkspaceGitStatus;
  branch?: string;
  head?: string;
  detached?: boolean;
  checkedAt: string;
  lastError?: string;
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

const optionalString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const normalizeBranch = (value: unknown) => optionalString(value)?.replace(/^refs\/heads\//, '');
const normalizePath = (value: unknown) => optionalString(value)?.replace(/\/+$/, '') || undefined;
const normalizeWorkspacePath = (workspace: Pick<GitStateWorkspace, 'path'>) => normalizePath(workspace.path)?.toLowerCase();
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export const stripWorkspaceGitState = <T extends GitStateWorkspace>(workspace: T): T => {
  const {
    branch: _branch,
    head: _head,
    detached: _detached,
    ...durableWorkspace
  } = workspace;
  return durableWorkspace as T;
};

export const stripProjectGitState = <T extends { workspaces: GitStateWorkspace[] }>(project: T): T => ({
  ...project,
  workspaces: project.workspaces.map(stripWorkspaceGitState),
});

export const gitFieldsFromWorktree = (worktree: Record<string, unknown>) => ({
  branch: normalizeBranch(worktree.branch),
  head: optionalString(worktree.commit) ?? optionalString(worktree.head),
  detached: worktree.detached === true,
});

const workspaceStateFromGitFields = (
  projectId: string,
  workspace: GitStateWorkspace,
  worktree: Record<string, unknown>,
  checkedAt: string,
): WorkspaceGitState => {
  const fields = gitFieldsFromWorktree(worktree);
  return {
    projectId,
    workspaceId: workspace.id,
    path: normalizePath(worktree.path) ?? workspace.path,
    status: 'ready',
    ...(fields.branch ? { branch: fields.branch } : {}),
    ...(fields.head ? { head: fields.head } : {}),
    detached: fields.detached,
    checkedAt,
  };
};

const workspaceState = (
  projectId: string,
  workspace: GitStateWorkspace,
  status: WorkspaceGitState['status'],
  checkedAt: string,
  lastError?: string,
): WorkspaceGitState => ({
  projectId,
  workspaceId: workspace.id,
  path: workspace.path,
  status,
  checkedAt,
  ...(lastError ? { lastError } : {}),
});

const portalToolError = (result: { ok?: boolean; error?: unknown }) => {
  if (result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : 'Portal tool failed');
};

export const collectWorkspaceGitStatesForProject = async (
  project: GitStateProject,
  resourceId: string,
  checkedAt: string,
  requestPortal: PortalToolRequester,
  getPortal: PortalConnectionLookup,
): Promise<WorkspaceGitState[]> => {
  const workspaces = project.workspaces.filter(workspace => workspace.path);
  if (!workspaces.length) return [];

  const portal = project.portalId ? getPortal(project.portalId) : undefined;
  if (!project.portalId || !portal || portal.userId !== resourceId) {
    return workspaces.map(workspace => workspaceState(project.id, workspace, 'offline', checkedAt));
  }

  let result: { ok?: boolean; error?: string; worktrees?: Array<Record<string, unknown>> };
  try {
    result = await requestPortal({
      portalId: project.portalId,
      projectId: project.id,
      rootId: project.portalRootId,
      repoPath: project.repoPath,
      tool: 'portal.git.worktree.list',
      args: {},
      timeoutMs: 10_000,
    }) as { ok?: boolean; error?: string; worktrees?: Array<Record<string, unknown>> };
    portalToolError(result);
  } catch (error) {
    return workspaces.map(workspace => workspaceState(project.id, workspace, 'error', checkedAt, errorMessage(error)));
  }

  const worktreesByPath = new Map((result.worktrees ?? []).flatMap(worktree => {
    const path = normalizePath(worktree.path)?.toLowerCase();
    return path ? [[path, worktree] as const] : [];
  }));

  return workspaces.map(workspace => {
    const workspacePath = normalizeWorkspacePath(workspace);
    const worktree = workspacePath ? worktreesByPath.get(workspacePath) : undefined;
    return worktree
      ? workspaceStateFromGitFields(project.id, workspace, worktree, checkedAt)
      : workspaceState(project.id, workspace, 'missing', checkedAt);
  });
};
