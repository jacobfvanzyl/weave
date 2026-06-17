import { afterEach, describe, expect, it, vi } from 'vitest';

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

const loadFreshSurfaceStore = async (seed?: (storage: Storage) => void) => {
  vi.resetModules();
  const storage = createStorage();
  seed?.(storage);
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
  return import('../../packages/client/src/stores/workspace-surface-store');
};

describe('workspace surface store', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('migrates selection and pane layout from legacy chat persistence', async () => {
    const { useWorkspaceSurfaceStore } = await loadFreshSurfaceStore(storage => {
      storage.setItem('weave-chat', JSON.stringify({
        state: {
          threadId: 'thread-old',
          activeSurface: { kind: 'workspace', projectId: 'project-1', workspaceId: 'workspace-1' },
          paneVisibility: { chatOpen: false, editorOpen: true, terminalOpen: true },
          maximizedPane: 'editor',
          preMaximizePaneVisibility: { chatOpen: true, editorOpen: true, terminalOpen: false },
        },
        version: 10,
      }));
    });

    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      threadId: 'thread-old',
      activeSurface: { kind: 'workspace', projectId: 'project-1', workspaceId: 'workspace-1' },
      paneVisibility: { chatOpen: false, editorOpen: true, terminalOpen: true },
      maximizedPane: 'editor',
      preMaximizePaneVisibility: { chatOpen: true, editorOpen: true, terminalOpen: false },
    });
  });

  it('selects threads and workspaces with the expected pane defaults', async () => {
    const { useWorkspaceSurfaceStore } = await loadFreshSurfaceStore();

    useWorkspaceSurfaceStore.getState().selectThread('thread-1', { id: 'thread-1', workspaceId: 'workspace-1' });
    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      threadId: 'thread-1',
      activeSurface: { kind: 'thread', threadId: 'thread-1' },
      paneVisibility: { chatOpen: true, editorOpen: true, terminalOpen: false },
      maximizedPane: null,
    });

    useWorkspaceSurfaceStore.getState().selectWorkspace('project-1', 'workspace-1');
    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      threadId: 'thread-1',
      activeSurface: { kind: 'workspace', projectId: 'project-1', workspaceId: 'workspace-1' },
      paneVisibility: { chatOpen: false, editorOpen: true, terminalOpen: false },
      maximizedPane: null,
    });
  });

  it('restores each workspace pane layout when switching away and back', async () => {
    const { useWorkspaceSurfaceStore } = await loadFreshSurfaceStore();

    useWorkspaceSurfaceStore.getState().selectWorkspace('project-1', 'workspace-1');
    useWorkspaceSurfaceStore.getState().openPane('terminal');
    useWorkspaceSurfaceStore.getState().closePane('editor');
    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      activeSurface: { kind: 'workspace', projectId: 'project-1', workspaceId: 'workspace-1' },
      paneVisibility: { chatOpen: false, editorOpen: false, terminalOpen: true },
    });

    useWorkspaceSurfaceStore.getState().selectWorkspace('project-1', 'workspace-2');
    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      activeSurface: { kind: 'workspace', projectId: 'project-1', workspaceId: 'workspace-2' },
      paneVisibility: { chatOpen: false, editorOpen: true, terminalOpen: false },
      maximizedPane: null,
    });

    useWorkspaceSurfaceStore.getState().openPane('terminal');
    useWorkspaceSurfaceStore.getState().selectWorkspace('project-1', 'workspace-1');
    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      activeSurface: { kind: 'workspace', projectId: 'project-1', workspaceId: 'workspace-1' },
      paneVisibility: { chatOpen: false, editorOpen: false, terminalOpen: true },
      maximizedPane: null,
    });

    useWorkspaceSurfaceStore.getState().selectWorkspace('project-1', 'workspace-2');
    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      activeSurface: { kind: 'workspace', projectId: 'project-1', workspaceId: 'workspace-2' },
      paneVisibility: { chatOpen: false, editorOpen: true, terminalOpen: true },
      maximizedPane: null,
    });
  });

  it('restores workspace pane layouts from persisted surface state', async () => {
    const { useWorkspaceSurfaceStore } = await loadFreshSurfaceStore(storage => {
      storage.setItem('weave-surface', JSON.stringify({
        state: {
          threadId: 'thread-1',
          activeSurface: { kind: 'thread', threadId: 'thread-1' },
          paneVisibility: { chatOpen: true, editorOpen: false, terminalOpen: false },
          surfaceLayouts: {
            'workspace:project-1:workspace-1': {
              paneVisibility: { chatOpen: false, editorOpen: false, terminalOpen: true },
              maximizedPane: 'terminal',
              preMaximizePaneVisibility: { chatOpen: false, editorOpen: true, terminalOpen: true },
            },
          },
          maximizedPane: null,
        },
        version: 1,
      }));
    });

    useWorkspaceSurfaceStore.getState().selectWorkspace('project-1', 'workspace-1');
    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      activeSurface: { kind: 'workspace', projectId: 'project-1', workspaceId: 'workspace-1' },
      paneVisibility: { chatOpen: false, editorOpen: false, terminalOpen: true },
      maximizedPane: 'terminal',
      preMaximizePaneVisibility: { chatOpen: false, editorOpen: true, terminalOpen: true },
    });
  });

  it('restores each thread pane layout when switching away and back', async () => {
    const { useWorkspaceSurfaceStore } = await loadFreshSurfaceStore();

    useWorkspaceSurfaceStore.getState().selectThread('thread-1', { id: 'thread-1', workspaceId: 'workspace-1' });
    useWorkspaceSurfaceStore.getState().openPane('terminal');
    useWorkspaceSurfaceStore.getState().closePane('editor');

    useWorkspaceSurfaceStore.getState().selectThread('thread-2', { id: 'thread-2', workspaceId: 'workspace-1' });
    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      activeSurface: { kind: 'thread', threadId: 'thread-2' },
      paneVisibility: { chatOpen: true, editorOpen: true, terminalOpen: false },
      maximizedPane: null,
    });

    useWorkspaceSurfaceStore.getState().closePane('chat');
    useWorkspaceSurfaceStore.getState().selectThread('thread-1', { id: 'thread-1', workspaceId: 'workspace-1' });
    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      activeSurface: { kind: 'thread', threadId: 'thread-1' },
      paneVisibility: { chatOpen: true, editorOpen: false, terminalOpen: true },
      maximizedPane: null,
    });

    useWorkspaceSurfaceStore.getState().selectThread('thread-2', { id: 'thread-2', workspaceId: 'workspace-1' });
    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      activeSurface: { kind: 'thread', threadId: 'thread-2' },
      paneVisibility: { chatOpen: false, editorOpen: true, terminalOpen: false },
      maximizedPane: null,
    });
  });

  it('maximizes and restores pane layout from the surface store', async () => {
    const { useWorkspaceSurfaceStore } = await loadFreshSurfaceStore();

    useWorkspaceSurfaceStore.getState().selectThread('thread-1', { id: 'thread-1', workspaceId: 'workspace-1' });
    useWorkspaceSurfaceStore.getState().openPane('terminal');
    useWorkspaceSurfaceStore.getState().toggleMaximizedPane('editor');
    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      paneVisibility: { chatOpen: false, editorOpen: true, terminalOpen: false },
      maximizedPane: 'editor',
      preMaximizePaneVisibility: { chatOpen: true, editorOpen: true, terminalOpen: true },
    });

    useWorkspaceSurfaceStore.getState().restoreMaximizedPane();
    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      paneVisibility: { chatOpen: true, editorOpen: true, terminalOpen: true },
      maximizedPane: null,
      preMaximizePaneVisibility: undefined,
    });
  });

  it('restores maximized pane state for each workspace surface', async () => {
    const { useWorkspaceSurfaceStore } = await loadFreshSurfaceStore();

    useWorkspaceSurfaceStore.getState().selectWorkspace('project-1', 'workspace-1');
    useWorkspaceSurfaceStore.getState().openPane('terminal');
    useWorkspaceSurfaceStore.getState().toggleMaximizedPane('terminal');
    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      paneVisibility: { chatOpen: false, editorOpen: false, terminalOpen: true },
      maximizedPane: 'terminal',
      preMaximizePaneVisibility: { chatOpen: false, editorOpen: true, terminalOpen: true },
    });

    useWorkspaceSurfaceStore.getState().selectWorkspace('project-1', 'workspace-2');
    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      paneVisibility: { chatOpen: false, editorOpen: true, terminalOpen: false },
      maximizedPane: null,
      preMaximizePaneVisibility: undefined,
    });

    useWorkspaceSurfaceStore.getState().selectWorkspace('project-1', 'workspace-1');
    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      paneVisibility: { chatOpen: false, editorOpen: false, terminalOpen: true },
      maximizedPane: 'terminal',
      preMaximizePaneVisibility: { chatOpen: false, editorOpen: true, terminalOpen: true },
    });
  });

  it('keeps a maximized pane restorable when focus opens the already-open pane', async () => {
    const { useWorkspaceSurfaceStore } = await loadFreshSurfaceStore();

    useWorkspaceSurfaceStore.getState().selectThread('thread-1', { id: 'thread-1', workspaceId: 'workspace-1' });
    useWorkspaceSurfaceStore.getState().openPane('terminal');
    useWorkspaceSurfaceStore.getState().toggleMaximizedPane('chat');
    useWorkspaceSurfaceStore.getState().openPane('chat');

    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      paneVisibility: { chatOpen: true, editorOpen: false, terminalOpen: false },
      maximizedPane: 'chat',
      preMaximizePaneVisibility: { chatOpen: true, editorOpen: true, terminalOpen: true },
    });

    useWorkspaceSurfaceStore.getState().toggleMaximizedPane('chat');
    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      paneVisibility: { chatOpen: true, editorOpen: true, terminalOpen: true },
      maximizedPane: null,
      preMaximizePaneVisibility: undefined,
    });
  });

  it('stores editor follow requests ephemerally and opens the editor pane', async () => {
    const { useWorkspaceSurfaceStore } = await loadFreshSurfaceStore();

    useWorkspaceSurfaceStore.getState().selectThread('thread-1', { id: 'thread-1', workspaceId: 'workspace-1' });
    useWorkspaceSurfaceStore.getState().closePane('editor');
    useWorkspaceSurfaceStore.getState().requestEditorFollow({
      threadId: 'thread-1',
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
      line: 12,
      toolCallId: 'edit-1',
    });

    expect(useWorkspaceSurfaceStore.getState()).toMatchObject({
      paneVisibility: { chatOpen: true, editorOpen: true, terminalOpen: false },
      maximizedPane: null,
      editorFollowRequest: {
        threadId: 'thread-1',
        workspaceId: 'workspace-1',
        path: 'src/file.ts',
        line: 12,
        toolCallId: 'edit-1',
      },
    });

    const firstRequestId = useWorkspaceSurfaceStore.getState().editorFollowRequest?.id;
    useWorkspaceSurfaceStore.getState().requestEditorFollow({
      threadId: 'thread-1',
      workspaceId: 'workspace-1',
      path: 'src/other.ts',
      line: 1,
      toolCallId: 'write-1',
    });

    expect(useWorkspaceSurfaceStore.getState().editorFollowRequest?.id).toBeGreaterThan(firstRequestId ?? 0);
  });
});
