export type TerminalPanelTabLike = {
  id: string;
};

export type TerminalPanelWindowLike = {
  terminalId: string;
  slot: number;
};

export type TerminalPanelTabLabelLike = {
  cwd?: string;
  error?: string;
  id?: string;
  label: string;
  processName?: string;
  status?: string;
  title?: string;
};

const starshipDirectoryTruncationLength = 4;
const generatedWeaveTitlePattern = /^weave-\d+-[a-z0-9]+$/;
const generatedTerminalTitlePattern = /^terminal\s+\d+$/i;

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
  if (!trimmedTitle || generatedWeaveTitlePattern.test(trimmedTitle) || generatedTerminalTitlePattern.test(trimmedTitle)) {
    return undefined;
  }

  const shellTitleMatch = /^.+@[^:]+:(.+)$/.exec(trimmedTitle);
  if (shellTitleMatch?.[1]?.trim()) return shellTitleMatch[1].trim();
  return /^(~|\/|[A-Za-z]:[\\/])/.test(trimmedTitle) ? trimmedTitle : undefined;
};

const getTerminalTitleDisplayName = (terminalTitle: string | undefined) => {
  const trimmedTitle = terminalTitle?.trim();
  if (!trimmedTitle) return undefined;
  if (generatedWeaveTitlePattern.test(trimmedTitle)) return undefined;
  if (generatedTerminalTitlePattern.test(trimmedTitle)) return undefined;
  if (/^.+@[^:]+:.+$/.test(trimmedTitle)) return undefined;
  if (/^(~|\/|[A-Za-z]:[\\/])/.test(trimmedTitle)) return undefined;
  return trimmedTitle;
};

const trimTerminalPath = (path: string) => {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized === '/') return normalized;
  return normalized.replace(/\/+$/, '');
};

const getHomeRelativePath = (path: string) => {
  if (path === '~' || path.startsWith('~/')) return path;
  const match = /^\/(?:Users|home)\/[^/]+(?:\/(.*))?$/.exec(path);
  return match ? `~${match[1] ? `/${match[1]}` : ''}` : undefined;
};

const collapseWorkspacePathSegments = (segments: string[]) =>
  segments[0] === 'Documents' && segments.length >= 3 ? segments.slice(2) : segments;

export const getTerminalDirectoryDisplayName = (path: string | undefined) => {
  const trimmedPath = path?.trim();
  if (!trimmedPath) return undefined;

  const normalizedPath = trimTerminalPath(trimmedPath);
  const homeRelativePath = getHomeRelativePath(normalizedPath);
  const displayPath = homeRelativePath ?? normalizedPath;
  const isHomeRelative = displayPath === '~' || displayPath.startsWith('~/');
  const isAbsolute = !isHomeRelative && displayPath.startsWith('/');
  const isWindowsAbsolute = /^[A-Za-z]:\//.test(displayPath);

  if (displayPath === '~' || displayPath === '/') return displayPath;

  const pathWithoutPrefix = isHomeRelative
    ? displayPath.slice(2)
    : isAbsolute
    ? displayPath.slice(1)
    : isWindowsAbsolute
    ? displayPath.slice(3)
    : displayPath;
  const rawSegments = pathWithoutPrefix.split('/').filter(Boolean);
  if (!rawSegments.length) return isHomeRelative ? '~' : isAbsolute ? '/' : displayPath;

  const collapsedSegments = isHomeRelative ? collapseWorkspacePathSegments(rawSegments) : rawSegments;
  const wasCollapsed = collapsedSegments.length !== rawSegments.length;
  const shouldTruncate = collapsedSegments.length > starshipDirectoryTruncationLength;
  const visibleSegments = shouldTruncate
    ? collapsedSegments.slice(-starshipDirectoryTruncationLength)
    : collapsedSegments;
  const visiblePath = visibleSegments.join('/');

  if (!visiblePath) return isHomeRelative ? '~' : isAbsolute ? '/' : displayPath;
  if (shouldTruncate || wasCollapsed) return visiblePath;
  if (isHomeRelative) return `~/${visiblePath}`;
  if (isAbsolute) return `/${visiblePath}`;
  if (isWindowsAbsolute) return `${displayPath.slice(0, 2)}/${visiblePath}`;
  return visiblePath;
};

export const getTerminalPanelTabLabel = (tab: TerminalPanelTabLabelLike) =>
  getTerminalProcessDisplayName(tab.processName)
    ?? getTerminalTitleDisplayName(tab.title)
    ?? getTerminalDirectoryDisplayName(getTerminalTitlePath(tab.title) ?? tab.cwd)
    ?? tab.label;

export const mergeTerminalPanelTabMeta = <Tab extends TerminalPanelTabLabelLike>(
  tab: Tab,
  meta: Partial<Pick<TerminalPanelTabLabelLike, 'cwd' | 'error' | 'status' | 'title'>>,
): Tab => {
  const next: TerminalPanelTabLabelLike = { ...tab };

  if (meta.cwd?.trim()) next.cwd = meta.cwd;
  if (meta.title?.trim()) next.title = meta.title;
  if (Object.prototype.hasOwnProperty.call(meta, 'error')) next.error = meta.error;
  if (Object.prototype.hasOwnProperty.call(meta, 'status')) next.status = meta.status;

  if (
    next.cwd === tab.cwd
    && next.error === tab.error
    && next.status === tab.status
    && next.title === tab.title
  ) {
    return tab;
  }

  return { ...tab, ...next };
};

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
