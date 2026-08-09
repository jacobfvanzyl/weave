import { afterEach, describe, expect, it, vi } from 'vitest';

const createStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

const snapshotStorage = (storage: Storage) =>
  Object.fromEntries(
    Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => Boolean(key))
      .map((key) => [key, storage.getItem(key) ?? '']),
  );

const seedStorage = (entries: Record<string, string>) => (storage: Storage) => {
  for (const [key, value] of Object.entries(entries)) storage.setItem(key, value);
};

const loadSessionRuntime = async (seed?: (storage: Storage) => void) => {
  vi.resetModules();
  const storage = createStorage();
  seed?.(storage);
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', {
    innerHeight: 800,
    innerWidth: 1200,
    localStorage: storage,
    location: { hostname: 'localhost', protocol: 'http:' },
  });

  const [
    { createClientSessionIdentity },
    { activateClientSessionStores },
    surface,
    editor,
    shell,
    terminal,
    session,
    chat,
  ] = await Promise.all([
    import('../../packages/client/src/lib/client-session'),
    import('../../packages/client/src/lib/client-session-activation'),
    import('../../packages/client/src/stores/workspace-surface-store'),
    import('../../packages/client/src/stores/editor-tab-store'),
    import('../../packages/client/src/stores/app-shell-store'),
    import('../../packages/client/src/stores/terminal-store'),
    import('../../packages/client/src/stores/client-session-view-store'),
    import('../../packages/client/src/stores/chat-store'),
  ]);

  return {
    activateClientSessionStores,
    chat,
    createClientSessionIdentity,
    editor,
    session,
    shell,
    storage,
    surface,
    terminal,
  };
};

