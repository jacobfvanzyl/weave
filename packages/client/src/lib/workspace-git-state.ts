import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listProjects, listWorkspaceGitStates, type Project, type Workspace, type WorkspaceGitState } from './chat-state-api';

export const workspaceGitStatePollMs = 6_000;

export const projectsQueryKey = (resourceId: string) => ['projects', resourceId] as const;
export const workspaceGitStateQueryKey = (resourceId: string) => ['workspace-git-state', resourceId] as const;

const workspaceStateKey = (projectId: string, workspaceId: string) => `${projectId}:${workspaceId}`;

const stripWorkspaceLiveGitState = (workspace: Workspace): Workspace => {
  const {
    branch: _branch,
    head: _head,
    detached: _detached,
    ...stableWorkspace
  } = workspace;
  return stableWorkspace;
};

export const overlayWorkspaceGitState = (
  projects: Project[],
  states: WorkspaceGitState[],
): Project[] => {
  const statesByWorkspace = new Map(states.map(state => [workspaceStateKey(state.projectId, state.workspaceId), state]));

  return projects.map(project => ({
    ...project,
    workspaces: project.workspaces.map(workspace => {
      const stableWorkspace = stripWorkspaceLiveGitState(workspace);
      const state = statesByWorkspace.get(workspaceStateKey(project.id, workspace.id));
      if (!state) return stableWorkspace;

      const {
        lastError: _lastError,
        ...workspaceWithoutError
      } = stableWorkspace;

      return {
        ...workspaceWithoutError,
        path: state.path ?? stableWorkspace.path,
        status: state.status,
        ...(state.lastError ? { lastError: state.lastError } : {}),
        ...(state.branch ? { branch: state.branch } : {}),
        ...(state.head ? { head: state.head } : {}),
        ...(typeof state.detached === 'boolean' ? { detached: state.detached } : {}),
      };
    }),
  }));
};

export const useProjectsWithLiveGitState = (resourceId: string) => {
  const projectsQuery = useQuery({
    queryKey: projectsQueryKey(resourceId),
    queryFn: listProjects,
  });
  const gitStateQuery = useQuery({
    queryKey: workspaceGitStateQueryKey(resourceId),
    queryFn: listWorkspaceGitStates,
    refetchInterval: workspaceGitStatePollMs,
    staleTime: 0,
  });

  const projects = useMemo(
    () => overlayWorkspaceGitState(projectsQuery.data ?? [], gitStateQuery.data ?? []),
    [gitStateQuery.data, projectsQuery.data],
  );

  return {
    projects,
    projectsQuery,
    gitStateQuery,
  };
};
