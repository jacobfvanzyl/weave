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

const loadFreshEditorTabStore = async (seed?: (storage: Storage) => void) => {
  vi.resetModules();
  const storage = createStorage();
  seed?.(storage);
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
  const module = await import('../../packages/client/src/stores/editor-tab-store');
  return { storage, ...module };
};

describe('editor tab store', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('opens new tabs at the start and persists stable tab order without content state', async () => {
    const { storage, useEditorTabStore, getEditorTabTargetKey } = await loadFreshEditorTabStore();
    const targetKey = getEditorTabTargetKey('code', 'project-1', 'workspace-1');

    const first = useEditorTabStore.getState().openEditorTab(targetKey, 'src/a.ts');
    const second = useEditorTabStore.getState().openEditorTab(targetKey, 'src/b.ts');

    expect(useEditorTabStore.getState().editorTabsByTarget[targetKey]).toEqual({
      activeTabId: second.id,
      tabs: [second, first],
    });

    const persisted = storage.getItem('weave-editor-tabs');
    expect(persisted).toBeTruthy();
    const persistedTabSet = JSON.parse(persisted ?? '{}').state.editorTabsByTarget[targetKey];
    expect(persistedTabSet).toEqual({
      activeTabId: second.id,
      tabs: [second, first],
    });
    expect(persistedTabSet.tabs.map((tab: Record<string, unknown>) => Object.keys(tab).sort())).toEqual([
      ['id', 'path'],
      ['id', 'path'],
    ]);
  });

  it('reorders tabs while preserving the active tab', async () => {
    const { useEditorTabStore, getEditorTabTargetKey } = await loadFreshEditorTabStore();
    const targetKey = getEditorTabTargetKey('notes', 'project-1', 'workspace-1');
    const first = useEditorTabStore.getState().openEditorTab(targetKey, 'Alpha.md');
    const second = useEditorTabStore.getState().openEditorTab(targetKey, 'Sketch.excalidraw');
    const third = useEditorTabStore.getState().openEditorTab(targetKey, 'Zed.md');

    useEditorTabStore.getState().reorderEditorTabs(targetKey, first.id, third.id);

    expect(useEditorTabStore.getState().editorTabsByTarget[targetKey]).toEqual({
      activeTabId: third.id,
      tabs: [first, third, second],
    });
  });

  it('selects the nearest remaining tab when closing the active tab', async () => {
    const { useEditorTabStore, getEditorTabTargetKey } = await loadFreshEditorTabStore();
    const targetKey = getEditorTabTargetKey('code', 'project-1', 'workspace-1');
    const first = useEditorTabStore.getState().openEditorTab(targetKey, 'src/a.ts');
    const second = useEditorTabStore.getState().openEditorTab(targetKey, 'src/b.ts');
    const third = useEditorTabStore.getState().openEditorTab(targetKey, 'src/c.ts');

    useEditorTabStore.getState().setActiveEditorTab(targetKey, second.id);
    useEditorTabStore.getState().closeEditorTab(targetKey, second.id);
    expect(useEditorTabStore.getState().editorTabsByTarget[targetKey]).toEqual({
      activeTabId: first.id,
      tabs: [third, first],
    });

    useEditorTabStore.getState().closeEditorTab(targetKey, first.id);
    expect(useEditorTabStore.getState().editorTabsByTarget[targetKey]).toEqual({
      activeTabId: third.id,
      tabs: [third],
    });
  });

  it('keeps preview tabs in memory but excludes them from persisted storage', async () => {
    const { storage, useEditorTabStore, getEditorTabTargetKey } = await loadFreshEditorTabStore();
    const targetKey = getEditorTabTargetKey('code', 'project-1', 'workspace-1');

    const stable = useEditorTabStore.getState().openEditorTab(targetKey, 'src/a.ts');
    const preview = useEditorTabStore.getState().openEditorTab(targetKey, 'src/b.ts', { preview: true });

    expect(preview).toEqual({
      id: preview.id,
      isPreview: true,
      path: 'src/b.ts',
    });
    expect(useEditorTabStore.getState().editorTabsByTarget[targetKey]).toEqual({
      activeTabId: preview.id,
      tabs: [preview, stable],
    });

    const persisted = storage.getItem('weave-editor-tabs');
    expect(persisted).toBeTruthy();
    const persistedTabSet = JSON.parse(persisted ?? '{}').state.editorTabsByTarget[targetKey];
    expect(persistedTabSet).toEqual({
      activeTabId: stable.id,
      tabs: [stable],
    });
  });

  it('pins preview tabs into stable persisted tabs', async () => {
    const { storage, useEditorTabStore, getEditorTabTargetKey } = await loadFreshEditorTabStore();
    const targetKey = getEditorTabTargetKey('notes', 'project-1', 'workspace-1');

    const preview = useEditorTabStore.getState().openEditorTab(targetKey, 'Draft.md', { preview: true });
    useEditorTabStore.getState().pinEditorTab(targetKey, preview.id);

    const pinned = { id: preview.id, path: 'Draft.md' };
    expect(useEditorTabStore.getState().editorTabsByTarget[targetKey]).toEqual({
      activeTabId: preview.id,
      tabs: [pinned],
    });

    const persisted = storage.getItem('weave-editor-tabs');
    expect(persisted).toBeTruthy();
    const persistedTabSet = JSON.parse(persisted ?? '{}').state.editorTabsByTarget[targetKey];
    expect(persistedTabSet).toEqual({
      activeTabId: preview.id,
      tabs: [pinned],
    });
  });

  it('stores explorer visibility per editor target', async () => {
    const { storage, useEditorTabStore, getEditorTabTargetKey, defaultEditorExplorerVisible } = await loadFreshEditorTabStore();
    const firstTargetKey = getEditorTabTargetKey('code', 'project-1', 'workspace-1');
    const secondTargetKey = getEditorTabTargetKey('code', 'project-1', 'workspace-2');

    expect(useEditorTabStore.getState().explorerVisibleByTarget[firstTargetKey] ?? defaultEditorExplorerVisible)
      .toBe(true);

    useEditorTabStore.getState().setExplorerVisible(firstTargetKey, false);
    expect(useEditorTabStore.getState().explorerVisibleByTarget[firstTargetKey]).toBe(false);
    expect(useEditorTabStore.getState().explorerVisibleByTarget[secondTargetKey] ?? defaultEditorExplorerVisible)
      .toBe(true);

    const persisted = storage.getItem('weave-editor-tabs');
    expect(persisted).toBeTruthy();
    expect(JSON.parse(persisted ?? '{}').state.explorerVisibleByTarget).toEqual({
      [firstTargetKey]: false,
    });
  });

  it('rehydrates persisted tabs without file content fields', async () => {
    const targetKey = 'notes:project-1:workspace-1';
    const tabId = (path: string) => `${targetKey}:tab:${encodeURIComponent(path)}`;
    const persistedTabSet = {
      activeTabId: tabId('Sketch.excalidraw'),
      tabs: [
        { id: tabId('Alpha.md'), path: 'Alpha.md' },
        { id: tabId('Sketch.excalidraw'), path: 'Sketch.excalidraw' },
      ],
    };
    const { useEditorTabStore } = await loadFreshEditorTabStore(storage => {
      storage.setItem('weave-editor-tabs', JSON.stringify({
        state: {
          editorTabsByTarget: {
            [targetKey]: persistedTabSet,
          },
        },
        version: 0,
      }));
    });

    const rehydratedTab = useEditorTabStore.getState().editorTabsByTarget[targetKey]?.tabs[0];
    expect(useEditorTabStore.getState().editorTabsByTarget[targetKey]).toEqual(persistedTabSet);
    expect(useEditorTabStore.getState().explorerVisibleByTarget).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(rehydratedTab, 'content')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(rehydratedTab, 'version')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(rehydratedTab, 'dirty')).toBe(false);
  });
});
