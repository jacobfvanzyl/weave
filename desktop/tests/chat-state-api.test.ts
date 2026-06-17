import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureMastraConnection } from '../../packages/client/src/lib/mastra-client';
import { cancelThreadRun, createWorkspace, discoverWorkspaces, fetchWorkspaceGitUpstream, getThreadRunState, listProjectBranches, listProjects, listWorkspaceGitStates, pullWorkspaceGitUpstream, setProjectProfile, setServerThreadProfile, updateWorkspace, type Project, type Workspace } from '../../packages/client/src/lib/chat-state-api';
import { createWorkspaceDraftDefaults } from '../../packages/client/src/lib/workspace-create-defaults';
import { overlayWorkspaceGitState } from '../../packages/client/src/lib/workspace-git-state';
import { listProfiles } from '../../packages/client/src/lib/profiles-api';
import { expandPrompt, listPrompts } from '../../packages/client/src/lib/prompts-api';

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

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

const loadFreshChatStore = async () => {
  vi.resetModules();
  vi.stubGlobal('localStorage', createStorage());
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

  it('reads /projects response shapes', async () => {
    configureMastraConnection({ mastraUrl: 'http://weave.test', authToken: 'token-1' });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ projects: [project] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listProjects()).resolves.toEqual([project]);
    expect(fetchMock).toHaveBeenCalledWith('http://weave.test/projects', {
      headers: { Authorization: 'Bearer token-1' },
    });
  });

  it('reads and cancels active chat run state', async () => {
    configureMastraConnection({ mastraUrl: 'http://weave.test', authToken: 'token-1' });
    const run = {
      active: true,
      status: 'running',
      runId: 'run-1',
      startedAt: '2026-06-10T10:00:00.000Z',
      updatedAt: '2026-06-10T10:00:01.000Z',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ ok: true, run: { ...run, active: false, status: 'cancelled' } });
      return jsonResponse({ run });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getThreadRunState('thread-1')).resolves.toEqual(run);
    await expect(cancelThreadRun('thread-1')).resolves.toMatchObject({ active: false, status: 'cancelled' });

    expect(fetchMock.mock.calls).toEqual([
      ['http://weave.test/chat/thread-1/run', { headers: { Authorization: 'Bearer token-1' } }],
      ['http://weave.test/chat/thread-1/cancel', { method: 'POST', headers: { Authorization: 'Bearer token-1' } }],
    ]);
  });

  it('creates workspaces with separate display name and branch action', async () => {
    configureMastraConnection({ mastraUrl: 'http://weave.test', authToken: null });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ project, workspace }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createWorkspace('project-1', {
      name: 'Review checkout',
      mode: 'newBranch',
      branch: 'feature/review',
      base: 'main',
      path: '/repo.review',
    })).resolves.toEqual(workspace);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://weave.test/projects/project-1/workspaces');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'Review checkout',
      mode: 'newBranch',
      branch: 'feature/review',
      base: 'main',
      path: '/repo.review',
    });
  });

  it('creates detached workspaces without branch or path payload fields', async () => {
    configureMastraConnection({ mastraUrl: 'http://weave.test', authToken: null });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ project, workspace }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createWorkspace('project-1', {
      name: 'clever-lovelace',
      mode: 'detached',
      base: 'main',
    })).resolves.toEqual(workspace);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://weave.test/projects/project-1/workspaces');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'clever-lovelace',
      mode: 'detached',
      base: 'main',
    });
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
    configureMastraConnection({ mastraUrl: 'http://weave.test', authToken: null });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ project, workspace }));
    vi.stubGlobal('fetch', fetchMock);

    const updated = await updateWorkspace('project-1', 'workspace-1', {
      branch: 'main',
      createBranch: false,
    });
    expect(updated).toMatchObject({ id: 'workspace-1' });
    expect('branch' in updated).toBe(false);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://weave.test/projects/project-1/workspaces/workspace-1');
    expect(init).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(String(init?.body))).toEqual({ branch: 'main', createBranch: false });
  });

  it('reads live workspace git-state snapshots', async () => {
    configureMastraConnection({ mastraUrl: 'http://weave.test', authToken: 'token-1' });
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
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ states }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listWorkspaceGitStates()).resolves.toEqual(states);
    expect(fetchMock).toHaveBeenCalledWith('http://weave.test/projects/workspaces/git-state', {
      headers: { Authorization: 'Bearer token-1' },
    });
  });

  it('runs workspace upstream fetch and pull operations', async () => {
    configureMastraConnection({ mastraUrl: 'http://weave.test', authToken: 'token-1' });
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
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ state }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWorkspaceGitUpstream('project-1', 'workspace-1')).resolves.toEqual(state);
    await expect(pullWorkspaceGitUpstream('project-1', 'workspace-1')).resolves.toEqual(state);
    expect(fetchMock.mock.calls).toEqual([
      ['http://weave.test/projects/project-1/workspaces/workspace-1/git/fetch', {
        method: 'POST',
        headers: { Authorization: 'Bearer token-1' },
      }],
      ['http://weave.test/projects/project-1/workspaces/workspace-1/git/pull', {
        method: 'POST',
        headers: { Authorization: 'Bearer token-1' },
      }],
    ]);
  });

  it('reads project branch options', async () => {
    configureMastraConnection({ mastraUrl: 'http://weave.test', authToken: 'token-1' });
    const branches = [
      { name: 'main', ref: 'main', kind: 'local', current: true },
      { name: 'feature/review', ref: 'origin/feature/review', kind: 'remote' },
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ branches }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listProjectBranches('project-1')).resolves.toEqual(branches);
    expect(fetchMock).toHaveBeenCalledWith('http://weave.test/projects/project-1/branches', {
      headers: { Authorization: 'Bearer token-1' },
    });
  });

  it('discovers project worktrees with adoption metadata', async () => {
    configureMastraConnection({ mastraUrl: 'http://weave.test', authToken: 'token-1' });
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
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ worktrees }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(discoverWorkspaces('project-1')).resolves.toEqual(worktrees);
    expect(fetchMock).toHaveBeenCalledWith('http://weave.test/projects/project-1/workspaces/discover', {
      headers: { Authorization: 'Bearer token-1' },
    });
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

  it('updates thread and project profile metadata', async () => {
    configureMastraConnection({ mastraUrl: 'http://weave.test', authToken: null });
    const thread = {
      id: 'thread-1',
      title: 'Thread',
      resourceId: 'user-1',
      createdAt: '2026-06-03T08:00:00.000Z',
      updatedAt: '2026-06-03T08:00:00.000Z',
      metadata: { profileId: 'coding' },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes('/chat-state/threads/')) return jsonResponse({ thread });
      return jsonResponse({ project: { ...project, defaultProfileId: 'coding' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(setServerThreadProfile('thread-1', 'coding')).resolves.toMatchObject({ id: 'thread-1', profileId: 'coding' });
    await expect(setProjectProfile('project-1', 'coding')).resolves.toMatchObject({ id: 'project-1', defaultProfileId: 'coding' });

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, JSON.parse(String(init?.body))])).toEqual([
      ['http://weave.test/chat-state/threads/thread-1', 'PATCH', { profileId: 'coding' }],
      ['http://weave.test/projects/project-1/profile', 'PATCH', { profileId: 'coding' }],
    ]);
  });

  it('sends draft context query params for profile and prompt APIs', async () => {
    configureMastraConnection({ mastraUrl: 'http://weave.test', authToken: null });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes('/profiles')) {
        return jsonResponse({
          profiles: [],
          resolved: { profile: { id: 'builtin-default', name: 'Default', source: 'builtin', tools: [], skills: [], prompts: [], mcp: [] } },
        });
      }
      return jsonResponse({ prompts: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const context = {
      threadId: 'draft-thread',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      profileId: 'coding',
    };

    await listProfiles(context);
    await listPrompts(context);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://weave.test/profiles?threadId=draft-thread&projectId=project-1&workspaceId=workspace-1&profileId=coding',
      'http://weave.test/prompts?threadId=draft-thread&projectId=project-1&workspaceId=workspace-1&profileId=coding',
    ]);
  });

  it('sends draft context when expanding prompts', async () => {
    configureMastraConnection({ mastraUrl: 'http://weave.test', authToken: null });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ text: 'Ship now' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(expandPrompt('ship', 'now', {
      threadId: 'draft-thread',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      profileId: 'coding',
    })).resolves.toBe('Ship now');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://weave.test/prompts/ship/expand?threadId=draft-thread&projectId=project-1&workspaceId=workspace-1&profileId=coding');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(init?.body))).toEqual({
      arguments: 'now',
      threadId: 'draft-thread',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      profileId: 'coding',
    });
  });

  it('sets profiles only on local draft threads', async () => {
    const { useChatStore, useWorkspaceSurfaceStore } = await loadFreshChatStore();
    const now = '2026-06-03T08:00:00.000Z';
    useWorkspaceSurfaceStore.getState().selectThread('draft-thread', { id: 'draft-thread' });
    useChatStore.setState({
      threads: [
        { id: 'draft-thread', title: 'Draft', createdAt: now, updatedAt: now, draft: true },
        { id: 'server-thread', title: 'Started', createdAt: now, updatedAt: now, profileId: 'research' },
      ],
    });

    useChatStore.getState().setDraftThreadProfile('draft-thread', 'coding');
    useChatStore.getState().setDraftThreadProfile('server-thread', 'coding');

    expect(useChatStore.getState().threads).toEqual([
      expect.objectContaining({ id: 'draft-thread', profileId: 'coding' }),
      expect.objectContaining({ id: 'server-thread', profileId: 'research' }),
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

  it('sends draft profileId when first persisting a plain thread', async () => {
    const { useChatStore, useWorkspaceSurfaceStore, configureFreshMastraConnection } = await loadFreshChatStore();
    configureFreshMastraConnection({ mastraUrl: 'http://weave.test', authToken: null });
    const now = '2026-06-03T08:00:00.000Z';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      thread: {
        id: 'draft-thread',
        title: 'Hello',
        resourceId: 'browser-user-test',
        createdAt: now,
        updatedAt: now,
        metadata: { profileId: 'coding' },
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    useWorkspaceSurfaceStore.getState().selectThread('draft-thread', { id: 'draft-thread' });
    useChatStore.setState({
      resourceId: 'browser-user-test',
      threads: [{ id: 'draft-thread', title: '...', createdAt: now, updatedAt: now, draft: true, profileId: 'coding' }],
    });

    await useChatStore.getState().ensureThreadPersisted('draft-thread', 'Hello');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://weave.test/chat-state/threads');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(init?.body))).toEqual({
      threadId: 'draft-thread',
      title: 'Hello',
      profileId: 'coding',
    });
    expect(useChatStore.getState().threads[0]).toMatchObject({ id: 'draft-thread', profileId: 'coding' });
    expect(useChatStore.getState().threads[0].draft).toBeUndefined();
  });

  it('sends draft profileId when first persisting a project thread', async () => {
    const { useChatStore, useWorkspaceSurfaceStore, configureFreshMastraConnection } = await loadFreshChatStore();
    configureFreshMastraConnection({ mastraUrl: 'http://weave.test', authToken: null });
    const now = '2026-06-03T08:00:00.000Z';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      thread: {
        id: 'draft-thread',
        title: 'Hello',
        resourceId: 'browser-user-test',
        createdAt: now,
        updatedAt: now,
        metadata: { mode: 'project', projectId: 'project-1', workspaceId: 'workspace-1', profileId: 'coding' },
      },
      workspace,
    }));
    vi.stubGlobal('fetch', fetchMock);
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
      }],
    });

    await useChatStore.getState().ensureThreadPersisted('draft-thread', 'Hello');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://weave.test/projects/project-1/threads');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(init?.body))).toEqual({
      threadId: 'draft-thread',
      title: 'Hello',
      workspaceId: 'workspace-1',
      profileId: 'coding',
    });
  });
});
