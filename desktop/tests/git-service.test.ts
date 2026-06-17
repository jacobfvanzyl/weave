import { describe, expect, it, vi } from 'vitest';
import {
  createProjectWorktree,
  fetchWorkspaceUpstream,
  listProjectBranches,
  pullWorkspaceUpstream,
  requestWorkspaceGitOperation,
} from '../../server/src/mastra/git/service';

const project = {
  id: 'project-1',
  projectKind: 'git' as const,
  portalId: 'portal-1',
  portalRootId: 'default',
  repoPath: 'weave',
  workspaces: [{
    id: 'workspace-1',
    portalId: 'portal-1',
    path: '/repo.review',
  }],
};

const onlinePortal = () => ({ userId: 'user-1' });

describe('git service facade', () => {
  it('lists branches through the deterministic Portal git capability', async () => {
    const requestPortal = vi.fn(async () => ({
      ok: true,
      branches: [
        { name: 'main', ref: 'main', kind: 'local', current: true },
        { name: 'feature/review', ref: 'origin/feature/review', kind: 'remote' },
      ],
    }));

    await expect(listProjectBranches(project, 'user-1', {
      getPortal: onlinePortal,
      requestPortal,
    })).resolves.toEqual([
      { name: 'main', ref: 'main', kind: 'local', current: true },
      { name: 'feature/review', ref: 'origin/feature/review', kind: 'remote' },
    ]);
    expect(requestPortal).toHaveBeenCalledWith(expect.objectContaining({
      portalId: 'portal-1',
      projectId: 'project-1',
      rootId: 'default',
      repoPath: 'weave',
      tool: 'portal.git.branches.list',
    }));
  });

  it('creates worktrees without Worktrunk tools', async () => {
    const requestPortal = vi.fn(async () => ({
      ok: true,
      worktree: { path: '/repo.feature', branch: 'feature/review', commit: 'abc1234' },
    }));

    await expect(createProjectWorktree(project, 'user-1', {
      mode: 'newBranch',
      branch: 'feature/review',
      base: 'main',
    }, {
      getPortal: onlinePortal,
      requestPortal,
    })).resolves.toEqual({ path: '/repo.feature', branch: 'feature/review', commit: 'abc1234' });
    expect(requestPortal).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'portal.git.worktree.create',
      args: { mode: 'newBranch', branch: 'feature/review', base: 'main' },
    }));
  });

  it('routes workspace status through the active workspace target', async () => {
    const requestPortal = vi.fn(async () => ({ ok: true, branch: 'feature/review', clean: true }));

    await expect(requestWorkspaceGitOperation(project, project.workspaces[0], 'user-1', {
      operation: 'status',
      adapters: { getPortal: onlinePortal, requestPortal },
    })).resolves.toEqual({ ok: true, branch: 'feature/review', clean: true });
    expect(requestPortal).toHaveBeenCalledWith(expect.objectContaining({
      portalId: 'portal-1',
      workspaceId: 'workspace-1',
      workspacePath: '/repo.review',
      tool: 'portal.git.status',
    }));
  });

  it('routes upstream fetch and fast-forward pull through Portal git capabilities', async () => {
    const requestPortal = vi.fn(async (input: { tool?: string }) => ({
      ok: true,
      branch: 'feature/review',
      upstream: 'origin/feature/review',
      ahead: input.tool === 'portal.git.pull' ? 0 : 1,
      behind: 0,
    }));

    await expect(fetchWorkspaceUpstream(project, project.workspaces[0], 'user-1', {
      getPortal: onlinePortal,
      requestPortal,
    })).resolves.toMatchObject({
      ok: true,
      branch: 'feature/review',
      upstream: 'origin/feature/review',
      ahead: 1,
    });

    await expect(pullWorkspaceUpstream(project, project.workspaces[0], 'user-1', {
      getPortal: onlinePortal,
      requestPortal,
    })).resolves.toMatchObject({
      ok: true,
      branch: 'feature/review',
      upstream: 'origin/feature/review',
      ahead: 0,
    });

    expect(requestPortal.mock.calls.map(([input]) => input.tool)).toEqual([
      'portal.git.fetch',
      'portal.git.pull',
    ]);
    expect(requestPortal).toHaveBeenCalledWith(expect.objectContaining({
      portalId: 'portal-1',
      workspaceId: 'workspace-1',
      workspacePath: '/repo.review',
    }));
  });
});
