import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { EditorMode } from '../lib/editor-types';

export type EditorTab = {
  id: string;
  isPreview?: true;
  path: string;
};

export type EditorTabSet = {
  activeTabId?: string | undefined;
  tabs: EditorTab[];
};

export type EditorTabsChange = EditorTab[] | ((tabs: EditorTab[]) => EditorTab[]);
export type OpenEditorTabOptions = {
  preview?: boolean;
};

type PersistedEditorTabStoreState = {
  editorTabsByTarget: Record<string, EditorTabSet | undefined>;
};

type EditorTabStoreState = PersistedEditorTabStoreState & {
  closeEditorTab: (targetKey: string, tabId: string) => void;
  openEditorTab: (targetKey: string, path: string, options?: OpenEditorTabOptions) => EditorTab;
  pinEditorTab: (targetKey: string, tabId: string) => void;
  renameEditorTab: (targetKey: string, fromPath: string, toPath: string) => void;
  reorderEditorTabs: (targetKey: string, activeId: string, overId: string) => void;
  setActiveEditorTab: (targetKey: string, tabId: string | undefined) => void;
  setEditorTabs: (targetKey: string, tabs: EditorTabsChange) => void;
};

export const getEditorTabTargetKey = (mode: EditorMode, projectId: string, workspaceId: string) => (
  `${mode}:${projectId}:${workspaceId}`
);

export const getEditorTabId = (targetKey: string, path: string) => `${targetKey}:tab:${encodeURIComponent(path)}`;

export const createEditorTab = (targetKey: string, path: string, options: OpenEditorTabOptions = {}): EditorTab => ({
  id: getEditorTabId(targetKey, path),
  ...(options.preview ? { isPreview: true as const } : {}),
  path,
});

export const moveEditorTab = (tabs: EditorTab[], activeId: string, overId: string) => {
  const from = tabs.findIndex(tab => tab.id === activeId);
  const to = tabs.findIndex(tab => tab.id === overId);
  if (from < 0 || to < 0 || from === to) return tabs;
  const next = [...tabs];
  const [tab] = next.splice(from, 1);
  next.splice(to, 0, tab);
  return next;
};

const normalizeTabs = (targetKey: string, tabs: EditorTab[]) => {
  const seenPaths = new Set<string>();
  const normalized: EditorTab[] = [];
  for (const tab of tabs) {
    const path = tab.path.trim();
    if (!path || seenPaths.has(path)) continue;
    seenPaths.add(path);
    normalized.push(createEditorTab(targetKey, path, { preview: tab.isPreview }));
  }
  return normalized;
};

const pinEditorTabState = (targetKey: string, tab: EditorTab): EditorTab => (
  tab.isPreview ? createEditorTab(targetKey, tab.path) : tab
);

const getPersistableTabSet = (targetKey: string, tabSet: EditorTabSet): EditorTabSet => {
  const tabs = tabSet.tabs
    .filter(tab => !tab.isPreview)
    .map(tab => createEditorTab(targetKey, tab.path));
  return {
    tabs,
    activeTabId: tabs.some(tab => tab.id === tabSet.activeTabId)
      ? tabSet.activeTabId
      : tabs[0]?.id,
  };
};

const partializeEditorTabStore = (state: EditorTabStoreState): PersistedEditorTabStoreState => ({
  editorTabsByTarget: Object.fromEntries(
    Object.entries(state.editorTabsByTarget).map(([targetKey, tabSet]) => [
      targetKey,
      tabSet ? getPersistableTabSet(targetKey, tabSet) : tabSet,
    ]),
  ),
});

const getNextActiveTabId = (tabs: EditorTab[], closedTabId: string, activeTabId: string | undefined) => {
  if (activeTabId !== closedTabId) return activeTabId;
  const closedIndex = tabs.findIndex(tab => tab.id === closedTabId);
  const remainingTabs = tabs.filter(tab => tab.id !== closedTabId);
  return remainingTabs[Math.min(Math.max(closedIndex, 0), remainingTabs.length - 1)]?.id;
};

const getTabSet = (state: PersistedEditorTabStoreState, targetKey: string): EditorTabSet => (
  state.editorTabsByTarget[targetKey] ?? { tabs: [] }
);

