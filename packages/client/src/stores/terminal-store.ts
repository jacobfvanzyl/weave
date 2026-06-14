import { create } from 'zustand';
import type { TerminalPanelTab, TerminalPanelTabsChange } from '../components/terminal/TerminalPanel';

export const generalTerminalId = 'weave-general-terminal';

let terminalPanelTabCounter = 0;

export const getPrimaryTerminalTabId = (baseTerminalId: string) => `${baseTerminalId}:primary`;

export const createTerminalPanelTab = (
  baseTerminalId: string,
  ordinal: number,
  useBaseTerminalId = false,
): TerminalPanelTab => {
  if (useBaseTerminalId) {
    return {
      id: getPrimaryTerminalTabId(baseTerminalId),
      terminalId: baseTerminalId,
      label: `Terminal ${ordinal}`,
    };
  }

  terminalPanelTabCounter += 1;
  const tabToken = `${Date.now().toString(36)}-${terminalPanelTabCounter.toString(36)}`;
  return {
    id: `${baseTerminalId}:tab:${tabToken}`,
    terminalId: `${baseTerminalId}:tab:${tabToken}`,
    label: `Terminal ${ordinal}`,
  };
};

type TerminalStoreState = {
  activeGeneralTerminalTabId: string;
  generalTerminalTabs: TerminalPanelTab[];
  activeTerminalTabByTarget: Record<string, string | undefined>;
  terminalTabsByTarget: Record<string, TerminalPanelTab[] | undefined>;
  activeTerminalWorkspaceIds: Set<string>;
  setActiveGeneralTerminalTabId: (tabId: string) => void;
  setGeneralTerminalTabs: (tabs: TerminalPanelTabsChange) => void;
  setActiveTerminalTab: (targetKey: string, tabId: string) => void;
  setTerminalTabs: (targetKey: string, tabs: TerminalPanelTabsChange) => void;
  setWorkspaceTerminalActive: (workspaceId: string, isActive: boolean) => void;
};

export const useTerminalStore = create<TerminalStoreState>()(set => ({
  activeGeneralTerminalTabId: getPrimaryTerminalTabId(generalTerminalId),
  generalTerminalTabs: [],
  activeTerminalTabByTarget: {},
  terminalTabsByTarget: {},
  activeTerminalWorkspaceIds: new Set(),
  setActiveGeneralTerminalTabId: activeGeneralTerminalTabId => set({ activeGeneralTerminalTabId }),
  setGeneralTerminalTabs: tabs =>
    set(state => {
      const nextTabs = typeof tabs === 'function' ? tabs(state.generalTerminalTabs) : tabs;
      return nextTabs === state.generalTerminalTabs ? state : { generalTerminalTabs: nextTabs };
    }),
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
