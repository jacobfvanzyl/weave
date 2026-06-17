import { describe, expect, it, vi } from 'vitest';
import { collectWorkspaceGitStatesForProject } from '../../server/src/mastra/projects/git-state';

const checkedAt = '2026-06-03T08:01:00.000Z';

const project = {
  id: 'project-1',
  userId: 'user-1',
  name: 'Weave',
  projectKind: 'git',
  portalId: 'portal-1',
  portalRootId: 'default',
  repoPath: 'weave',
  workspaces: [{
    id: 'workspace-1',
    projectId: 'project-1',
    workspaceKind: 'worktree',
    source: 'git',
    name: 'Review checkout',
    path: '/repo.review',
    status: 'ready',
    createdAt: '2026-06-03T08:00:00.000Z',
    updatedAt: '2026-06-03T08:00:00.000Z',
  }],
  createdAt: '2026-06-03T08:00:00.000Z',
  updatedAt: '2026-06-03T08:00:00.000Z',
};

const onlinePortal = () => ({
  portalId: 'portal-1',
  userId: 'user-1',
  capabilities: [],
  mounts: [],
  roots: [],
  status: 'online',
  connectedAt: checkedAt,
  lastSeenAt: checkedAt,
});

describe('workspace live Git state collection', () => {
  it('returns live branch state from Portal worktree list output', async () => {
    const requestPortal = vi.fn(async () => ({
      ok: true,
      worktrees: [{
        path: '/repo.review',
        branch: 'feature/live',
        commit: 'abc1234',
        head: 'abc1234',
        upstream: 'origin/feature/live',
        ahead: 1,
        behind: 2,
      }],
    }));

    await expect(collectWorkspaceGitStatesForProject(project, 'user-1', checkedAt, requestPortal, onlinePortal)).resolves.toEqual([{
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      path: '/repo.review',
      status: 'ready',
      branch: 'feature/live',
      head: 'abc1234',
      upstream: 'origin/feature/live',
      ahead: 1,
      behind: 2,
      detached: false,
      checkedAt,
    }]);
    expect(requestPortal).toHaveBeenCalledWith(expect.objectContaining({
      portalId: 'portal-1',
      projectId: 'project-1',
      rootId: 'default',
      repoPath: 'weave',
      tool: 'portal.git.worktree.list',
    }));
  });

  it('requires callers to provide Portal adapters', async () => {
    await expect(collectWorkspaceGitStatesForProject(
      project,
      'user-1',
      checkedAt,
      undefined as any,
      undefined as any,
    )).rejects.toThrow();
  });

  it('returns detached HEAD state without a branch', async () => {
    const requestPortal = vi.fn(async () => ({
      ok: true,
      worktrees: [{ path: '/repo.review', commit: 'def5678', head: 'def5678', detached: true }],
    }));

    const [state] = await collectWorkspaceGitStatesForProject(project, 'user-1', checkedAt, requestPortal, onlinePortal);
    expect(state).toMatchObject({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      status: 'ready',
      head: 'def5678',
      detached: true,
    });
    expect('branch' in state).toBe(false);
  });

  it('marks workspaces offline without calling Portal when no Portal is connected', async () => {
    const requestPortal = vi.fn();

    await expect(collectWorkspaceGitStatesForProject(project, 'user-1', checkedAt, requestPortal, () => undefined)).resolves.toEqual([{
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      path: '/repo.review',
      status: 'offline',
      checkedAt,
    }]);
    expect(requestPortal).toHaveBeenCalledTimes(0);
  });

  it('marks missing paths when Git no longer lists the worktree', async () => {
    const requestPortal = vi.fn(async () => ({ ok: true, worktrees: [] }));

    await expect(collectWorkspaceGitStatesForProject(project, 'user-1', checkedAt, requestPortal, onlinePortal)).resolves.toEqual([{
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      path: '/repo.review',
      status: 'missing',
      checkedAt,
    }]);
  });

  it('marks errors when Portal worktree list fails', async () => {
    const requestPortal = vi.fn(async () => ({ ok: false, error: 'git failed' }));

    await expect(collectWorkspaceGitStatesForProject(project, 'user-1', checkedAt, requestPortal, onlinePortal)).resolves.toEqual([{
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      path: '/repo.review',
      status: 'error',
      checkedAt,
      lastError: 'git failed',
    }]);
  });
});
