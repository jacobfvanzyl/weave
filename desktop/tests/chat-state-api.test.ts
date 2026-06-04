import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureMastraConnection } from '../../packages/client/src/lib/mastra-client';
import { createWorkspace, listProjects, setProjectProfile, setServerThreadProfile, updateWorkspace } from '../../packages/client/src/lib/chat-state-api';
import { listProfiles } from '../../packages/client/src/lib/profiles-api';
import { expandPrompt, listPrompts } from '../../packages/client/src/lib/prompts-api';

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const workspace = {
  id: 'workspace-1',
  projectId: 'project-1',
  workspaceKind: 'worktree',
  source: 'git',
  name: 'Review checkout',
  path: '/repo.review',
  branch: 'feature/review',
  head: 'abc1234',
  detached: false,
  status: 'ready',
  createdAt: '2026-06-03T08:00:00.000Z',
  updatedAt: '2026-06-03T08:00:00.000Z',
};

const project = {
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
  const [storeModule, mastraClient] = await Promise.all([
    import('../../packages/client/src/stores/chat-store'),
    import('../../packages/client/src/lib/mastra-client'),
  ]);
  return {
    useChatStore: storeModule.useChatStore,
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

  it('switches branch as a workspace update', async () => {
    configureMastraConnection({ mastraUrl: 'http://weave.test', authToken: null });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ project, workspace: { ...workspace, branch: 'main' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(updateWorkspace('project-1', 'workspace-1', {
      branch: 'main',
      createBranch: false,
    })).resolves.toMatchObject({ id: 'workspace-1', branch: 'main' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://weave.test/projects/project-1/workspaces/workspace-1');
    expect(init).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(String(init?.body))).toEqual({ branch: 'main', createBranch: false });
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
    const { useChatStore } = await loadFreshChatStore();
    const now = '2026-06-03T08:00:00.000Z';
    useChatStore.setState({
      threadId: 'draft-thread',
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

  it('sends draft profileId when first persisting a plain thread', async () => {
    const { useChatStore, configureFreshMastraConnection } = await loadFreshChatStore();
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
    useChatStore.setState({
      resourceId: 'browser-user-test',
      threadId: 'draft-thread',
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
    const { useChatStore, configureFreshMastraConnection } = await loadFreshChatStore();
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
    useChatStore.setState({
      resourceId: 'browser-user-test',
      threadId: 'draft-thread',
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
