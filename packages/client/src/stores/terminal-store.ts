import { create } from 'zustand';
import type { TerminalPanelTab, TerminalPanelTabsChange } from '../components/terminal/TerminalPanel';
import type { TerminalWindowRecord } from '../lib/terminal-types';

export const generalTerminalId = 'weave-general-terminal';

export const getPrimaryTerminalTabId = (baseTerminalId: string) => `${baseTerminalId}:primary`;

const sortedUniqueTerminalWindows = (windows: TerminalWindowRecord[]) => {
  const seenTerminalIds = new Set<string>();
  return [...windows]
    .sort((left, right) => left.slot - right.slot || left.terminalId.localeCompare(right.terminalId))
    .filter(window => {
      if (seenTerminalIds.has(window.terminalId)) return false;
      seenTerminalIds.add(window.terminalId);
      return true;
    });
};

const activeTabAfterReplace = (activeTabId: string | undefined, tabs: TerminalPanelTab[]) =>
  tabs.some(tab => tab.id === activeTabId) ? activeTabId : tabs[0]?.id;

const getWorkspaceTerminalWindowCounts = (windows: TerminalWindowRecord[]) => {
  const counts: Record<string, number | undefined> = {};
  for (const window of windows) {
    if (window.kind !== 'workspace' || !window.workspaceId) continue;
    counts[window.workspaceId] = (counts[window.workspaceId] ?? 0) + 1;
  }
  return counts;
};

const setWorkspaceTerminalWindowCount = (
  counts: Record<string, number | undefined>,
  workspaceId: string,
  count: number,
) => {
  const next = { ...counts };
  if (count > 0) next[workspaceId] = count;
  else delete next[workspaceId];

  if (
    Object.keys(next).length === Object.keys(counts).length
    && Object.entries(next).every(([key, value]) => counts[key] === value)
  ) {
    return counts;
  }

  return next;
};

export const createTerminalPanelTabsFromWindows = (
  baseTerminalId: string,
  windows: TerminalWindowRecord[],
  currentTabs: TerminalPanelTab[] = [],
) => {
  const currentTabsById = new Map(currentTabs.map(tab => [tab.id, tab]));
  return sortedUniqueTerminalWindows(windows).map(window => {
    const nextTab = createTerminalPanelTab(baseTerminalId, window.slot, window);
    const currentTab = currentTabsById.get(nextTab.id);
    if (!currentTab) return nextTab;
    return {
      ...nextTab,
      cwd: currentTab.cwd ?? nextTab.cwd,
      error: currentTab.error,
      status: currentTab.status,
      title: currentTab.title ?? nextTab.title,
    };
  });
};

export const createTerminalPanelTab = (
  baseTerminalId: string,
  ordinal: number,
  window?: TerminalWindowRecord,
  useBaseTerminalId = false,
): TerminalPanelTab => {
  if (window) {
    return {
      id: window.terminalId,
      terminalId: window.terminalId,
      slot: window.slot,
      scopeId: window.scopeId,
      portalId: window.portalId,
      rootId: window.rootId,
      projectId: window.projectId,
      workspaceId: window.workspaceId,
      cwd: window.cwd,
      processName: window.processName,
      title: window.title,
      label: `Terminal ${window.slot}`,
    };
  }

  if (useBaseTerminalId) {
    return {
      id: getPrimaryTerminalTabId(baseTerminalId),
      terminalId: baseTerminalId,
      label: `Terminal ${ordinal}`,
    };
  }

  return {
    id: `${baseTerminalId}:slot:${ordinal}`,
    terminalId: `${baseTerminalId}:slot:${ordinal}`,
    slot: ordinal,
    label: `Terminal ${ordinal}`,
  };
};

const refreshTerminalPanelTabMetadata = (
  tabs: TerminalPanelTab[],
  windows: TerminalWindowRecord[],
) => {
  const windowsByTerminalId = new Map(windows.map(window => [window.terminalId, window]));
  let didChange = false;
  const nextTabs = tabs.map(tab => {
    const window = windowsByTerminalId.get(tab.terminalId);
    if (!window) return tab;
    const nextTab = {
      ...tab,
      cwd: tab.cwd ?? window.cwd,
      processName: window.processName,
      title: tab.title ?? window.title,
    };
    if (
      nextTab.cwd === tab.cwd
      && nextTab.processName === tab.processName
      && nextTab.title === tab.title
    ) {
      return tab;
    }
    didChange = true;
    return nextTab;
  });
  return didChange ? nextTabs : tabs;
};