describe('connection-scoped client session rehydration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('restores independent workspace, shell, editor, terminal, and composer state per owner and server', async () => {
    const runtime = await loadSessionRuntime();
    const ipad = runtime.createClientSessionIdentity('weave', 'https://weave.test/', 'owner-ipad');
    const mac = runtime.createClientSessionIdentity('weave', 'https://weave.test', 'owner-mac');

    await runtime.activateClientSessionStores(ipad);
    runtime.surface.useWorkspaceSurfaceStore.getState().selectWorkspace('notes-project', 'notes-vault');
    runtime.surface.useWorkspaceSurfaceStore.getState().closePane('editor');
    runtime.editor.useEditorTabStore.getState().openEditorTab('notes:notes-project:notes-vault', 'Daily.cpr');
    runtime.editor.useEditorTabStore.getState().setExpandedPaths('notes:notes-project:notes-vault', ['', 'Journal']);
    runtime.shell.useAppShellStore.getState().setSidebarPinnedOpen(false);
    runtime.shell.useAppShellStore.getState().setGeneralTerminalOpen(true);
    runtime.terminal.useTerminalStore.getState().setActiveTerminalTab('notes-vault', 'terminal-2');
    runtime.session.useClientSessionViewStore.getState().setComposerDraft('notes-draft', 'iPad note');

    await runtime.activateClientSessionStores(mac);
    const macSurface = runtime.surface.useWorkspaceSurfaceStore.getState().activeSurface;
    expect(macSurface.kind === 'workspace' && macSurface.projectId === 'notes-project').toBe(false);
    runtime.surface.useWorkspaceSurfaceStore.getState().selectWorkspace('code-project', 'code-workspace');
    runtime.surface.useWorkspaceSurfaceStore.getState().openPane('terminal');
    runtime.shell.useAppShellStore.getState().setSidebarPinnedOpen(true);
    runtime.shell.useAppShellStore.getState().setGeneralTerminalOpen(false);

    await runtime.activateClientSessionStores(ipad);
    expect(runtime.surface.useWorkspaceSurfaceStore.getState()).toMatchObject({
      activeSurface: {
        kind: 'workspace',
        projectId: 'notes-project',
        workspaceId: 'notes-vault',
      },
      paneVisibility: {
        chatOpen: false,
        editorOpen: false,
        terminalOpen: false,
      },
    });
    expect(
      runtime.editor.useEditorTabStore.getState().editorTabsByTarget['notes:notes-project:notes-vault']?.tabs,
    ).toHaveLength(1);
    expect(
      runtime.editor.useEditorTabStore.getState().expandedPathsByTarget['notes:notes-project:notes-vault'],
    ).toEqual(['', 'Journal']);
    expect(runtime.shell.useAppShellStore.getState()).toMatchObject({
      isSidebarPinnedOpen: false,
      isGeneralTerminalOpen: true,
    });
    expect(runtime.terminal.useTerminalStore.getState().activeTerminalTabByTarget['notes-vault']).toBe('terminal-2');
    expect(runtime.session.useClientSessionViewStore.getState().composerDrafts['notes-draft']).toBe('iPad note');

    const sessionKeys = Array.from({ length: runtime.storage.length }, (_, index) => runtime.storage.key(index) ?? '');
    expect(sessionKeys.some((key) => key.includes('owner-ipad'))).toBe(true);
    expect(sessionKeys.every((key) => !key.toLowerCase().includes('token'))).toBe(true);
  });

  it('reloads three app installations into their own Workspace-bound surfaces', async () => {
    const identityInput = ['weave', 'https://weave.test/', 'same-owner'] as const;
    const now = '2026-07-13T10:00:00.000Z';
    const projects = [
      { id: 'notes-project', workspaces: [{ id: 'notes-workspace' }] },
      { id: 'code-project', workspaces: [{ id: 'code-workspace' }] },
    ];
    const serverThreads = [
      {
        id: 'root-thread',
        title: 'Phone thread',
        createdAt: now,
        updatedAt: now,
        projectId: 'notes-project',
        workspaceId: 'notes-workspace',
      },
    ];

    const ipad = await loadSessionRuntime();
    await ipad.activateClientSessionStores(ipad.createClientSessionIdentity(...identityInput));
    ipad.surface.useWorkspaceSurfaceStore.getState().selectWorkspace('notes-project', 'notes-workspace');
    ipad.editor.useEditorTabStore.getState().openEditorTab('notes:notes-project:notes-workspace', 'Daily.cpr');
    const ipadStorage = snapshotStorage(ipad.storage);

    const mac = await loadSessionRuntime();
    await mac.activateClientSessionStores(mac.createClientSessionIdentity(...identityInput));
    mac.surface.useWorkspaceSurfaceStore.getState().selectWorkspace('code-project', 'code-workspace');
    mac.surface.useWorkspaceSurfaceStore.getState().closePane('chat');
    mac.surface.useWorkspaceSurfaceStore.getState().setTerminalPaneColumn('code-project', 'code-workspace', 'right');
    const macStorage = snapshotStorage(mac.storage);

    const iphone = await loadSessionRuntime();
    await iphone.activateClientSessionStores(iphone.createClientSessionIdentity(...identityInput));
    iphone.surface.useWorkspaceSurfaceStore.getState().restoreSurface(
      { kind: 'thread', threadId: 'root-thread' },
      { id: 'root-thread', workspaceId: 'notes-workspace' },
      { useDefaultLayout: true },
    );
    const iphoneStorage = snapshotStorage(iphone.storage);

    const restoredIpad = await loadSessionRuntime(seedStorage(ipadStorage));
    await restoredIpad.activateClientSessionStores(restoredIpad.createClientSessionIdentity(...identityInput));
    restoredIpad.chat.useChatStore.getState().setServerThreads(serverThreads, projects);
    expect(restoredIpad.surface.useWorkspaceSurfaceStore.getState()).toMatchObject({
      activeSurface: { kind: 'workspace', projectId: 'notes-project', workspaceId: 'notes-workspace' },
      paneVisibility: { chatOpen: false, editorOpen: true, terminalOpen: false },
    });
    expect(
      restoredIpad.editor.useEditorTabStore.getState().editorTabsByTarget['notes:notes-project:notes-workspace']?.tabs,
    ).toHaveLength(1);

    const restoredMac = await loadSessionRuntime(seedStorage(macStorage));
    await restoredMac.activateClientSessionStores(restoredMac.createClientSessionIdentity(...identityInput));
    restoredMac.chat.useChatStore.getState().setServerThreads(serverThreads, projects);
    expect(restoredMac.surface.useWorkspaceSurfaceStore.getState()).toMatchObject({
      activeSurface: { kind: 'workspace', projectId: 'code-project', workspaceId: 'code-workspace' },
      paneVisibility: { chatOpen: false, editorOpen: true, terminalOpen: false },
      terminalPaneColumnsByWorkspace: { 'code-project:code-workspace': 'right' },
    });

    const restoredIphone = await loadSessionRuntime(seedStorage(iphoneStorage));
    await restoredIphone.activateClientSessionStores(restoredIphone.createClientSessionIdentity(...identityInput));
    restoredIphone.chat.useChatStore.getState().setServerThreads(serverThreads, projects);
    expect(restoredIphone.surface.useWorkspaceSurfaceStore.getState()).toMatchObject({
      activeSurface: { kind: 'thread', threadId: 'root-thread' },
      paneVisibility: { chatOpen: true, editorOpen: true, terminalOpen: false },
    });
  });

  it('restores an exact valid surface and creates no Thread when every Workspace disappears', async () => {
    const runtime = await loadSessionRuntime();
    const identity = runtime.createClientSessionIdentity('weave', 'https://weave.test', 'owner-1');
    await runtime.activateClientSessionStores(identity);

    const now = '2026-07-13T10:00:00.000Z';
    runtime.chat.useChatStore.setState({
      threads: [
        {
          id: 'draft-workspace',
          title: '...',
          createdAt: now,
          updatedAt: now,
          projectId: 'project-1',
          workspaceId: 'workspace-1',
          draft: true,
        },
      ],
    });
    runtime.surface.useWorkspaceSurfaceStore.getState().restoreSurface({
      kind: 'thread',
      threadId: 'draft-workspace',
    });
    runtime.surface.useWorkspaceSurfaceStore.getState().closePane('chat');
    runtime.session.useClientSessionViewStore.getState().setComposerDraft('draft-workspace', 'keep me');

    runtime.chat.useChatStore.getState().setServerThreads(
      [],
      [
        {
          id: 'project-1',
          workspaces: [{ id: 'workspace-1' }],
        },
      ],
    );

    expect(runtime.surface.useWorkspaceSurfaceStore.getState()).toMatchObject({
      activeSurface: { kind: 'thread', threadId: 'draft-workspace' },
      paneVisibility: { chatOpen: false },
    });
    expect(runtime.session.useClientSessionViewStore.getState().composerDrafts['draft-workspace']).toBe('keep me');

    runtime.chat.useChatStore.getState().setServerThreads([], []);
    expect(runtime.chat.useChatStore.getState().threads).toEqual([]);
    expect(runtime.session.useClientSessionViewStore.getState().composerDrafts['draft-workspace']).toBeUndefined();

    runtime.chat.useChatStore.getState().setServerThreads([], []);
    expect(runtime.chat.useChatStore.getState().threads).toEqual([]);
  });

  it('claims legacy state for the first connected scope only', async () => {
    const runtime = await loadSessionRuntime((storage) => {
      storage.setItem(
        'weave-surface.weave',
        JSON.stringify({
          state: {
            threadId: 'legacy-thread',
            activeSurface: {
              kind: 'workspace',
              projectId: 'legacy-project',
              workspaceId: 'legacy-workspace',
            },
            paneVisibility: {
              chatOpen: false,
              editorOpen: true,
              terminalOpen: false,
            },
            surfaceLayouts: {},
            terminalPaneColumnsByWorkspace: {},
            maximizedPane: null,
          },
          version: 1,
        }),
      );
    });
    const first = runtime.createClientSessionIdentity('weave', 'https://first.test', 'owner-1');
    const second = runtime.createClientSessionIdentity('weave', 'https://second.test', 'owner-2');

    await runtime.activateClientSessionStores(first);
    expect(runtime.surface.useWorkspaceSurfaceStore.getState().activeSurface).toEqual({
      kind: 'workspace',
      projectId: 'legacy-project',
      workspaceId: 'legacy-workspace',
    });

    await runtime.activateClientSessionStores(second);
    const secondSurface = runtime.surface.useWorkspaceSurfaceStore.getState().activeSurface;
    expect(secondSurface.kind === 'workspace' && secondSurface.projectId === 'legacy-project').toBe(false);
    expect(runtime.storage.getItem('weave-surface.weave')).toBeTruthy();
  });

  it('removes view state for an archived legacy Thread without a Workspace', async () => {
    const runtime = await loadSessionRuntime();
    const identity = runtime.createClientSessionIdentity('weave', 'https://weave.test', 'owner-archive');
    await runtime.activateClientSessionStores(identity);
    const now = '2026-07-13T10:00:00.000Z';
    runtime.surface.useWorkspaceSurfaceStore.getState().restoreSurface({
      kind: 'thread',
      threadId: 'archived-thread',
    });
    runtime.surface.useWorkspaceSurfaceStore.getState().openPane('editor');
    runtime.session.useClientSessionViewStore.getState().setComposerDraft('archived-thread', 'resume after restore');

    runtime.chat.useChatStore.getState().setServerThreads(
      [
        {
          id: 'archived-thread',
          title: 'Archived',
          createdAt: now,
          updatedAt: now,
          archived: true,
        },
      ],
      [],
    );

    const restoredSurface = runtime.surface.useWorkspaceSurfaceStore.getState().activeSurface;
    expect(runtime.chat.useChatStore.getState().threads.some((thread) =>
      restoredSurface.kind === 'thread' && thread.id === restoredSurface.threadId
    )).toBe(false);
    expect(runtime.surface.useWorkspaceSurfaceStore.getState().surfaceLayouts['thread:archived-thread']).toBeUndefined();
    expect(runtime.session.useClientSessionViewStore.getState().composerDrafts['archived-thread']).toBeUndefined();
  });

  it('keeps a local draft when the user leaves it with composer text', async () => {
    const runtime = await loadSessionRuntime();
    const identity = runtime.createClientSessionIdentity('weave', 'https://weave.test', 'owner-drafts');
    await runtime.activateClientSessionStores(identity);
    const now = '2026-07-13T10:00:00.000Z';
    runtime.chat.useChatStore.setState({
      threads: [
        {
          id: 'draft-a',
          title: '...',
          createdAt: now,
          updatedAt: now,
          draft: true,
        },
        {
          id: 'draft-b',
          title: '...',
          createdAt: now,
          updatedAt: now,
          draft: true,
        },
      ],
    });
    runtime.surface.useWorkspaceSurfaceStore.getState().restoreSurface({
      kind: 'thread',
      threadId: 'draft-a',
    });
    runtime.session.useClientSessionViewStore.getState().setComposerDraft('draft-a', 'unfinished thought');

    runtime.chat.useChatStore.getState().selectThread('draft-b');

    expect(runtime.chat.useChatStore.getState().threads.map((thread) => thread.id)).toContain('draft-a');
    expect(runtime.session.useClientSessionViewStore.getState().composerDrafts['draft-a']).toBe('unfinished thought');
  });

  it('does not publish new scoped view state when entity reconciliation is already satisfied', async () => {
    const runtime = await loadSessionRuntime();
    const identity = runtime.createClientSessionIdentity('weave', 'https://weave.test', 'owner-stable-reconcile');
    await runtime.activateClientSessionStores(identity);
    runtime.session.useClientSessionViewStore.getState().setCollapsedProjectIds('all', ['project-1']);

    const before = runtime.session.useClientSessionViewStore.getState();
    before.reconcileProjects(new Set(['project-1']));

    expect(runtime.session.useClientSessionViewStore.getState()).toBe(before);
  });
});
