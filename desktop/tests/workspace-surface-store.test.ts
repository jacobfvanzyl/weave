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
});
