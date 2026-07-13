import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getClientAppStorageKey } from '../lib/client-app';
import {
  claimLegacyClientSessionStorage,
  type ClientSessionIdentity,
  createClientSessionPersistStorage,
  getClientSessionStorageKey,
  readClientSessionStorageValue,
  restoreClientSessionStorageValue,
} from '../lib/client-session';
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

export type EditorExplorerTab = 'explorer' | 'properties';

export type EditorDocumentViewState =
  | {
      kind: 'text';
      version?: string;
      anchor: number;
      head: number;
      topLine: number;
    }
  | {
      kind: 'coppermind';
      mode: 'page' | 'edgeless';
      activeSectionId?: string;
      canvas?: { centerX: number; centerY: number; zoom: number };
    }
  | {
      kind: 'excalidraw';
      scrollX: number;
      scrollY: number;
      zoom: number;
    };

type PersistedEditorTabStoreState = {
  editorTabsByTarget: Record<string, EditorTabSet | undefined>;
  explorerVisibleByTarget: Record<string, boolean | undefined>;
  explorerTabByTarget: Record<string, EditorExplorerTab | undefined>;
  expandedPathsByTarget: Record<string, string[] | undefined>;
  selectedPathByTarget: Record<string, string | undefined>;
  coppermindCellsSidebarOpenByTarget: Record<string, boolean | undefined>;
  documentViewsByKey: Record<string, EditorDocumentViewState | undefined>;
};

type EditorTabStoreState = PersistedEditorTabStoreState & {
  closeEditorTab: (targetKey: string, tabId: string) => void;
  openEditorTab: (targetKey: string, path: string, options?: OpenEditorTabOptions) => EditorTab;
  pinEditorTab: (targetKey: string, tabId: string) => void;
  renameEditorTab: (targetKey: string, fromPath: string, toPath: string) => void;
  reorderEditorTabs: (targetKey: string, activeId: string, overId: string) => void;
  setActiveEditorTab: (targetKey: string, tabId: string | undefined) => void;
  setEditorTabs: (targetKey: string, tabs: EditorTabsChange) => void;
  setExplorerVisible: (targetKey: string, visible: boolean) => void;
  setExplorerTab: (targetKey: string, tab: EditorExplorerTab) => void;
  setExpandedPaths: (targetKey: string, paths: string[]) => void;
  setSelectedPath: (targetKey: string, path: string | undefined) => void;
  setCoppermindCellsSidebarOpen: (targetKey: string, open: boolean) => void;
  setDocumentView: (documentKey: string, view: EditorDocumentViewState | undefined) => void;
  reconcileTargets: (targetKeys: ReadonlySet<string>) => void;
};

export const defaultEditorExplorerVisible = true;

export const getEditorTabTargetKey = (mode: EditorMode, projectId: string, workspaceId: string) =>
  `${mode}:${projectId}:${workspaceId}`;

export const getEditorTabId = (targetKey: string, path: string) => `${targetKey}:tab:${encodeURIComponent(path)}`;
export const getEditorDocumentViewKey = (targetKey: string, path: string) =>
  `${targetKey}:document:${encodeURIComponent(path)}`;

export const createEditorTab = (targetKey: string, path: string, options: OpenEditorTabOptions = {}): EditorTab => ({
  id: getEditorTabId(targetKey, path),
  ...(options.preview ? { isPreview: true as const } : {}),
  path,
});

