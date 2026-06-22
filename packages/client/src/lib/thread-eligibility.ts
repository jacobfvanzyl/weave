import type { ChatThread } from '../stores/chat-store';

export type ThreadOpenabilityProject = {
  id: string;
  workspaces: Array<{ id: string }>;
};

export type ThreadOpenabilityContext = {
  projectIds: ReadonlySet<string>;
  workspaceRefs: ReadonlySet<string>;
};

export const workspaceRefKey = (projectId: string, workspaceId: string) => `${projectId}:${workspaceId}`;

export const createThreadOpenabilityContext = (
  projects: ThreadOpenabilityProject[] = [],
): ThreadOpenabilityContext => ({
  projectIds: new Set(projects.map(project => project.id)),
  workspaceRefs: new Set(projects.flatMap(project =>
    project.workspaces.map(workspace => workspaceRefKey(project.id, workspace.id)),
  )),
});

export const emptyThreadOpenabilityContext = createThreadOpenabilityContext();

export const isOpenableThread = (
  thread: Pick<ChatThread, 'projectId' | 'workspaceId' | 'archived' | 'adHoc' | 'removedWorkspace'>,
  context: ThreadOpenabilityContext,
) => {
  if (thread.archived === true || thread.removedWorkspace) return false;
  if (thread.adHoc) return true;
  if (!thread.projectId) return true;
  if (thread.workspaceId) return context.workspaceRefs.has(workspaceRefKey(thread.projectId, thread.workspaceId));
  return context.projectIds.has(thread.projectId);
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
