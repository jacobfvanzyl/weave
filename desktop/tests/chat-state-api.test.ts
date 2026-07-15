import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureMastraConnection, rpcRequest as sendRpcRequest } from '../../packages/client/src/lib/mastra-client';
import { cancelThreadRun, createWorkspace, deleteWorkspace, discoverWorkspaces, fetchWorkspaceGitUpstream, fetchWorkspaceRemovalPreview, getThreadRunState, listProjectBranches, listProjects, listServerThreads, listWorkspaceGitStates, pullWorkspaceGitUpstream, sendThreadSteeringMessage, updateWorkspace, type Project, type Workspace } from '../../packages/client/src/lib/chat-state-api';
import { createWorkspaceDraftDefaults } from '../../packages/client/src/lib/workspace-create-defaults';
import { overlayWorkspaceGitState } from '../../packages/client/src/lib/workspace-git-state';
import { sortThreadsForDisplay } from '../../packages/client/src/lib/thread-eligibility';
import { expandPrompt, listPrompts } from '../../packages/client/src/lib/prompts-api';
import { RpcRemoteError } from '@weave/protocol';

const installRpcMock = (implementation: (...args: any[]) => unknown | Promise<unknown>) => {
  const rpc = vi.fn(implementation);
  const rpcRequest = vi.fn(async (request: { requestId: string; method: string; params?: unknown; options?: unknown }) => {
    try {
      const result = await rpc(request.method, request.params, request.options);
      return {
        kind: 'success' as const,
        requestId: request.requestId,
        method: request.method,
        result,
      };
    } catch (error) {
      if (!(error instanceof RpcRemoteError)) throw error;
      return {
        kind: 'error' as const,
        requestId: request.requestId,
        method: request.method,
        error: { code: error.code, message: error.message, data: error.data },
      };
    }
  });
  vi.stubGlobal('window', { weaveDesktop: { rpcRequest } });
  return rpc;
};

const workspace: Workspace = {
  id: 'workspace-1',
  projectId: 'project-1',
  workspaceKind: 'worktree',
  source: 'git',
  name: 'Review checkout',
  path: '/repo.review',
  status: 'ready',
  createdAt: '2026-06-03T08:00:00.000Z',
  updatedAt: '2026-06-03T08:00:00.000Z',
};

const project: Project = {
  id: 'project-1',
  userId: 'user-1',
  name: 'Weave',
  projectKind: 'git',
  workspaces: [workspace],
  createdAt: '2026-06-03T08:00:00.000Z',
  updatedAt: '2026-06-03T08:00:00.000Z',
};

const createStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
};

const loadFreshChatStore = async (seed?: (storage: Storage) => void) => {
  vi.resetModules();
  const storage = createStorage();
  seed?.(storage);
  vi.stubGlobal('localStorage', storage);
  const [storeModule, surfaceModule, mastraClient] = await Promise.all([
    import('../../packages/client/src/stores/chat-store'),
    import('../../packages/client/src/stores/workspace-surface-store'),
    import('../../packages/client/src/lib/mastra-client'),
  ]);
  return {
    useChatStore: storeModule.useChatStore,
    useWorkspaceSurfaceStore: surfaceModule.useWorkspaceSurfaceStore,
    configureFreshMastraConnection: mastraClient.configureMastraConnection,
  };
};