type TerminalStoreState = {
  activeGeneralTerminalTabId: string;
  generalTerminalTabs: TerminalPanelTab[];
  activeTerminalTabByTarget: Record<string, string | undefined>;
  terminalTabsByTarget: Record<string, TerminalPanelTab[] | undefined>;
  activeTerminalWorkspaceIds: Set<string>;
  workspaceTerminalWindowCounts: Record<string, number | undefined>;
  setActiveGeneralTerminalTabId: (tabId: string) => void;
  setGeneralTerminalTabs: (tabs: TerminalPanelTabsChange) => void;
  setGeneralTerminalWindows: (windows: TerminalWindowRecord[]) => void;
  refreshGeneralTerminalWindowMetadata: (windows: TerminalWindowRecord[]) => void;
  setTerminalSnapshotWindows: (windows: TerminalWindowRecord[]) => void;
  setActiveTerminalTab: (targetKey: string, tabId: string) => void;
  setTerminalTabs: (targetKey: string, tabs: TerminalPanelTabsChange) => void;
  setTerminalWindows: (targetKey: string, windows: TerminalWindowRecord[]) => void;
  refreshTerminalWindowMetadata: (targetKey: string, windows: TerminalWindowRecord[]) => void;
  setWorkspaceTerminalActive: (workspaceId: string, isActive: boolean) => void;
};

export const useTerminalStore = create<TerminalStoreState>()(set => ({
  activeGeneralTerminalTabId: getPrimaryTerminalTabId(generalTerminalId),
  generalTerminalTabs: [],
  activeTerminalTabByTarget: {},
  terminalTabsByTarget: {},
  activeTerminalWorkspaceIds: new Set(),
  workspaceTerminalWindowCounts: {},
  setActiveGeneralTerminalTabId: activeGeneralTerminalTabId => set({ activeGeneralTerminalTabId }),
  setGeneralTerminalTabs: tabs =>
    set(state => {
      const nextTabs = typeof tabs === 'function' ? tabs(state.generalTerminalTabs) : tabs;
      return nextTabs === state.generalTerminalTabs ? state : { generalTerminalTabs: nextTabs };
    }),
  setGeneralTerminalWindows: windows =>
    set(state => {
      const nextTabs = createTerminalPanelTabsFromWindows(generalTerminalId, windows, state.generalTerminalTabs);
      const activeGeneralTerminalTabId = activeTabAfterReplace(state.activeGeneralTerminalTabId, nextTabs)
        ?? state.activeGeneralTerminalTabId;
      return { generalTerminalTabs: nextTabs, activeGeneralTerminalTabId };
    }),
  refreshGeneralTerminalWindowMetadata: windows =>
    set(state => {
      const nextTabs = refreshTerminalPanelTabMetadata(state.generalTerminalTabs, windows);
      return nextTabs === state.generalTerminalTabs ? state : { generalTerminalTabs: nextTabs };
    }),
  setTerminalSnapshotWindows: windows =>
    set({ workspaceTerminalWindowCounts: getWorkspaceTerminalWindowCounts(windows) }),
  setActiveTerminalTab: (targetKey, tabId) =>
    set(state => ({
      activeTerminalTabByTarget: { ...state.activeTerminalTabByTarget, [targetKey]: tabId },
    })),
  setTerminalTabs: (targetKey, tabs) =>
    set(state => {
      const currentTabs = state.terminalTabsByTarget[targetKey] ?? [];
      const nextTabs = typeof tabs === 'function' ? tabs(currentTabs) : tabs;
      if (nextTabs === currentTabs) return state;
      return {
        terminalTabsByTarget: { ...state.terminalTabsByTarget, [targetKey]: nextTabs },
      };
    }),
  setTerminalWindows: (targetKey, windows) =>
    set(state => {
      const nextTabs = createTerminalPanelTabsFromWindows(targetKey, windows, state.terminalTabsByTarget[targetKey] ?? []);
      const activeTerminalTabId = activeTabAfterReplace(state.activeTerminalTabByTarget[targetKey], nextTabs);
      const workspaceId = windows.find(window => window.kind === 'workspace' && window.workspaceId)?.workspaceId ?? targetKey;
      return {
        activeTerminalTabByTarget: {
          ...state.activeTerminalTabByTarget,
          [targetKey]: activeTerminalTabId,
        },
        terminalTabsByTarget: {
          ...state.terminalTabsByTarget,
          [targetKey]: nextTabs,
        },
        workspaceTerminalWindowCounts: setWorkspaceTerminalWindowCount(
          state.workspaceTerminalWindowCounts,
          workspaceId,
          nextTabs.length,
        ),
      };
    }),
  refreshTerminalWindowMetadata: (targetKey, windows) =>
    set(state => {
      const currentTabs = state.terminalTabsByTarget[targetKey] ?? [];
      const nextTabs = refreshTerminalPanelTabMetadata(currentTabs, windows);
      if (nextTabs === currentTabs) return state;
      return {
        terminalTabsByTarget: {
          ...state.terminalTabsByTarget,
          [targetKey]: nextTabs,
        },
      };
    }),
  setWorkspaceTerminalActive: (workspaceId, isActive) =>
    set(state => {
      const next = new Set(state.activeTerminalWorkspaceIds);
      if (isActive) next.add(workspaceId);
      else next.delete(workspaceId);
      if (next.size === state.activeTerminalWorkspaceIds.size && [...next].every(id => state.activeTerminalWorkspaceIds.has(id))) {
        return state;
      }
      return { activeTerminalWorkspaceIds: next };
    }),
}));
