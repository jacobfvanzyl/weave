import type { AlphaViewModel } from './alpha-controller';

export type AlphaTerminalScope = {
  hostId: string;
  projectId: string;
  workspaceId: string;
  worktreeId?: string;
};

export const alphaTerminalScopeKey = (scope: AlphaTerminalScope) =>
  JSON.stringify([
    scope.hostId,
    scope.projectId,
    scope.worktreeId ?? null,
  ]);

export const selectedTerminalScope = (
  model: AlphaViewModel,
): AlphaTerminalScope | undefined => {
  if (!model.selectedThreadId) return;
  for (const project of model.workspaces) {
    const thread = project.threads.find(
      ({ id }) => id === model.selectedThreadId,
    );
    if (!thread) continue;
    return {
      hostId: thread.hostId,
      projectId: thread.projectId ?? project.id,
      workspaceId: thread.workspaceId,
      worktreeId: thread.worktreeId,
    };
  }
};
