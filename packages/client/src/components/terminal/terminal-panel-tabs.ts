export type TerminalPanelTabLike = {
  id: string;
};

export type TerminalPanelWindowLike = {
  terminalId: string;
  slot: number;
};

export type TerminalPanelTabLabelLike = {
  cwd?: string;
  id?: string;
  label: string;
  processName?: string;
  title?: string;
};

const ignoredTerminalProcessNames = new Set([
  'bash',
  'cmd',
  'cmd.exe',
  'csh',
  'dash',
  'elvish',
  'fish',
  'ksh',
  'login',
  'nu',
  'pwsh',
  'powershell',
  'powershell.exe',
  'sh',
  'tcsh',
  'tmux',
  'zsh',
]);

export const getTerminalProcessDisplayName = (processName: string | undefined) => {
  const trimmed = processName?.trim();
  if (!trimmed) return undefined;
  const basename = trimmed.split('/').filter(Boolean).at(-1) ?? trimmed;
  return ignoredTerminalProcessNames.has(basename.toLowerCase()) ? undefined : basename;
};

export const getTerminalTitlePath = (terminalTitle: string | undefined) => {
  const trimmedTitle = terminalTitle?.trim();
  if (!trimmedTitle || /^weave-\d+-[a-z0-9]+$/.test(trimmedTitle)) return undefined;

  const shellTitleMatch = /^.+@[^:]+:(.+)$/.exec(trimmedTitle);
  return shellTitleMatch?.[1]?.trim() || trimmedTitle;
};

export const getTerminalPanelTabLabel = (tab: TerminalPanelTabLabelLike) =>
  getTerminalProcessDisplayName(tab.processName) ?? getTerminalTitlePath(tab.title) ?? tab.cwd ?? tab.label;

export const getActiveTerminalPanelTab = <Tab extends TerminalPanelTabLike>(
  tabs: Tab[],
  activeTabId?: string,
) => tabs.find(tab => tab.id === activeTabId) ?? tabs[0];

export const getTerminalSessionRenderItems = <Tab extends TerminalPanelTabLike>(
  tabs: Tab[],
  activeTabId?: string,
) => {
  const activeTab = getActiveTerminalPanelTab(tabs, activeTabId);
  return tabs.map(tab => ({
    tab,
    isActive: activeTab?.id === tab.id,
  }));
};

export const getSortedUniqueTerminalWindows = <Window extends TerminalPanelWindowLike>(windows: Window[]) => {
  const seenTerminalIds = new Set<string>();
  return [...windows]
    .sort((left, right) => left.slot - right.slot || left.terminalId.localeCompare(right.terminalId))
    .filter(window => {
      if (seenTerminalIds.has(window.terminalId)) return false;
      seenTerminalIds.add(window.terminalId);
      return true;
    });
};

export const getRestoredActiveTerminalTabId = <Tab extends TerminalPanelTabLike>(
  tabs: Tab[],
  activeTabId?: string,
) => tabs.some(tab => tab.id === activeTabId) ? activeTabId : tabs[0]?.id;