export const useEditorTabStore = create<EditorTabStoreState>()(
  persist(
    (set, get) => ({
      editorTabsByTarget: {},
      closeEditorTab: (targetKey, tabId) =>
        set(state => {
          const current = getTabSet(state, targetKey);
          const nextTabs = current.tabs.filter(tab => tab.id !== tabId);
          if (nextTabs.length === current.tabs.length) return state;
          return {
            editorTabsByTarget: {
              ...state.editorTabsByTarget,
              [targetKey]: {
                tabs: nextTabs,
                activeTabId: getNextActiveTabId(current.tabs, tabId, current.activeTabId),
              },
            },
          };
        }),
      openEditorTab: (targetKey, path, options = {}) => {
        let openedTab = createEditorTab(targetKey, path, { preview: options.preview });
        set(state => {
          const current = getTabSet(state, targetKey);
          const existingTab = current.tabs.find(tab => tab.id === openedTab.id);
          const tabs = existingTab
            ? current.tabs
                .filter(tab => tab.id === existingTab.id || !tab.isPreview)
                .map(tab => tab.id === existingTab.id && !options.preview ? pinEditorTabState(targetKey, tab) : tab)
            : [
                openedTab,
                ...current.tabs.filter(tab => !tab.isPreview),
              ];
          openedTab = tabs.find(tab => tab.id === openedTab.id) ?? openedTab;
          return {
            editorTabsByTarget: {
              ...state.editorTabsByTarget,
              [targetKey]: { tabs, activeTabId: openedTab.id },
            },
          };
        });
        return openedTab;
      },
      pinEditorTab: (targetKey, tabId) =>
        set(state => {
          const current = getTabSet(state, targetKey);
          let didChange = false;
          const tabs = current.tabs.map(tab => {
            if (tab.id !== tabId || !tab.isPreview) return tab;
            didChange = true;
            return createEditorTab(targetKey, tab.path);
          });
          if (!didChange) return state;
          return {
            editorTabsByTarget: {
              ...state.editorTabsByTarget,
              [targetKey]: { ...current, tabs },
            },
          };
        }),
      renameEditorTab: (targetKey, fromPath, toPath) =>
        set(state => {
          const current = getTabSet(state, targetKey);
          const fromId = getEditorTabId(targetKey, fromPath);
          const sourceTab = current.tabs.find(tab => tab.id === fromId);
          const toTab = createEditorTab(targetKey, toPath, { preview: sourceTab?.isPreview });
          let didChange = false;
          const tabs = normalizeTabs(targetKey, current.tabs.map(tab => {
            if (tab.id !== fromId) return tab;
            didChange = true;
            return toTab;
          }));
          if (!didChange) return state;
          return {
            editorTabsByTarget: {
              ...state.editorTabsByTarget,
              [targetKey]: {
                tabs,
                activeTabId: current.activeTabId === fromId ? toTab.id : current.activeTabId,
              },
            },
          };
        }),
      reorderEditorTabs: (targetKey, activeId, overId) =>
        set(state => {
          const current = getTabSet(state, targetKey);
          const tabs = moveEditorTab(current.tabs, activeId, overId);
          if (tabs === current.tabs) return state;
          return {
            editorTabsByTarget: {
              ...state.editorTabsByTarget,
              [targetKey]: { ...current, tabs },
            },
          };
        }),
      setActiveEditorTab: (targetKey, tabId) =>
        set(state => {
          const current = getTabSet(state, targetKey);
          if (current.activeTabId === tabId) return state;
          return {
            editorTabsByTarget: {
              ...state.editorTabsByTarget,
              [targetKey]: { ...current, activeTabId: tabId },
            },
          };
        }),
      setEditorTabs: (targetKey, tabs) =>
        set(state => {
          const current = getTabSet(state, targetKey);
          const nextTabs = normalizeTabs(targetKey, typeof tabs === 'function' ? tabs(current.tabs) : tabs);
          return {
            editorTabsByTarget: {
              ...state.editorTabsByTarget,
              [targetKey]: {
                tabs: nextTabs,
                activeTabId: nextTabs.some(tab => tab.id === current.activeTabId)
                  ? current.activeTabId
                  : nextTabs[0]?.id,
              },
            },
          };
        }),
    }),
    {
      name: 'weave-editor-tabs',
      partialize: partializeEditorTabStore,
    },
  ),
);
