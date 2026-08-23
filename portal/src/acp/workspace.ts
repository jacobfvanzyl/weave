export type AgentWorkspaceSelection = {
  workspaceId?: string;
  workspacePath?: string;
};

export type ResolvedAgentWorkspace = {
  workspaceId: string;
  path: string;
};

const unavailable = (): never => {
  throw new Error('Workspace is unavailable.');
};

const containsPath = (root: string, candidate: string) => candidate === root || candidate.startsWith(`${root}/`);

export const resolveHostWorkspace = async (
  roots: ReadonlyMap<string, string>,
  selection: AgentWorkspaceSelection,
): Promise<ResolvedAgentWorkspace> => {
  const workspaceId = selection.workspaceId?.trim();
  const workspacePath = selection.workspacePath?.trim();
  if (Boolean(workspaceId) === Boolean(workspacePath)) return unavailable();

  if (workspaceId) {
    const path = roots.get(workspaceId);
    if (!path) return unavailable();
    return { workspaceId, path };
  }

  try {
    const path = await Deno.realPath(workspacePath!);
    if (!(await Deno.stat(path)).isDirectory) return unavailable();
    const matches = [...roots.entries()]
      .filter(([, root]) => containsPath(root, path))
      .sort(([leftId, left], [rightId, right]) => right.length - left.length || leftId.localeCompare(rightId));
    const match = matches[0];
    if (!match) return unavailable();
    return { workspaceId: match[0], path };
  } catch {
    return unavailable();
  }
};