export const moveEditorTab = (tabs: EditorTab[], activeId: string, overId: string) => {
  const from = tabs.findIndex((tab) => tab.id === activeId);
  const to = tabs.findIndex((tab) => tab.id === overId);
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

const pinEditorTabState = (targetKey: string, tab: EditorTab): EditorTab =>
  tab.isPreview ? createEditorTab(targetKey, tab.path) : tab;

const getPersistableTabSet = (targetKey: string, tabSet: EditorTabSet): EditorTabSet => {
  const tabs = tabSet.tabs
    .filter((tab) => !tab.isPreview)
    .map((tab) => createEditorTab(targetKey, tab.path));
  return {
    tabs,
    activeTabId: tabs.some((tab) => tab.id === tabSet.activeTabId)
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
  explorerVisibleByTarget: Object.fromEntries(
    Object.entries(state.explorerVisibleByTarget).filter(([, visible]) => typeof visible === 'boolean'),
  ),
  explorerTabByTarget: state.explorerTabByTarget,
  expandedPathsByTarget: state.expandedPathsByTarget,
  selectedPathByTarget: state.selectedPathByTarget,
  coppermindCellsSidebarOpenByTarget: state.coppermindCellsSidebarOpenByTarget,
  documentViewsByKey: state.documentViewsByKey,
});

const initialEditorTabStoreState = (): PersistedEditorTabStoreState => ({
  editorTabsByTarget: {},
  explorerVisibleByTarget: {},
  explorerTabByTarget: {},
  expandedPathsByTarget: {},
  selectedPathByTarget: {},
  coppermindCellsSidebarOpenByTarget: {},
  documentViewsByKey: {},
});

const normalizeEditorTabStoreState = (value: unknown): PersistedEditorTabStoreState => {
  const state = value && typeof value === 'object' ? (value as Partial<PersistedEditorTabStoreState>) : {};
  const record = <T>(candidate: unknown, predicate: (item: unknown) => item is T): Record<string, T | undefined> =>
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? Object.fromEntries(Object.entries(candidate).filter(([, item]) => predicate(item)))
      : {};
  return {
    editorTabsByTarget:
      state.editorTabsByTarget && typeof state.editorTabsByTarget === 'object' ? state.editorTabsByTarget : {},
    explorerVisibleByTarget: record(
      state.explorerVisibleByTarget,
      (item): item is boolean => typeof item === 'boolean',
    ),
    explorerTabByTarget: record(
      state.explorerTabByTarget,
      (item): item is EditorExplorerTab => item === 'explorer' || item === 'properties',
    ),
    expandedPathsByTarget: record(
      state.expandedPathsByTarget,
      (item): item is string[] => Array.isArray(item) && item.every((path) => typeof path === 'string'),
    ),
    selectedPathByTarget: record(state.selectedPathByTarget, (item): item is string => typeof item === 'string'),
    coppermindCellsSidebarOpenByTarget: record(
      state.coppermindCellsSidebarOpenByTarget,
      (item): item is boolean => typeof item === 'boolean',
    ),
    documentViewsByKey:
      state.documentViewsByKey && typeof state.documentViewsByKey === 'object' ? state.documentViewsByKey : {},
  };
};

const getNextActiveTabId = (tabs: EditorTab[], closedTabId: string, activeTabId: string | undefined) => {
  if (activeTabId !== closedTabId) return activeTabId;
  const closedIndex = tabs.findIndex((tab) => tab.id === closedTabId);
  const remainingTabs = tabs.filter((tab) => tab.id !== closedTabId);
  return remainingTabs[Math.min(Math.max(closedIndex, 0), remainingTabs.length - 1)]?.id;
};

const getTabSet = (state: PersistedEditorTabStoreState, targetKey: string): EditorTabSet =>
  state.editorTabsByTarget[targetKey] ?? { tabs: [] };

export const useEditorTabStore = create<EditorTabStoreState>()(
  persist(
    (set, get) => ({
      ...initialEditorTabStoreState(),
      closeEditorTab: (targetKey, tabId) =>
        set((state) => {
          const current = getTabSet(state, targetKey);
          const nextTabs = current.tabs.filter((tab) => tab.id !== tabId);
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
        let openedTab = createEditorTab(targetKey, path, { preview: options.preview, });
        set((state) => {
          const current = getTabSet(state, targetKey);
          const existingTab = current.tabs.find((tab) => tab.id === openedTab.id);
          const tabs = existingTab
            ? current.tabs
                .filter((tab) => tab.id === existingTab.id || !tab.isPreview)
                .map((tab) => ( tab.id === existingTab.id && !options.preview ? pinEditorTabState(targetKey, tab) : tab))
            : [
                openedTab,
                ...current.tabs.filter((tab) => !tab.isPreview)
              ];
          openedTab = tabs.find((tab) => tab.id === openedTab.id) ?? openedTab;
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
        set((state) => {
          const current = getTabSet(state, targetKey);
          let didChange = false;
          const tabs = current.tabs.map((tab) => {
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
        set((state) => {
          const current = getTabSet(state, targetKey);
          const fromId = getEditorTabId(targetKey, fromPath);
          const sourceTab = current.tabs.find((tab) => tab.id === fromId);
          const toTab = createEditorTab(targetKey, toPath, { preview: sourceTab?.isPreview, });
          let didChange = false;
          const tabs = normalizeTabs(targetKey, current.tabs.map((tab) => {
            if (tab.id !== fromId) return tab;
            didChange = true;
            return toTab;
          }),);
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
        set((state) => {
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
        set((state) => {
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
        set((state) => {
          const current = getTabSet(state, targetKey);
          const nextTabs = normalizeTabs(targetKey, typeof tabs === 'function' ? tabs(current.tabs) : tabs);
          return {
            editorTabsByTarget: {
              ...state.editorTabsByTarget,
              [targetKey]: {
                tabs: nextTabs,
                activeTabId: nextTabs.some((tab) => tab.id === current.activeTabId)
                  ? current.activeTabId
                  : nextTabs[0]?.id,
              },
            },
          };
        }),
      setExplorerVisible: (targetKey, visible) =>
        set((state) => {
          if ((state.explorerVisibleByTarget[targetKey] ?? defaultEditorExplorerVisible) === visible) return state;
          return {
            explorerVisibleByTarget: {
              ...state.explorerVisibleByTarget,
              [targetKey]: visible,
            },
          };
        }),
      setExplorerTab: (targetKey, tab) =>
        set((state) =>
          state.explorerTabByTarget[targetKey] === tab
            ? state
            : {
                explorerTabByTarget: {
                  ...state.explorerTabByTarget,
                  [targetKey]: tab,
                },
              },
        ),
      setExpandedPaths: (targetKey, paths) =>
        set((state) => {
          const nextPaths = Array.from(new Set(['', ...paths]));
          const currentPaths = state.expandedPathsByTarget[targetKey] ?? [''];
          if (
            currentPaths.length === nextPaths.length &&
            currentPaths.every((path, index) => path === nextPaths[index])
          )
            return state;
          return {
            expandedPathsByTarget: {
              ...state.expandedPathsByTarget,
              [targetKey]: nextPaths,
            },
          };
        }),
      setSelectedPath: (targetKey, path) =>
        set((state) => {
          const selectedPathByTarget = { ...state.selectedPathByTarget };
          if (path) selectedPathByTarget[targetKey] = path;
          else delete selectedPathByTarget[targetKey];
          return { selectedPathByTarget };
        }),
      setCoppermindCellsSidebarOpen: (targetKey, open) =>
        set((state) =>
          state.coppermindCellsSidebarOpenByTarget[targetKey] === open
            ? state
            : {
                coppermindCellsSidebarOpenByTarget: {
                  ...state.coppermindCellsSidebarOpenByTarget,
                  [targetKey]: open,
                },
              },
        ),
      setDocumentView: (documentKey, view) =>
        set((state) => {
          const documentViewsByKey = { ...state.documentViewsByKey };
          if (view) documentViewsByKey[documentKey] = view;
          else delete documentViewsByKey[documentKey];
          return { documentViewsByKey };
        }),
      reconcileTargets: (targetKeys) =>
        set((state) => {
          const targetRecords = [
            state.editorTabsByTarget,
            state.explorerVisibleByTarget,
            state.explorerTabByTarget,
            state.expandedPathsByTarget,
            state.selectedPathByTarget,
            state.coppermindCellsSidebarOpenByTarget,
          ];
          const documentBelongsToTarget = (documentKey: string) =>
            Array.from(targetKeys).some((targetKey) => documentKey.startsWith(`${targetKey}:document:`));
          if (
            targetRecords.every((record) => Object.keys(record).every((targetKey) => targetKeys.has(targetKey))) &&
            Object.keys(state.documentViewsByKey).every(documentBelongsToTarget)
          ) {
            return state;
          }
          const keepTargetRecord = <T>(record: Record<string, T | undefined>) =>
            Object.fromEntries(Object.entries(record).filter(([targetKey]) => targetKeys.has(targetKey)));
          return {
            editorTabsByTarget: keepTargetRecord(state.editorTabsByTarget),
            explorerVisibleByTarget: keepTargetRecord(state.explorerVisibleByTarget),
            explorerTabByTarget: keepTargetRecord(state.explorerTabByTarget),
            expandedPathsByTarget: keepTargetRecord(state.expandedPathsByTarget),
            selectedPathByTarget: keepTargetRecord(state.selectedPathByTarget),
            coppermindCellsSidebarOpenByTarget: keepTargetRecord(state.coppermindCellsSidebarOpenByTarget),
            documentViewsByKey: Object.fromEntries(
              Object.entries(state.documentViewsByKey).filter(([documentKey]) => documentBelongsToTarget(documentKey)),
            ),
          };
        }),
    }),
    {
      name: 'weave-editor-tabs',
      version: 2,
      skipHydration: true,
      migrate: normalizeEditorTabStoreState,
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...normalizeEditorTabStoreState(persistedState),
      }),
      partialize: partializeEditorTabStore,
    },
  ),
);

export const activateEditorTabSession = async (identity: ClientSessionIdentity) => {
  const name = getClientSessionStorageKey('weave-editor-tabs', identity);
  claimLegacyClientSessionStorage(name, ['weave-editor-tabs', getClientAppStorageKey('weave-editor-tabs')]);
  const persistedState = readClientSessionStorageValue(name);
  useEditorTabStore.persist.setOptions({
    name,
    storage: createClientSessionPersistStorage(),
  });
  useEditorTabStore.setState(initialEditorTabStoreState());
  restoreClientSessionStorageValue(name, persistedState);
  await useEditorTabStore.persist.rehydrate();
};
