import type { ActiveSurface } from '../stores/workspace-surface-store';

export type StartupSurfaceThread = {
  id: string;
  draft?: boolean;
};

export type StartupSurfaceResolution =
  | { kind: 'restore-thread'; threadId: string }
  | { kind: 'restore-draft'; draftId: string }
  | { kind: 'restore-workspace'; projectId: string; workspaceId: string }
  | { kind: 'create-root-draft'; discardStaleComposer: boolean };

export const resolveStartupSurface = ({
  activeSurface,
  openableThreads,
  workspaceRefs,
}: {
  activeSurface: ActiveSurface;
  openableThreads: readonly StartupSurfaceThread[];
  workspaceRefs: ReadonlySet<string>;
}): StartupSurfaceResolution => {
  if (activeSurface.kind === 'thread') {
    const thread = openableThreads.find((candidate) => candidate.id === activeSurface.threadId);
    if (thread?.draft) return { kind: 'restore-draft', draftId: thread.id };
    if (thread) return { kind: 'restore-thread', threadId: thread.id };
    return { kind: 'create-root-draft', discardStaleComposer: true };
  }

  const workspaceRef = `${activeSurface.projectId}:${activeSurface.workspaceId}`;
  if (workspaceRefs.has(workspaceRef)) {
    return {
      kind: 'restore-workspace',
      projectId: activeSurface.projectId,
      workspaceId: activeSurface.workspaceId,
    };
  }

  return { kind: 'create-root-draft', discardStaleComposer: true };
};
