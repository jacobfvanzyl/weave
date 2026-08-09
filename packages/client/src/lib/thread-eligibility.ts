import type { ChatThread } from '../stores/chat-store';

export type ThreadOpenabilityProject = {
  id: string;
  workspaces: Array<{ id: string }>;
};

export type ThreadOpenabilityContext = {
  projectIds: ReadonlySet<string>;
  workspaceRefs: ReadonlySet<string>;
  workspaceOwners: ReadonlyArray<{ projectId: string; workspaceId: string }>;
};

export const workspaceRefKey = (projectId: string, workspaceId: string) => `${projectId}:${workspaceId}`;

export const createThreadOpenabilityContext = (
  projects: ThreadOpenabilityProject[] = [],
): ThreadOpenabilityContext => {
  const workspaceOwners = projects.flatMap((project) =>
    project.workspaces.map((workspace) => ({
      projectId: project.id,
      workspaceId: workspace.id,
    }))
  );
  return {
    projectIds: new Set(projects.map(project => project.id)),
    workspaceRefs: new Set(workspaceOwners.map(({ projectId, workspaceId }) =>
      workspaceRefKey(projectId, workspaceId)
    )),
    workspaceOwners,
  };
};

export const emptyThreadOpenabilityContext = createThreadOpenabilityContext();

export const isOpenableThread = (
  thread: Pick<ChatThread, 'projectId' | 'workspaceId' | 'archived' | 'adHoc' | 'removedWorkspace'>,
  context: ThreadOpenabilityContext,
) => {
  if (thread.archived === true || thread.removedWorkspace) return false;
  if (!thread.projectId || !thread.workspaceId) return false;
  return thread.adHoc === true || context.workspaceRefs.has(workspaceRefKey(thread.projectId, thread.workspaceId));
};

export const getOpenableThreads = <T extends Pick<ChatThread, 'projectId' | 'workspaceId' | 'archived' | 'adHoc' | 'removedWorkspace'>>(
  threads: T[],
  context: ThreadOpenabilityContext,
) => threads.filter(thread => isOpenableThread(thread, context));

export const sortThreadsForDisplay = <T extends { draft?: boolean; sortOrder?: number; updatedAt: string }>(
  threads: T[],
) => [...threads].sort((a, b) => {
  if (a.draft === true && b.draft !== true) return -1;
  if (a.draft !== true && b.draft === true) return 1;
  return (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
    || String(b.updatedAt).localeCompare(String(a.updatedAt));
});