describe('chat-state Project/Workspace API client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    configureMastraConnection({ mastraUrl: 'http://localhost:4111', authToken: null });
  });

  it('lists projects through the shared RPC connection', async () => {
    const rpc = installRpcMock(async () => ({ projects: [project] }));
    await expect(listProjects()).resolves.toEqual([project]);
    expect(rpc).toHaveBeenCalledWith('code.project.list', { product: 'all' }, undefined);
  });

  it('keeps AbortSignal in the renderer and cancels Desktop RPC by request id', async () => {
    let rejectRequest: (error: Error) => void = () => undefined;
    const rpcRequest = vi.fn((request: { requestId: string }) =>
      new Promise<never>((_resolve, reject) => {
        rejectRequest = reject;
      })
    );
    const cancelRpcRequest = vi.fn(() => rejectRequest(new Error('aborted by Desktop IPC')));
    vi.stubGlobal('window', { weaveDesktop: { rpcRequest, cancelRpcRequest } });
    const controller = new AbortController();

    const request = sendRpcRequest('chat.run.start', {
      messages: [],
      memory: { thread: 'thread-1' },
    }, {
      signal: controller.signal,
    });
    const forwardedEnvelope = rpcRequest.mock.calls[0]?.[0] as {
      requestId?: string;
      options?: { signal?: unknown };
    };

    expect(forwardedEnvelope.requestId).toMatch(/^renderer_/);
    expect('signal' in (forwardedEnvelope.options ?? {})).toBe(false);
    controller.abort();
    await expect(request).rejects.toThrow('aborted by Desktop IPC');
    expect(cancelRpcRequest).toHaveBeenCalledWith(forwardedEnvelope.requestId);
  });

  it('reads and cancels active chat run state', async () => {
    const run = {
      active: true,
      status: 'running',
      runId: 'run-1',
      startedAt: '2026-06-10T10:00:00.000Z',
      updatedAt: '2026-06-10T10:00:01.000Z',
    };
    const rpc = installRpcMock(async (method: string) => {
      if (method === 'chat.run.cancel') return { ok: true, run: { ...run, active: false, status: 'cancelled' } };
      return { run };
    });

    await expect(getThreadRunState('thread-1')).resolves.toEqual(run);
    await expect(cancelThreadRun('thread-1')).resolves.toMatchObject({ active: false, status: 'cancelled' });
    expect(rpc.mock.calls).toEqual([
      ['chat.run.get', { threadId: 'thread-1' }, undefined],
      ['chat.run.cancel', { threadId: 'thread-1' }, undefined],
    ]);
  });

  it('sends steering messages through RPC with the active durable run id', async () => {
    const rpc = installRpcMock(async () => ({ ok: true, accepted: true, runId: 'run-1', messageId: 'msg-1' }));
    const message = {
      id: 'user-1',
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'steer now' }],
    };
    await expect(sendThreadSteeringMessage('thread-1', message, { runId: 'active-run-1' })).resolves.toEqual({
      ok: true, accepted: true, runId: 'run-1', messageId: 'msg-1',
    });
    expect(rpc).toHaveBeenCalledWith('chat.run.steer', {
      threadId: 'thread-1', message, runId: 'active-run-1',
    }, { timeoutMs: 5_000, signal: undefined });
  });

  it('returns not_active when steering races with a completed run', async () => {
    const run = { active: false, status: 'completed' as const };
    installRpcMock(async () => { throw new RpcRemoteError(-32009, 'Run is not active.', { run }); });

    await expect(sendThreadSteeringMessage('thread-1', {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'steer now' }],
    })).resolves.toEqual({ ok: false, reason: 'not_active', run });
  });

  it('returns stale_run when steering reaches a different active run', async () => {
    const run = { active: true, status: 'running' as const, runId: 'next-run' };
    installRpcMock(async () => { throw new RpcRemoteError(-32009, 'Run changed.', { run }); });

    await expect(sendThreadSteeringMessage('thread-1', {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'steer now' }],
    }, { runId: 'old-run' })).resolves.toEqual({ ok: false, reason: 'stale_run', run });
  });

  it('forwards steering timeouts to the RPC transport', async () => {
    const rpc = installRpcMock(async () => ({ ok: true, accepted: true, runId: 'run-1', messageId: 'msg-1' }));
    await sendThreadSteeringMessage('thread-1', {
      id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'steer now' }],
    }, { runId: 'active-run-1', timeoutMs: 10 });
    expect(rpc.mock.calls[0][2]).toMatchObject({ timeoutMs: 10 });
  });

  it('creates workspaces with separate display name and branch action', async () => {
    const rpc = installRpcMock(async () => ({ project, workspace }));
    await expect(createWorkspace('project-1', {
      name: 'Review checkout',
      mode: 'newBranch',
      branch: 'feature/review',
      base: 'main',
      path: '/repo.review',
    })).resolves.toEqual(workspace);

    expect(rpc).toHaveBeenCalledWith('code.workspace.create', {
      projectId: 'project-1', name: 'Review checkout',
      mode: 'newBranch',
      branch: 'feature/review',
      base: 'main',
      path: '/repo.review',
    }, undefined);
  });

  it('creates detached workspaces without branch or path payload fields', async () => {
    const rpc = installRpcMock(async () => ({ project, workspace }));
    await expect(createWorkspace('project-1', {
      name: 'clever-lovelace',
      mode: 'detached',
      base: 'main',
    })).resolves.toEqual(workspace);

    expect(rpc).toHaveBeenCalledWith('code.workspace.create', {
      projectId: 'project-1', name: 'clever-lovelace',
      mode: 'detached',
      base: 'main',
    }, undefined);
  });

  it('builds workspace creation defaults for detached Docker-style checkouts', () => {
    const draft = createWorkspaceDraftDefaults('trunk');
    expect(draft).toMatchObject({
      mode: 'detached',
      branch: '',
      base: 'trunk',
    });
    expect(draft.name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(createWorkspaceDraftDefaults().base).toBe('main');
  });

  it('switches branch as a workspace update', async () => {
    const rpc = installRpcMock(async () => ({ project, workspace }));
    const updated = await updateWorkspace('project-1', 'workspace-1', {
      branch: 'main',
      createBranch: false,
    });
    expect(updated).toMatchObject({ id: 'workspace-1' });
    expect('branch' in updated).toBe(false);

    expect(rpc).toHaveBeenCalledWith('code.workspace.update', {
      projectId: 'project-1', workspaceId: 'workspace-1', branch: 'main', createBranch: false,
    }, undefined);
  });

  it('reads live workspace git-state snapshots', async () => {
    const states = [{
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      path: '/repo.review',
      status: 'ready',
      branch: 'feature/review',
      head: 'abc1234',
      upstream: 'origin/feature/review',
      ahead: 1,
      behind: 2,
      detached: false,
      checkedAt: '2026-06-03T08:01:00.000Z',
    }];
    const rpc = installRpcMock(async () => ({ states }));
    await expect(listWorkspaceGitStates()).resolves.toEqual(states);
    expect(rpc).toHaveBeenCalledWith('code.workspace.gitState.list', undefined, undefined);
  });

  it('runs workspace upstream fetch and pull operations', async () => {
    const state = {
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      path: '/repo.review',
      status: 'ready',
      branch: 'feature/review',
      upstream: 'origin/feature/review',
      ahead: 0,
      behind: 0,
      checkedAt: '2026-06-03T08:01:00.000Z',
    };
    const rpc = installRpcMock(async () => ({ state }));
    await expect(fetchWorkspaceGitUpstream('project-1', 'workspace-1')).resolves.toEqual(state);
    await expect(pullWorkspaceGitUpstream('project-1', 'workspace-1')).resolves.toEqual(state);
    expect(rpc.mock.calls).toEqual([
      ['code.workspace.git.fetch', { projectId: 'project-1', workspaceId: 'workspace-1' }, undefined],
      ['code.workspace.git.pull', { projectId: 'project-1', workspaceId: 'workspace-1' }, undefined],
    ]);
  });

  it('reads project branch options', async () => {
    const branches = [
      { name: 'main', ref: 'main', kind: 'local', current: true },
      { name: 'feature/review', ref: 'origin/feature/review', kind: 'remote' },
    ];
    const rpc = installRpcMock(async () => ({ branches }));
    await expect(listProjectBranches('project-1')).resolves.toEqual(branches);
    expect(rpc).toHaveBeenCalledWith('code.project.branches.list', { projectId: 'project-1' }, undefined);
  });

  it('discovers project worktrees with adoption metadata', async () => {
    const worktrees = [
      {
        path: '/repo',
        branch: 'main',
        commit: 'abc1234',
        head: 'abc1234',
        detached: false,
        adopted: true,
        workspaceId: 'workspace-1',
      },
      {
        path: '/repo.review',
        branch: 'feature/review',
        commit: 'def5678',
        head: 'def5678',
        detached: false,
        adopted: false,
      },
    ];
    const rpc = installRpcMock(async () => ({ worktrees }));
    await expect(discoverWorkspaces('project-1')).resolves.toEqual(worktrees);
    expect(rpc).toHaveBeenCalledWith('code.workspace.discover', { projectId: 'project-1' }, undefined);
  });

  it('previews and removes workspaces with branch cleanup options', async () => {
    const branchCleanup = {
      requested: false,
      status: 'not_requested',
      eligible: true,
      branch: 'feature/review',
      targetRef: 'origin/feature/review',
      targetKind: 'same_name_remote',
    };
    const rpc = installRpcMock(async (method: string) => {
      if (method === 'code.workspace.removalPreview') {
        return {
          workspace,
          activeThreadCount: 1,
          archivedThreadCount: 2,
          branchCleanup,
        };
      }
      return {
        project,
        workspace,
        mode: 'remove',
        force: true,
        activeThreadCount: 1,
        archivedThreadCount: 2,
        branchCleanup: { ...branchCleanup, requested: true, status: 'deleted' },
      };
    });

    await expect(fetchWorkspaceRemovalPreview('project-1', 'workspace-1')).resolves.toEqual({
      workspace,
      activeThreadCount: 1,
      archivedThreadCount: 2,
      branchCleanup,
    });
    await expect(deleteWorkspace('project-1', 'workspace-1', {
      mode: 'remove',
      force: true,
      deleteLocalBranch: true,
    })).resolves.toMatchObject({
      branchCleanup: { requested: true, status: 'deleted', branch: 'feature/review' },
    });
    expect(rpc.mock.calls).toEqual([
      ['code.workspace.removalPreview', { projectId: 'project-1', workspaceId: 'workspace-1' }, undefined],
      ['code.workspace.delete', {
        projectId: 'project-1', workspaceId: 'workspace-1', mode: 'remove', force: true, deleteLocalBranch: true,
      }, undefined],
    ]);
  });

  it('maps removed workspace metadata onto chat threads', async () => {
    installRpcMock(async () => ({
      threads: [{
        id: 'thread-1',
        title: 'Old review',
        resourceId: 'user-1',
        createdAt: '2026-06-03T08:00:00.000Z',
        updatedAt: '2026-06-03T09:00:00.000Z',
        metadata: {
          mode: 'project',
          projectId: 'project-1',
          archived: true,
          removedWorkspace: {
            id: 'workspace-1',
            projectId: 'project-1',
            name: 'Review checkout',
            path: '/repo.review',
            branch: 'feature/review',
            removedAt: '2026-06-18T10:00:00.000Z',
          },
        },
      }],
    }));

    await expect(listServerThreads()).resolves.toEqual([expect.objectContaining({
      id: 'thread-1',
      projectId: 'project-1',
      archived: true,
      removedWorkspace: {
        id: 'workspace-1',
        projectId: 'project-1',
        name: 'Review checkout',
        path: '/repo.review',
        branch: 'feature/review',
        removedAt: '2026-06-18T10:00:00.000Z',
      },
    })]);
  });

  it('maps legacy plan artifact metadata onto lightweight thread plans', async () => {
    installRpcMock(async () => ({
      threads: [{
        id: 'thread-1',
        title: 'Plan work',
        resourceId: 'user-1',
        createdAt: '2026-06-03T08:00:00.000Z',
        updatedAt: '2026-06-03T09:00:00.000Z',
        metadata: {
          latestPlan: {
            version: 1,
            id: 'bright-river',
            title: 'Plan Artifact Overhaul',
            path: '.agents/plans/bright-river.md',
            status: 'blocked',
            checklist: [
              { id: 'research', text: 'Research current plan tooling', status: 'completed' },
              { id: 'implement', text: 'Implement artifact-aware plan tools', status: 'blocked' },
            ],
            completed: 1,
            total: 2,
            updatedAt: '2026-06-18T12:00:00.000Z',
            contentHash: 'abc123',
          },
        },
      }],
    }));

    await expect(listServerThreads()).resolves.toEqual([expect.objectContaining({
      latestPlan: {
        title: 'Plan Artifact Overhaul',
        artifactPath: '.agents/plans/bright-river.md',
        status: 'blocked',
        completed: 1,
        total: 2,
        updatedAt: '2026-06-18T12:00:00.000Z',
        plan: [
          { id: 'research', step: 'Research current plan tooling', status: 'completed' },
          { id: 'implement', step: 'Implement artifact-aware plan tools', status: 'blocked' },
        ],
      },
    })]);
  });

  it('prefers newer draft proposal metadata over older different-path finalized proposal metadata', async () => {
    const proposalItem = {
      id: 'src-file-ts',
      kind: 'file_edit',
      status: 'pending',
      title: 'Update file',
      path: 'src/file.ts',
      additions: 2,
      deletions: 1,
      viewed: false,
      current_hash: 'old-hash',
      proposed_hash: 'new-hash',
    };
    installRpcMock(async () => ({
      threads: [{
        id: 'thread-1',
        title: 'Proposal work',
        resourceId: 'user-1',
        createdAt: '2026-06-03T08:00:00.000Z',
        updatedAt: '2026-06-03T09:00:00.000Z',
        metadata: {
          latestProposal: {
            id: 'old-ready',
            title: 'Old ready proposal',
            path: '.agents/proposals/old-ready.md',
            status: 'ready',
            summary: 'Older finalized proposal.',
            items: [{ ...proposalItem, id: 'old-item', status: 'approved' }],
            counts: { approved: 1 },
            updatedAt: '2026-06-18T12:00:00.000Z',
            contentHash: 'ready-hash',
          },
          latestProposalDraft: {
            id: 'draft-review',
            title: 'Draft review proposal',
            path: '.agents/proposals/draft-review.md',
            status: 'draft',
            summary: 'Draft proposal in progress.',
            items: [proposalItem],
            counts: { pending: 1 },
            updatedAt: '2026-06-18T12:05:00.000Z',
            contentHash: 'draft-hash',
          },
        },
      }],
    }));

    await expect(listServerThreads()).resolves.toEqual([expect.objectContaining({
      latestProposal: expect.objectContaining({
        id: 'draft-review',
        title: 'Draft review proposal',
        path: '.agents/proposals/draft-review.md',
        status: 'draft',
        contentHash: 'draft-hash',
        items: [expect.objectContaining({
          id: 'src-file-ts',
          path: 'src/file.ts',
          currentHash: 'old-hash',
          proposedHash: 'new-hash',
        })],
      }),
    })]);
  });

  it('prefers finalized proposal metadata over stale same-path draft metadata', async () => {
    const proposalItem = {
      id: 'src-file-ts',
      kind: 'file_edit',
      status: 'applied',
      title: 'Update file',
      path: 'src/file.ts',
      additions: 2,
      deletions: 1,
      viewed: true,
      current_hash: 'old-hash',
      proposed_hash: 'new-hash',
    };
    installRpcMock(async () => ({
      threads: [{
        id: 'thread-1',
        title: 'Proposal work',
        resourceId: 'user-1',
        createdAt: '2026-06-03T08:00:00.000Z',
        updatedAt: '2026-06-03T09:00:00.000Z',
        metadata: {
          latestProposal: {
            id: 'applied-review',
            title: 'Applied proposal',
            path: '.agents/proposals/demo.md',
            status: 'applied',
            summary: 'Applied proposal.',
            items: [proposalItem],
            counts: { applied: 1 },
            updatedAt: '2026-06-18T12:10:00.000Z',
            contentHash: 'applied-hash',
          },
          latestProposalDraft: {
            id: 'draft-review',
            title: 'Draft review proposal',
            path: '.agents/proposals/demo.md',
            status: 'draft',
            summary: 'Draft proposal in progress.',
            items: [{ ...proposalItem, status: 'pending', viewed: false }],
            counts: { pending: 1 },
            updatedAt: '2026-06-18T12:05:00.000Z',
            contentHash: 'draft-hash',
          },
        },
      }],
    }));

    await expect(listServerThreads()).resolves.toEqual([expect.objectContaining({
      latestProposal: expect.objectContaining({
        id: 'applied-review',
        path: '.agents/proposals/demo.md',
        status: 'applied',
        contentHash: 'applied-hash',
      }),
    })]);
  });

  it('overlays live git-state and strips stale branch metadata', () => {
    const legacyProject: Project = {
      ...project,
      workspaces: [{
        ...workspace,
        branch: 'stale/branch',
        head: 'old',
        upstream: 'origin/stale',
        ahead: 3,
        behind: 4,
        detached: false,
        lastError: 'old error',
      }],
    };

    const offlineWorkspace = overlayWorkspaceGitState([legacyProject], [{
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      path: '/repo.review',
      status: 'offline',
      checkedAt: '2026-06-03T08:01:00.000Z',
    }])[0].workspaces[0];
    expect(offlineWorkspace).toMatchObject({
      id: 'workspace-1',
      status: 'offline',
    });
    expect('branch' in offlineWorkspace).toBe(false);
    expect('head' in offlineWorkspace).toBe(false);
    expect('upstream' in offlineWorkspace).toBe(false);
    expect('ahead' in offlineWorkspace).toBe(false);
    expect('behind' in offlineWorkspace).toBe(false);
    expect('detached' in offlineWorkspace).toBe(false);
    expect('lastError' in offlineWorkspace).toBe(false);

    const syncedWorkspace = overlayWorkspaceGitState([project], [{
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      path: '/repo.review',
      status: 'ready',
      branch: 'feature/live',
      head: 'def5678',
      upstream: 'origin/feature/live',
      ahead: 1,
      behind: 2,
      detached: false,
      checkedAt: '2026-06-03T08:02:00.000Z',
    }])[0].workspaces[0];
    expect(syncedWorkspace).toMatchObject({
      id: 'workspace-1',
      status: 'ready',
      branch: 'feature/live',
      head: 'def5678',
      upstream: 'origin/feature/live',
      ahead: 1,
      behind: 2,
      detached: false,
    });

    const detachedWorkspace = overlayWorkspaceGitState([project], [{
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      path: '/repo.review',
      status: 'ready',
      head: 'fed9876',
      detached: true,
      checkedAt: '2026-06-03T08:03:00.000Z',
    }])[0].workspaces[0];
    expect(detachedWorkspace).toMatchObject({
      id: 'workspace-1',
      status: 'ready',
      head: 'fed9876',
      detached: true,
    });
    expect('branch' in detachedWorkspace).toBe(false);
  });

  it('sends draft context to prompt RPC methods without profileId', async () => {
    const rpc = installRpcMock(async () => ({ prompts: [] }));
    const context = {
      threadId: 'draft-thread',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
    };

    await listPrompts(context);

    expect(rpc).toHaveBeenCalledWith('agent.prompts.list', context, undefined);
  });

  it('sends draft context when expanding prompts', async () => {
    const rpc = installRpcMock(async () => ({ name: 'ship', text: 'Ship now' }));
    await expect(expandPrompt('ship', 'now', {
      threadId: 'draft-thread',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
    })).resolves.toBe('Ship now');

    expect(rpc).toHaveBeenCalledWith('agent.prompts.expand', {
      name: 'ship',
      arguments: 'now',
      threadId: 'draft-thread',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
    }, undefined);
  });

  it('hydrates plan panel state from server thread metadata', async () => {
    const { useChatStore } = await loadFreshChatStore();
    const now = '2026-06-03T08:00:00.000Z';

    useChatStore.getState().setServerThreads([{
      id: 'thread-1',
      title: 'Plan work',
      createdAt: now,
      updatedAt: now,
      latestPlan: {
        title: 'Plan Artifact Overhaul',
        artifactPath: '.agents/plans/bright-river.md',
        status: 'blocked',
        plan: [
          { id: 'research', step: 'Research current plan tooling', status: 'completed' },
          { id: 'implement', step: 'Implement artifact-aware plan tools', status: 'blocked' },
        ],
        completed: 1,
        total: 2,
        updatedAt: '2026-06-18T12:00:00.000Z',
      },
    }]);

    expect(useChatStore.getState().threadPlans['thread-1']).toMatchObject({
      title: 'Plan Artifact Overhaul',
      artifactPath: '.agents/plans/bright-river.md',
      status: 'blocked',
      completed: 1,
      total: 2,
    });
  });

  it('starts on a root draft while retaining archived, removed, and orphaned threads', async () => {
    const { useChatStore, useWorkspaceSurfaceStore } = await loadFreshChatStore();
    const now = '2026-06-03T08:00:00.000Z';
    const projectWithMissingWorkspace: Project = {
      ...project,
      workspaces: [{ ...workspace, status: 'missing' }],
    };

    useChatStore.getState().setServerThreads([
      {
        id: 'archived-thread',
        title: 'Archived',
        createdAt: now,
        updatedAt: '2026-06-03T12:00:00.000Z',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        archived: true,
      },
      {
        id: 'removed-thread',
        title: 'Removed workspace',
        createdAt: now,
        updatedAt: '2026-06-03T11:00:00.000Z',
        projectId: 'project-1',
        removedWorkspace: {
          id: 'workspace-removed',
          projectId: 'project-1',
          name: 'Removed',
          removedAt: '2026-06-03T10:30:00.000Z',
        },
      },
      {
        id: 'orphan-thread',
        title: 'Orphan',
        createdAt: now,
        updatedAt: '2026-06-03T10:00:00.000Z',
        projectId: 'project-2',
        workspaceId: 'workspace-2',
      },
      {
        id: 'valid-thread',
        title: 'Valid',
        createdAt: now,
        updatedAt: '2026-06-03T09:00:00.000Z',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
      },
    ], [projectWithMissingWorkspace]);

    expect(useChatStore.getState().threads.map(thread => thread.id)).toEqual([
      'archived-thread',
      'removed-thread',
      'orphan-thread',
      'valid-thread',
      useWorkspaceSurfaceStore.getState().threadId,
    ]);
    const startupThread = useChatStore.getState().threads.find(thread => thread.id === useWorkspaceSurfaceStore.getState().threadId);
    expect(startupThread).toMatchObject({ draft: true });
    expect(startupThread?.projectId).toBeUndefined();
    expect(startupThread?.workspaceId).toBeUndefined();
    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      activeSurface: { kind: 'thread', threadId: startupThread?.id },
      paneVisibility: { chatOpen: true, editorOpen: false, terminalOpen: false },
    });

    await useChatStore.getState().archiveThread(startupThread!.id);

    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      threadId: 'valid-thread',
      activeSurface: { kind: 'thread', threadId: 'valid-thread' },
      paneVisibility: { chatOpen: true, editorOpen: true, terminalOpen: false },
    });
  });

  it('starts on a local draft when no server threads are openable', async () => {
    const { useChatStore, useWorkspaceSurfaceStore } = await loadFreshChatStore();
    const now = '2026-06-03T08:00:00.000Z';

    useChatStore.getState().setServerThreads([
      {
        id: 'archived-thread',
        title: 'Archived',
        createdAt: now,
        updatedAt: '2026-06-03T10:00:00.000Z',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        archived: true,
      },
      {
        id: 'orphan-thread',
        title: 'Orphan',
        createdAt: now,
        updatedAt: '2026-06-03T09:00:00.000Z',
        projectId: 'project-2',
        workspaceId: 'workspace-2',
      },
    ], [project]);

    const selectedThread = useChatStore.getState().threads.find(thread => thread.id === useWorkspaceSurfaceStore.getState().threadId);
    expect(selectedThread).toMatchObject({ draft: true });
    expect(useChatStore.getState().threads.map(thread => thread.id)).toEqual(expect.arrayContaining([
      'archived-thread',
      'orphan-thread',
    ]));
    expect(useWorkspaceSurfaceStore.getState().activeSurface).toEqual({
      kind: 'thread',
      threadId: selectedThread?.id,
    });
  });

  it('sorts draft threads above persisted threads within any thread list', () => {
    const now = '2026-06-03T08:00:00.000Z';
    const newestPersisted = {
      id: 'persisted-new',
      title: 'Newest persisted',
      createdAt: now,
      updatedAt: '2026-06-03T12:00:00.000Z',
      sortOrder: 0,
    };
    const olderDraft = {
      id: 'draft-old',
      title: 'Draft',
      createdAt: now,
      updatedAt: '2026-06-03T09:00:00.000Z',
      sortOrder: 100,
      draft: true,
    };
    const olderPersisted = {
      id: 'persisted-old',
      title: 'Older persisted',
      createdAt: now,
      updatedAt: '2026-06-03T10:00:00.000Z',
      sortOrder: 1,
    };

    expect(sortThreadsForDisplay([newestPersisted, olderPersisted, olderDraft]).map(thread => thread.id)).toEqual([
      'draft-old',
      'persisted-new',
      'persisted-old',
    ]);
  });

  it('preserves workspace terminal pane visibility when creating workspace threads', async () => {
    const { useChatStore, useWorkspaceSurfaceStore } = await loadFreshChatStore();

    useWorkspaceSurfaceStore.getState().selectThread('current-thread', { id: 'current-thread', workspaceId: 'workspace-1' });
    useWorkspaceSurfaceStore.getState().openPane('terminal');
    await useChatStore.getState().newThread('project-1', 'workspace-1');

    expect(useWorkspaceSurfaceStore.getState().paneVisibility).toMatchObject({
      chatOpen: true,
      editorOpen: true,
      terminalOpen: true,
    });

    useWorkspaceSurfaceStore.getState().closePane('terminal');
    await useChatStore.getState().newThread('project-1', 'workspace-1');

    expect(useWorkspaceSurfaceStore.getState().paneVisibility).toMatchObject({
      chatOpen: true,
      editorOpen: true,
      terminalOpen: false,
    });
  });

  it('does not send draft profileId when first persisting a plain thread', async () => {
    const { useChatStore, useWorkspaceSurfaceStore } = await loadFreshChatStore();
    const now = '2026-06-03T08:00:00.000Z';
    const rpc = installRpcMock(async () => ({
      thread: {
        id: 'draft-thread',
        title: 'Hello',
        resourceId: 'browser-user-test',
        createdAt: now,
        updatedAt: now,
        metadata: {},
      },
    }));
    useWorkspaceSurfaceStore.getState().selectThread('draft-thread', { id: 'draft-thread' });
    useChatStore.setState({
      resourceId: 'browser-user-test',
      threads: [{ id: 'draft-thread', title: '...', createdAt: now, updatedAt: now, draft: true, profileId: 'coding' } as any],
    });

    await useChatStore.getState().ensureThreadPersisted('draft-thread', 'Hello');

    expect(rpc).toHaveBeenCalledWith('chat.thread.create', {
      threadId: 'draft-thread',
      title: 'Hello',
      projectId: undefined,
      workspaceId: undefined,
    }, undefined);
    expect(useChatStore.getState().threads[0]).toMatchObject({ id: 'draft-thread' });
    expect('profileId' in useChatStore.getState().threads[0]).toBe(false);
    expect(useChatStore.getState().threads[0].draft).toBeUndefined();
  });

  it('keeps a first-send thread selected until a server list observes it', async () => {
    const { useChatStore, useWorkspaceSurfaceStore } = await loadFreshChatStore();
    const now = '2026-06-03T08:00:00.000Z';
    let resolveCreate: (value: unknown) => void = () => undefined;
    const createResponse = new Promise(resolve => {
      resolveCreate = resolve;
    });
    installRpcMock(async (method: string) => {
      if (method !== 'chat.thread.create') throw new Error(`Unexpected RPC method: ${method}`);
      return await createResponse;
    });
    useWorkspaceSurfaceStore.getState().selectThread('draft-thread', { id: 'draft-thread' });
    useChatStore.setState({
      resourceId: 'browser-user-test',
      threads: [{ id: 'draft-thread', title: '...', createdAt: now, updatedAt: now, draft: true }],
      hasInitializedThreads: true,
    });

    const persist = useChatStore.getState().ensureThreadPersisted('draft-thread', 'Hello');

    expect(useChatStore.getState().threads[0]).toMatchObject({
      id: 'draft-thread',
      persistenceState: 'creating',
    });
    useChatStore.getState().setServerThreads([]);
    expect(useWorkspaceSurfaceStore.getState().threadId).toBe('draft-thread');
    expect(useChatStore.getState().threads.map(thread => thread.id)).toEqual(['draft-thread']);

    resolveCreate({
      thread: {
        id: 'draft-thread',
        title: 'Hello',
        resourceId: 'browser-user-test',
        createdAt: now,
        updatedAt: now,
        metadata: {},
      },
    });
    await persist;

    expect(useChatStore.getState().threads[0]).toMatchObject({
      id: 'draft-thread',
      persistenceState: 'awaiting_server_list',
    });
    useChatStore.getState().setServerThreads([]);
    expect(useWorkspaceSurfaceStore.getState().threadId).toBe('draft-thread');
    expect(useChatStore.getState().threads.map(thread => thread.id)).toEqual(['draft-thread']);

    useChatStore.getState().setServerThreads([{
      id: 'draft-thread',
      title: 'Hello',
      createdAt: now,
      updatedAt: now,
    }]);
    expect(useChatStore.getState().threads[0]).toMatchObject({ id: 'draft-thread', title: 'Hello' });
    expect(useChatStore.getState().threads[0].persistenceState).toBeUndefined();
    expect(useWorkspaceSurfaceStore.getState().threadId).toBe('draft-thread');
  });

  it('restores a failed first-send persistence attempt to a retryable draft', async () => {
    const { useChatStore, useWorkspaceSurfaceStore } = await loadFreshChatStore();
    const now = '2026-06-03T08:00:00.000Z';
    let attempts = 0;
    installRpcMock(async (method: string) => {
      if (method !== 'chat.thread.create') throw new Error(`Unexpected RPC method: ${method}`);
      attempts += 1;
      if (attempts === 1) throw new Error('create failed');
      return {
        thread: {
          id: 'draft-thread',
          title: 'Hello',
          resourceId: 'browser-user-test',
          createdAt: now,
          updatedAt: now,
          metadata: {},
        },
      };
    });
    useWorkspaceSurfaceStore.getState().selectThread('draft-thread', { id: 'draft-thread' });
    useChatStore.setState({
      resourceId: 'browser-user-test',
      threads: [{ id: 'draft-thread', title: '...', createdAt: now, updatedAt: now, draft: true }],
      hasInitializedThreads: true,
    });

    await expect(useChatStore.getState().ensureThreadPersisted('draft-thread', 'Hello')).rejects.toThrow('create failed');

    expect(useChatStore.getState().threads[0]).toMatchObject({ id: 'draft-thread', draft: true, title: 'Hello' });
    expect(useChatStore.getState().threads[0].persistenceState).toBeUndefined();
    useChatStore.getState().setServerThreads([]);
    expect(useWorkspaceSurfaceStore.getState().threadId).toBe('draft-thread');
    expect(useChatStore.getState().threads.map(thread => thread.id)).toEqual(['draft-thread']);

    await expect(useChatStore.getState().ensureThreadPersisted('draft-thread', 'Hello')).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(useChatStore.getState().threads[0]).toMatchObject({
      id: 'draft-thread',
      persistenceState: 'awaiting_server_list',
    });
  });

  it('does not send draft profileId when first persisting a project thread', async () => {
    const { useChatStore, useWorkspaceSurfaceStore } = await loadFreshChatStore();
    const now = '2026-06-03T08:00:00.000Z';
    const rpc = installRpcMock(async () => ({
      thread: {
        id: 'draft-thread',
        title: 'Hello',
        resourceId: 'browser-user-test',
        createdAt: now,
        updatedAt: now,
        metadata: { mode: 'project', projectId: 'project-1', workspaceId: 'workspace-1' },
      },
      workspace,
    }));
    useWorkspaceSurfaceStore.getState().selectThread('draft-thread', { id: 'draft-thread', workspaceId: 'workspace-1' });
    useChatStore.setState({
      resourceId: 'browser-user-test',
      threads: [{
        id: 'draft-thread',
        title: '...',
        createdAt: now,
        updatedAt: now,
        draft: true,
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        profileId: 'coding',
      } as any],
    });

    await useChatStore.getState().ensureThreadPersisted('draft-thread', 'Hello');

    expect(rpc).toHaveBeenCalledWith('code.project.threads.create', {
      projectId: 'project-1',
      threadId: 'draft-thread',
      title: 'Hello',
      workspaceId: 'workspace-1',
      product: 'code',
    }, undefined);
  });
});
