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

  it('persists tab path order and active tab without content state', async () => {
    const { storage, useEditorTabStore, getEditorTabTargetKey } = await loadFreshEditorTabStore();
    const targetKey = getEditorTabTargetKey('code', 'project-1', 'workspace-1');

    const first = useEditorTabStore.getState().openEditorTab(targetKey, 'src/a.ts');
    const second = useEditorTabStore.getState().openEditorTab(targetKey, 'src/b.ts');

    expect(useEditorTabStore.getState().editorTabsByTarget[targetKey]).toEqual({
      activeTabId: second.id,
      tabs: [first, second],
    });

    const persisted = storage.getItem('weave-editor-tabs');
    expect(persisted).toBeTruthy();
    const persistedTabSet = JSON.parse(persisted ?? '{}').state.editorTabsByTarget[targetKey];
    expect(persistedTabSet).toEqual({
      activeTabId: second.id,
      tabs: [first, second],
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

    useEditorTabStore.getState().reorderEditorTabs(targetKey, third.id, first.id);

    expect(useEditorTabStore.getState().editorTabsByTarget[targetKey]).toEqual({
      activeTabId: third.id,
      tabs: [third, first, second],
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
      activeTabId: third.id,
      tabs: [first, third],
    });

    useEditorTabStore.getState().closeEditorTab(targetKey, third.id);
    expect(useEditorTabStore.getState().editorTabsByTarget[targetKey]).toEqual({
      activeTabId: first.id,
      tabs: [first],
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
    expect(Object.prototype.hasOwnProperty.call(rehydratedTab, 'content')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(rehydratedTab, 'version')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(rehydratedTab, 'dirty')).toBe(false);
  });
});
