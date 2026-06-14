import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { EditorMode } from '../lib/editor-types';

export type EditorTab = {
  id: string;
  path: string;
};

export type EditorTabSet = {
  activeTabId?: string | undefined;
  tabs: EditorTab[];
};

export type EditorTabsChange = EditorTab[] | ((tabs: EditorTab[]) => EditorTab[]);

type PersistedEditorTabStoreState = {
  editorTabsByTarget: Record<string, EditorTabSet | undefined>;
};

type EditorTabStoreState = PersistedEditorTabStoreState & {
  closeEditorTab: (targetKey: string, tabId: string) => void;
  openEditorTab: (targetKey: string, path: string) => EditorTab;
  renameEditorTab: (targetKey: string, fromPath: string, toPath: string) => void;
  reorderEditorTabs: (targetKey: string, activeId: string, overId: string) => void;
  setActiveEditorTab: (targetKey: string, tabId: string | undefined) => void;
  setEditorTabs: (targetKey: string, tabs: EditorTabsChange) => void;
};

export const getEditorTabTargetKey = (mode: EditorMode, projectId: string, workspaceId: string) => (
  `${mode}:${projectId}:${workspaceId}`
);

export const getEditorTabId = (targetKey: string, path: string) => `${targetKey}:tab:${encodeURIComponent(path)}`;

export const createEditorTab = (targetKey: string, path: string): EditorTab => ({
  id: getEditorTabId(targetKey, path),
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
    normalized.push(createEditorTab(targetKey, path));
  }
  return normalized;
};

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
      openEditorTab: (targetKey, path) => {
        const nextTab = createEditorTab(targetKey, path);
        set(state => {
          const current = getTabSet(state, targetKey);
          const tabs = current.tabs.some(tab => tab.id === nextTab.id)
            ? current.tabs
            : [...current.tabs, nextTab];
          return {
            editorTabsByTarget: {
              ...state.editorTabsByTarget,
              [targetKey]: { tabs, activeTabId: nextTab.id },
            },
          };
        });
        return nextTab;
      },
      renameEditorTab: (targetKey, fromPath, toPath) =>
        set(state => {
          const current = getTabSet(state, targetKey);
          const fromId = getEditorTabId(targetKey, fromPath);
          const toTab = createEditorTab(targetKey, toPath);
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
      partialize: state => ({ editorTabsByTarget: state.editorTabsByTarget }),
    },
  ),
);
