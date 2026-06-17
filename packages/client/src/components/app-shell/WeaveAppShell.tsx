import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Code2, MessageSquare, MonitorUp, PanelLeft, StickyNote, TerminalSquare } from 'lucide-react';
import { listServerThreads } from '../../lib/chat-state-api';
import { createTerminalTransport, isDesktopTerminalTransportAvailable } from '../../lib/terminal-transport';
import { useChatStore } from '../../stores/chat-store';
import { useAppShellStore } from '../../stores/app-shell-store';
import { generalTerminalId, useTerminalStore } from '../../stores/terminal-store';
import { useWorkspaceSurfaceStore, type MainPane } from '../../stores/workspace-surface-store';
import { Button } from '../ui/button';
import { ShortcutProvider } from '../shortcuts';
import { AppSidebarHost } from './AppSidebarHost';
import { useAppShortcuts } from './useAppShortcuts';
import { useShellLayout } from './useShellLayout';
import { ChatPane } from '../chat/ChatPane';
import { EditorPane } from '../editor/EditorPane';
import { GlobalTerminalOverlay } from '../terminal/GlobalTerminalOverlay';
import { TerminalPaneHost } from '../terminal/TerminalPaneHost';
import type { TerminalPanelTab, TerminalPanelTabsChange, TerminalPanelTarget } from '../terminal/TerminalPanel';
import type { TerminalTargetInput, TerminalTransport, TerminalWindowRecord } from '../../lib/terminal-types';
import { WindowStreamOverlayHost } from '../window-stream/WindowStreamOverlayHost';
import { WorkspaceMainContent } from '../workspace/WorkspaceMainContent';
import {
  chatContentMaxWidthPx,
  editorColumnMeasureText,
  useIsPortraitViewport,
  useMainPaneMetrics,
} from '../workspace/useMainPaneMetrics';
import { useWorkspaceTargets } from '../workspace/useWorkspaceTargets';

const isElectronWindowNow = () =>
  typeof document !== 'undefined' && document.documentElement.dataset.weaveWindowType === 'electron';
const TerminalTabCountBadge = ({ count }: { count: number }) => count > 0 ? (
  <span
    className="pointer-events-none absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-background bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground shadow-sm"
    data-weave-terminal-count-badge
  >
    {count}
  </span>
) : null;
const terminalProcessRefreshMs = 2_000;
const terminalSnapshotRefreshMs = 5_000;

const terminalTargetInput = (target: TerminalPanelTarget): TerminalTargetInput => ({
  kind: target.kind,
  projectId: target.projectId,
  workspaceId: target.workspaceId,
  portalId: target.portalId,
  rootId: target.rootId,
  repoPath: target.repoPath,
  workspacePath: target.workspacePath,
  cwd: target.cwd,
});

const isTerminalWindowForTarget = (window: TerminalWindowRecord, target: TerminalPanelTarget) => {
  if (window.kind !== target.kind) return false;
  if (target.kind === 'workspace') {
    return window.projectId === target.projectId && window.workspaceId === target.workspaceId;
  }

  if (target.portalId && window.portalId && window.portalId !== target.portalId) return false;
  if (target.rootId && window.rootId && window.rootId !== target.rootId) return false;
  return true;
};

const terminalSyncKey = (target?: TerminalPanelTarget) => target ? [
  target.kind,
  target.portalId ?? '',
  target.rootId ?? '',
  target.projectId ?? '',
  target.workspaceId ?? '',
  target.workspacePath ?? '',
  target.cwd ?? '',
].join(':') : undefined;

type WeaveAppShellProps = {
  connectionSettingsButton?: ReactNode;
};

export const WeaveAppShell = ({ connectionSettingsButton }: WeaveAppShellProps = {}) => {
  const resourceId = useChatStore(state => state.resourceId);
  const threadId = useWorkspaceSurfaceStore(state => state.threadId);
  const activeSurface = useWorkspaceSurfaceStore(state => state.activeSurface);
  const threads = useChatStore(state => state.threads);
  const threadPlans = useChatStore(state => state.threadPlans);
  const showPlanPanel = useChatStore(state => state.showPlanPanel);
  const runningThreadIds = useChatStore(state => state.runningThreadIds);
  const setServerThreads = useChatStore(state => state.setServerThreads);
  const newThread = useChatStore(state => state.newThread);
  const setShowPlanPanel = useChatStore(state => state.setShowPlanPanel);
  const paneVisibility = useWorkspaceSurfaceStore(state => state.paneVisibility);
  const maximizedPane = useWorkspaceSurfaceStore(state => state.maximizedPane);
  const editorFollowRequest = useWorkspaceSurfaceStore(state => state.editorFollowRequest);
  const openPane = useWorkspaceSurfaceStore(state => state.openPane);
  const closePane = useWorkspaceSurfaceStore(state => state.closePane);
  const togglePane = useWorkspaceSurfaceStore(state => state.togglePane);
  const toggleMaximizedPane = useWorkspaceSurfaceStore(state => state.toggleMaximizedPane);
  const restoreMaximizedPane = useWorkspaceSurfaceStore(state => state.restoreMaximizedPane);
  const queryClient = useQueryClient();
  const { editorMinimumMeasureRef, editorMinimumWidthPx, pageRef, pageWidth } = useMainPaneMetrics();
  const sidebarSurfaceRef = useRef<HTMLElement | null>(null);
  const chatSurfaceRef = useRef<HTMLDivElement | null>(null);
  const isPortraitViewport = useIsPortraitViewport();
  const isElectronWindow = isElectronWindowNow();
  const {
    activeProject,
    activeThread,
    activeThreadId,
    activeWorkspace,
    editorTarget,
    generalTerminalTarget,
    hasChatPaneTarget,
    hasThreadTitle,
    hasWindowStreamPortal,
    notesTarget,
    onlinePortals,
    terminalTarget,
  } = useWorkspaceTargets({
    activeSurface,
    isElectronWindow,
    resourceId,
    threadId,
    threads,
  });
  const activePlan = threadPlans[activeThreadId];
  const canFollowWrites = Boolean(editorTarget && activeThread?.workspaceId && activeSurface.kind === 'thread');
  const showChatPane = hasChatPaneTarget && paneVisibility.chatOpen;
  const isChatMaximized = maximizedPane === 'chat';
  const hasEditorPaneTarget = Boolean(editorTarget || notesTarget);
  const showEditorPane = hasEditorPaneTarget && paneVisibility.editorOpen;
  const isEditorMaximized = maximizedPane === 'editor';
  const hasTerminalPaneTarget = Boolean(terminalTarget);
  const showTerminalPane = hasTerminalPaneTarget && paneVisibility.terminalOpen;
  const isTerminalMaximized = maximizedPane === 'terminal';
  const isTerminalOnlyPane = showTerminalPane && !showChatPane && !showEditorPane;
  const isTerminalEffectivelyMaximized = isTerminalMaximized || isTerminalOnlyPane;
  const canToggleTerminalMaximized = isTerminalMaximized || showChatPane || showEditorPane;
  const visibleMainPaneMinimumWidthPx = (showChatPane ? chatContentMaxWidthPx : 0)
    + (showEditorPane ? editorMinimumWidthPx : 0)
    + (showTerminalPane && !showChatPane && !showEditorPane ? editorMinimumWidthPx : 0);
  const terminalHost = showTerminalPane
    ? showChatPane && showEditorPane
      ? 'chat'
      : showEditorPane
        ? 'editor'
        : showChatPane
          ? 'chat'
          : 'standalone'
    : null;
  const showTerminalInChatPane = terminalHost === 'chat';
  const showTerminalInEditorPane = terminalHost === 'editor';
  const showStandaloneTerminalPane = terminalHost === 'standalone';
  const sideEditorTargetKey = editorTarget ? `code:${editorTarget.workspaceId}` : notesTarget ? `notes:${notesTarget.workspaceId}` : undefined;
  const terminalWorkspaceId = terminalTarget?.workspaceId;
  const terminalTargetKey = terminalTarget?.terminalId;
  const terminalTransport = useMemo<TerminalTransport | undefined>(() => createTerminalTransport(), []);
  const [terminalSyncingTargets, setTerminalSyncingTargets] = useState<Set<string>>(() => new Set());
  const [terminalSyncErrors, setTerminalSyncErrors] = useState<Record<string, string | undefined>>({});
  const terminalSyncSequenceRef = useRef(0);
  const latestTerminalSyncByTargetRef = useRef<Map<string, number>>(new Map());
  const generalTerminalTabs = useTerminalStore(state => state.generalTerminalTabs);
  const setGeneralTerminalTabs = useTerminalStore(state => state.setGeneralTerminalTabs);
  const setGeneralTerminalWindows = useTerminalStore(state => state.setGeneralTerminalWindows);
  const refreshGeneralTerminalWindowMetadata = useTerminalStore(state => state.refreshGeneralTerminalWindowMetadata);
  const activeGeneralTerminalTabId = useTerminalStore(state => state.activeGeneralTerminalTabId);
  const setActiveGeneralTerminalTabId = useTerminalStore(state => state.setActiveGeneralTerminalTabId);
  const terminalTabsByTarget = useTerminalStore(state => state.terminalTabsByTarget);
  const setTerminalTabs = useTerminalStore(state => state.setTerminalTabs);
  const setTerminalWindows = useTerminalStore(state => state.setTerminalWindows);
  const refreshWorkspaceTerminalWindowMetadata = useTerminalStore(state => state.refreshTerminalWindowMetadata);
  const setTerminalSnapshotWindows = useTerminalStore(state => state.setTerminalSnapshotWindows);
  const activeTerminalTabByTarget = useTerminalStore(state => state.activeTerminalTabByTarget);
  const setActiveTerminalTab = useTerminalStore(state => state.setActiveTerminalTab);
  const isWindowStreamOpen = useAppShellStore(state => state.isWindowStreamOpen);
  const setWindowStreamOpen = useAppShellStore(state => state.setWindowStreamOpen);
  const isWindowStreamActive = useAppShellStore(state => state.isWindowStreamActive);
  const setWindowStreamActive = useAppShellStore(state => state.setWindowStreamActive);
  const windowSurfaces = useShellLayout({
    editorTargetKey: sideEditorTargetKey,
    hasEditorTarget: hasEditorPaneTarget,
    hasGeneralTerminalTarget: Boolean(generalTerminalTarget),
    isPortraitViewport,
    maximizedPane: isTerminalOnlyPane ? 'terminal' : maximizedPane,
    pageWidth,
    terminalWorkspaceId,
    visibleMainPaneMinimumWidthPx,
  });
  const {
    closeSidebar,
    closeSidebarPreview,
    editorFocusRequest,
    focusEditor,
    focusGeneralTerminal,
    focusTerminal,
    handleGeneralTerminalSessionActiveChange,
    handleTerminalSessionActiveChange,
    hasActiveTerminal,
    hasEditorTarget,
    hasGeneralTerminalTarget,
    hasTerminalTarget,
    hideGeneralTerminal,
    isGeneralTerminalActive,
    isGeneralTerminalOpen,
    isSidebarAutoHidden,
    isSidebarOpen,
    isSidebarPinnedOpen,
    openSidebarPreview,
    scheduleSidebarPreviewClose,
    showHeaderSidebarToggle,
    showPinnedSidebarToggle,
    showSidebarPreview,
    generalTerminalFocusRequest,
    terminalFocusRequest,
    toggleGeneralTerminal,
    toggleSidebar,
  } = windowSurfaces;
  const terminalTabs = terminalTargetKey ? terminalTabsByTarget[terminalTargetKey] ?? [] : [];
  const activeTerminalTabId = terminalTargetKey
    ? activeTerminalTabByTarget[terminalTargetKey] ?? terminalTabs[0]?.id
    : undefined;
  const generalTerminalSyncTarget = useMemo<TerminalPanelTarget | undefined>(() => generalTerminalTarget ? ({
    kind: 'general',
    terminalId: generalTerminalId,
    portalId: generalTerminalTarget.portalId,
    rootId: generalTerminalTarget.rootId,
    title: generalTerminalTarget.title,
  }) : undefined, [
    generalTerminalTarget?.portalId,
    generalTerminalTarget?.rootId,
    generalTerminalTarget?.title,
  ]);
  const workspaceTerminalSyncTarget = useMemo<TerminalPanelTarget | undefined>(() => terminalTarget ? ({
    kind: 'workspace',
    terminalId: terminalTarget.terminalId,
    projectId: terminalTarget.projectId,
    workspaceId: terminalTarget.workspaceId,
    portalId: terminalTarget.portalId,
    rootId: terminalTarget.rootId,
    repoPath: terminalTarget.repoPath,
    workspacePath: terminalTarget.workspacePath,
    title: terminalTarget.title,
  }) : undefined, [
    terminalTarget?.portalId,
    terminalTarget?.projectId,
    terminalTarget?.repoPath,
    terminalTarget?.rootId,
    terminalTarget?.terminalId,
    terminalTarget?.title,
    terminalTarget?.workspaceId,
    terminalTarget?.workspacePath,
  ]);
  const generalSyncKey = terminalSyncKey(generalTerminalSyncTarget);
  const workspaceSyncKey = terminalSyncKey(workspaceTerminalSyncTarget);
  const isGeneralTerminalSyncing = generalSyncKey ? terminalSyncingTargets.has(generalSyncKey) : false;
  const isWorkspaceTerminalSyncing = workspaceSyncKey ? terminalSyncingTargets.has(workspaceSyncKey) : false;
  const generalTerminalError = generalSyncKey ? terminalSyncErrors[generalSyncKey] : undefined;
  const workspaceTerminalError = workspaceSyncKey ? terminalSyncErrors[workspaceSyncKey] : undefined;
  const handleTerminalTabsChange = useCallback((tabsChange: TerminalPanelTabsChange) => {
    if (!terminalTargetKey) return;
    setTerminalTabs(terminalTargetKey, tabsChange);
  }, [setTerminalTabs, terminalTargetKey]);

  const handleActiveTerminalTabChange = useCallback((tabId: string) => {
    if (!terminalTargetKey) return;
    setActiveTerminalTab(terminalTargetKey, tabId);
  }, [setActiveTerminalTab, terminalTargetKey]);

  const setTerminalTargetSyncing = useCallback((key: string, isSyncing: boolean) => {
    setTerminalSyncingTargets(current => {
      const next = new Set(current);
      if (isSyncing) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const setTerminalTargetError = useCallback((key: string, error?: string) => {
    setTerminalSyncErrors(current => {
      if (current[key] === error) return current;
      return { ...current, [key]: error };
    });
  }, []);

  const beginTerminalSync = useCallback((key: string) => {
    terminalSyncSequenceRef.current += 1;
    const sequence = terminalSyncSequenceRef.current;
    latestTerminalSyncByTargetRef.current.set(key, sequence);
    return sequence;
  }, []);

  const isLatestTerminalSync = useCallback((key: string, sequence: number) =>
    latestTerminalSyncByTargetRef.current.get(key) === sequence, []);

  const applyTerminalWindows = useCallback((target: TerminalPanelTarget, windows: TerminalWindowRecord[]) => {
    if (target.kind === 'general') {
      setGeneralTerminalWindows(windows);
      return;
    }
    setTerminalWindows(target.terminalId, windows);
  }, [setGeneralTerminalWindows, setTerminalWindows]);

  const refreshTerminalWindowMetadata = useCallback((target: TerminalPanelTarget, windows: TerminalWindowRecord[]) => {
    if (target.kind === 'general') {
      refreshGeneralTerminalWindowMetadata(windows);
      return;
    }
    refreshWorkspaceTerminalWindowMetadata(target.terminalId, windows);
  }, [refreshGeneralTerminalWindowMetadata, refreshWorkspaceTerminalWindowMetadata]);

  const refreshTerminalSnapshotWindows = useCallback(async () => {
    if (!terminalTransport || !isDesktopTerminalTransportAvailable()) return;
    try {
      setTerminalSnapshotWindows(await terminalTransport.snapshot());
    } catch {
      // Full snapshots are opportunistic; visible terminal panes surface target-specific errors.
    }
  }, [setTerminalSnapshotWindows, terminalTransport]);

  const listTerminalWindowsForTarget = useCallback(async (target: TerminalPanelTarget) => {
    if (!terminalTransport) throw new Error('Terminal transport is unavailable in this client.');
    const input = terminalTargetInput(target);
    const windows = await terminalTransport.snapshot(input);
    if (isDesktopTerminalTransportAvailable()) setTerminalSnapshotWindows(windows);
    return windows.filter(window => isTerminalWindowForTarget(window, target));
  }, [setTerminalSnapshotWindows, terminalTransport]);

  const refreshTerminalProcessNames = useCallback(async (target: TerminalPanelTarget | undefined) => {
    if (!target) return;
    const key = terminalSyncKey(target);
    if (!key) return;
    const syncSequenceAtStart = latestTerminalSyncByTargetRef.current.get(key);
    try {
      const windows = await listTerminalWindowsForTarget(target);
      if (latestTerminalSyncByTargetRef.current.get(key) !== syncSequenceAtStart) return;
      refreshTerminalWindowMetadata(target, windows);
    } catch {
      // Process-name refresh is opportunistic; visible sync paths surface errors.
    }
  }, [listTerminalWindowsForTarget, refreshTerminalWindowMetadata]);

  const syncTerminalTarget = useCallback(async (
    target: TerminalPanelTarget | undefined,
    options: { ensure?: boolean; preferredActiveTabId?: string; requiredWindow?: TerminalWindowRecord } = {},
  ) => {
    if (!target) return [];
    const key = terminalSyncKey(target);
    if (!key) return [];
    const sequence = beginTerminalSync(key);
    setTerminalTargetSyncing(key, true);
    setTerminalTargetError(key, undefined);
    try {
      if (!terminalTransport) throw new Error('Terminal transport is unavailable in this client.');
      let windows = await listTerminalWindowsForTarget(target);
      if (options.ensure && windows.length === 0) {
        const created = await terminalTransport.create(terminalTargetInput(target));
        windows = await listTerminalWindowsForTarget(target);
        if (!windows.some(window => window.terminalId === created.terminalId)) windows = [created];
      }
      const requiredWindow = options.requiredWindow;
      if (
        requiredWindow
        && isTerminalWindowForTarget(requiredWindow, target)
        && !windows.some(window => window.terminalId === requiredWindow.terminalId)
      ) {
        windows = [...windows, requiredWindow];
      }
      if (!isLatestTerminalSync(key, sequence)) return undefined;
      applyTerminalWindows(target, windows);
      const preferredActiveTabId = options.preferredActiveTabId;
      if (preferredActiveTabId && windows.some(window => window.terminalId === preferredActiveTabId)) {
        if (target.kind === 'general') setActiveGeneralTerminalTabId(preferredActiveTabId);
        else setActiveTerminalTab(target.terminalId, preferredActiveTabId);
      }
      return windows;
    } catch (error) {
      if (isLatestTerminalSync(key, sequence)) {
        setTerminalTargetError(key, error instanceof Error ? error.message : String(error));
        return [];
      }
      return undefined;
    } finally {
      if (isLatestTerminalSync(key, sequence)) setTerminalTargetSyncing(key, false);
    }
  }, [
    applyTerminalWindows,
    beginTerminalSync,
    isLatestTerminalSync,
    listTerminalWindowsForTarget,
    setActiveGeneralTerminalTabId,
    setActiveTerminalTab,
    setTerminalTargetError,
    setTerminalTargetSyncing,
    terminalTransport,
  ]);

  const addTerminalTabForTarget = useCallback(async (target: TerminalPanelTarget | undefined) => {
    if (!target || !terminalTransport) return;
    const key = terminalSyncKey(target);
    const sequence = key ? beginTerminalSync(key) : undefined;
    if (key) {
      setTerminalTargetSyncing(key, true);
      setTerminalTargetError(key, undefined);
    }
    try {
      const created = await terminalTransport.create(terminalTargetInput(target));
      await syncTerminalTarget(target, { preferredActiveTabId: created.terminalId, requiredWindow: created });
    } catch (error) {
      if (key && sequence !== undefined && isLatestTerminalSync(key, sequence)) {
        setTerminalTargetError(key, error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (key && sequence !== undefined && isLatestTerminalSync(key, sequence)) setTerminalTargetSyncing(key, false);
    }
  }, [
    beginTerminalSync,
    isLatestTerminalSync,
    setTerminalTargetError,
    setTerminalTargetSyncing,
    syncTerminalTarget,
    terminalTransport,
  ]);

  const closeTerminalTabForTarget = useCallback(async (
    target: TerminalPanelTarget | undefined,
    tab: TerminalPanelTab,
    onEmpty: () => void,
  ) => {
    if (!target || !terminalTransport) return;
    const key = terminalSyncKey(target);
    if (key) {
      beginTerminalSync(key);
      setTerminalTargetSyncing(key, true);
      setTerminalTargetError(key, undefined);
    }
    try {
      await terminalTransport.close(tab.terminalId);
    } catch {
      // Reconciliation below decides what still exists.
    }
    const windows = await syncTerminalTarget(target);
    if (windows?.length === 0) onEmpty();
  }, [
    beginTerminalSync,
    setTerminalTargetError,
    setTerminalTargetSyncing,
    syncTerminalTarget,
    terminalTransport,
  ]);

  const handleTerminalExitForTarget = useCallback(async (
    target: TerminalPanelTarget | undefined,
    onEmpty: () => void,
  ) => {
    if (!target) return;
    const windows = await syncTerminalTarget(target);
    if (windows?.length === 0) onEmpty();
  }, [syncTerminalTarget]);

  useEffect(() => {
    if (!generalTerminalSyncTarget) return;
    void syncTerminalTarget(generalTerminalSyncTarget, { ensure: isGeneralTerminalOpen });
  }, [generalSyncKey, generalTerminalSyncTarget, isGeneralTerminalOpen, syncTerminalTarget]);

  useEffect(() => {
    if (!workspaceTerminalSyncTarget) return;
    void syncTerminalTarget(workspaceTerminalSyncTarget, { ensure: showTerminalPane });
  }, [showTerminalPane, syncTerminalTarget, workspaceSyncKey, workspaceTerminalSyncTarget]);

  useEffect(() => {
    void refreshTerminalSnapshotWindows();
  }, [refreshTerminalSnapshotWindows]);

  useEffect(() => {
    if (!terminalTransport || !isDesktopTerminalTransportAvailable()) return undefined;
    const interval = window.setInterval(() => {
      void refreshTerminalSnapshotWindows();
    }, terminalSnapshotRefreshMs);
    return () => window.clearInterval(interval);
  }, [refreshTerminalSnapshotWindows, terminalTransport]);

  useEffect(() => {
    if (!terminalTransport || !isDesktopTerminalTransportAvailable()) return undefined;
    return terminalTransport.subscribe(event => {
      if (event.type === 'created' || event.type === 'exit') void refreshTerminalSnapshotWindows();
    });
  }, [refreshTerminalSnapshotWindows, terminalTransport]);

  useEffect(() => {
    if (!generalTerminalSyncTarget || !isGeneralTerminalOpen) return undefined;
    const interval = window.setInterval(() => {
      void refreshTerminalProcessNames(generalTerminalSyncTarget);
    }, terminalProcessRefreshMs);
    return () => window.clearInterval(interval);
  }, [generalSyncKey, generalTerminalSyncTarget, isGeneralTerminalOpen, refreshTerminalProcessNames]);

  useEffect(() => {
    if (!workspaceTerminalSyncTarget || !showTerminalPane) return undefined;
    const interval = window.setInterval(() => {
      void refreshTerminalProcessNames(workspaceTerminalSyncTarget);
    }, terminalProcessRefreshMs);
    return () => window.clearInterval(interval);
  }, [refreshTerminalProcessNames, showTerminalPane, workspaceSyncKey, workspaceTerminalSyncTarget]);
  const { data: serverThreads = [], isFetched } = useQuery({
    queryKey: ['threads', resourceId],
    queryFn: () => listServerThreads(),
  });

  useEffect(() => {
    if (serverThreads.length > 0) {
      setServerThreads(serverThreads);
      return;
    }

    if (isFetched && serverThreads.length === 0 && threads.length === 0) void newThread();
  }, [isFetched, newThread, serverThreads, setServerThreads, threads.length]);

  const focusSidebar = useCallback(() => {
    window.requestAnimationFrame(() => {
      const sidebar = sidebarSurfaceRef.current;
      const firstControl = sidebar?.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
      (firstControl ?? sidebar)?.focus();
    });
  }, []);

  const focusChat = useCallback(() => {
    if (hasChatPaneTarget) openPane('chat');
    window.requestAnimationFrame(() => {
      chatSurfaceRef.current
        ?.querySelector<HTMLTextAreaElement>('[data-weave-active-thread="true"] textarea:not([disabled])')
        ?.focus();
    });
  }, [hasChatPaneTarget, openPane]);

  const createThreadFromShortcut = useCallback(() => {
    const projectId = activeSurface.kind === 'workspace' ? activeSurface.projectId : activeThread?.projectId;
    const workspaceId = activeSurface.kind === 'workspace' ? activeSurface.workspaceId : activeThread?.workspaceId;
    void newThread(projectId, workspaceId)
      .then(() => queryClient.invalidateQueries({ queryKey: ['threads', resourceId] }))
      .then(() => focusChat());
  }, [activeSurface, activeThread?.projectId, activeThread?.workspaceId, focusChat, newThread, queryClient, resourceId]);
  const handleGeneralTerminalToggle = useCallback(() => {
    const shouldFocusAfterOpen = !isGeneralTerminalOpen;
    toggleGeneralTerminal();
    if (shouldFocusAfterOpen) window.requestAnimationFrame(focusGeneralTerminal);
  }, [focusGeneralTerminal, isGeneralTerminalOpen, toggleGeneralTerminal]);

  const handleChatPaneToggle = useCallback(() => {
    if (!hasChatPaneTarget) return;
    const shouldFocusAfterOpen = !showChatPane;
    togglePane('chat');
    if (shouldFocusAfterOpen) window.requestAnimationFrame(focusChat);
  }, [focusChat, hasChatPaneTarget, showChatPane, togglePane]);

  const handleEditorPaneToggle = useCallback(() => {
    if (!hasEditorPaneTarget) return;
    const shouldFocusAfterOpen = !showEditorPane;
    togglePane('editor');
    if (shouldFocusAfterOpen) window.requestAnimationFrame(focusEditor);
  }, [focusEditor, hasEditorPaneTarget, showEditorPane, togglePane]);

  const handleTerminalPaneToggle = useCallback(() => {
    if (!hasTerminalPaneTarget) return;
    const shouldFocusAfterOpen = !showTerminalPane;
    togglePane('terminal');
    if (shouldFocusAfterOpen) window.requestAnimationFrame(focusTerminal);
  }, [focusTerminal, hasTerminalPaneTarget, showTerminalPane, togglePane]);

  const handleMainPaneMaximizeToggle = useCallback((pane: MainPane) => {
    if (pane === 'chat' && !hasChatPaneTarget) return;
    if (pane === 'editor' && !hasEditorPaneTarget) return;
    if (pane === 'terminal' && !hasTerminalPaneTarget) return;
    toggleMaximizedPane(pane);
    if (pane === 'chat') window.requestAnimationFrame(focusChat);
    else if (pane === 'editor') window.requestAnimationFrame(focusEditor);
    else window.requestAnimationFrame(focusTerminal);
  }, [focusChat, focusEditor, focusTerminal, hasChatPaneTarget, hasEditorPaneTarget, hasTerminalPaneTarget, toggleMaximizedPane]);

  const shortcutCommands = useAppShortcuts({
    createThreadFromShortcut,
    focusChat,
    focusSidebar,
    focusTerminal,
    handleChatPaneToggle,
    handleEditorPaneToggle,
    handleGeneralTerminalToggle,
    handleMainPaneMaximizeToggle,
    handleTerminalPaneToggle,
    hasChatPaneTarget,
    hasEditorTarget,
    hasGeneralTerminalTarget,
    hasTerminalTarget,
    isSidebarOpen,
    setShowPlanPanel,
    showPlanPanel,
    showSidebarPreview,
    toggleSidebar,
  });
  useEffect(() => {
    if (activeSurface.kind !== 'workspace' || !sideEditorTargetKey || !showEditorPane) return;
    focusEditor();
  }, [activeSurface, focusEditor, showEditorPane, sideEditorTargetKey]);

  useEffect(() => {
    if (hasTerminalPaneTarget || !paneVisibility.terminalOpen) return;
    closePane('terminal');
  }, [closePane, hasTerminalPaneTarget, paneVisibility.terminalOpen]);
  const isSidebarSurfaceVisible = isSidebarOpen || showSidebarPreview;
  const hasFloatingLeftAction = showHeaderSidebarToggle || showPinnedSidebarToggle || Boolean(generalTerminalTarget) || hasWindowStreamPortal;
  const hasHeaderLeftAction = showHeaderSidebarToggle || Boolean(generalTerminalTarget) || hasWindowStreamPortal;
  const shouldRenderFloatingLeftActions = (isElectronWindow || isSidebarSurfaceVisible)
    && hasFloatingLeftAction;
  const shouldRenderHeaderLeftActions = !isElectronWindow
    && !isSidebarSurfaceVisible
    && hasHeaderLeftAction;
  const sidebarToggleHoverHandlers = isPortraitViewport
    ? {}
    : {
        onMouseEnter: openSidebarPreview,
        onMouseLeave: scheduleSidebarPreviewClose,
      };
  const floatingLeftActionHoverHandlers = showSidebarPreview && !isPortraitViewport
    ? {
        onMouseEnter: openSidebarPreview,
        onMouseLeave: scheduleSidebarPreviewClose,
      }
    : {};
  const renderSidebarToggleButton = () => (
    <Button
      size="icon"
      variant="ghost"
      aria-label={isSidebarOpen || (isPortraitViewport && showSidebarPreview) ? 'Hide sidebar' : 'Show sidebar'}
      onClick={toggleSidebar}
      {...sidebarToggleHoverHandlers}
    >
      <PanelLeft size={18} />
    </Button>
  );
  const renderGeneralTerminalButton = () => generalTerminalTarget ? (
    <Button
      className={[
        isGeneralTerminalOpen ? 'bg-accent' : '',
        isGeneralTerminalActive ? 'text-peach' : '',
      ].filter(Boolean).join(' ')}
      size="icon"
      variant="ghost"
      aria-label={isGeneralTerminalOpen ? 'Hide general terminal' : 'Show general terminal'}
      data-active={isGeneralTerminalOpen ? 'true' : 'false'}
      onClick={handleGeneralTerminalToggle}
    >
      <TerminalSquare size={18} />
      <TerminalTabCountBadge count={generalTerminalTabs.length} />
    </Button>
  ) : null;
  const renderWindowStreamButton = () => hasWindowStreamPortal ? (
    <Button
      className={[
        isWindowStreamOpen ? 'bg-accent' : '',
        isWindowStreamActive ? 'text-mauve' : '',
      ].filter(Boolean).join(' ')}
      size="icon"
      variant="ghost"
      aria-label={isWindowStreamOpen ? 'Hide window stream' : 'Show window stream'}
      data-active={isWindowStreamOpen || isWindowStreamActive ? 'true' : 'false'}
      onClick={() => setWindowStreamOpen(!isWindowStreamOpen)}
    >
      <MonitorUp size={18} />
    </Button>
  ) : null;

  const renderTerminalPanel = (variant: 'pane' | 'main') => showTerminalPane ? (
    <TerminalPaneHost
      activeTabId={activeTerminalTabId}
      canToggleMaximized={canToggleTerminalMaximized}
      error={workspaceTerminalError}
      focusRequest={terminalFocusRequest}
      isSyncing={isWorkspaceTerminalSyncing}
      isEffectivelyMaximized={isTerminalEffectivelyMaximized}
      onActiveTabIdChange={handleActiveTerminalTabChange}
      onAddTab={() => void addTerminalTabForTarget(workspaceTerminalSyncTarget)}
      onCloseTab={tab => void closeTerminalTabForTarget(workspaceTerminalSyncTarget, tab, () => closePane('terminal'))}
      onExit={() => void handleTerminalExitForTarget(workspaceTerminalSyncTarget, () => closePane('terminal'))}
      onHide={() => closePane('terminal')}
      onMaximizeToggle={() => handleMainPaneMaximizeToggle('terminal')}
      onRestoreMaximized={restoreMaximizedPane}
      onSessionActiveChange={handleTerminalSessionActiveChange}
      onTabsChange={handleTerminalTabsChange}
      tabs={terminalTabs}
      target={terminalTarget}
      transport={terminalTransport}
      variant={variant}
    />
  ) : null;

  const renderChatPane = () => showChatPane ? (
    <ChatPane
      activePlan={activePlan}
      activeThreadId={activeThreadId}
      isMaximized={isChatMaximized}
      runningThreadIds={runningThreadIds}
      showPlanPanel={showPlanPanel}
      surfaceRef={chatSurfaceRef}
      terminalSlot={showTerminalInChatPane ? renderTerminalPanel('pane') : undefined}
      threads={threads}
      canFollowWrites={canFollowWrites}
      onClose={() => closePane('chat')}
      onMaximizeToggle={() => handleMainPaneMaximizeToggle('chat')}
    />
  ) : null;

  const renderTerminalPane = () => showStandaloneTerminalPane ? (
    <div
      key="terminal"
      className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden"
      data-weave-main-pane="terminal"
      data-maximized={isTerminalEffectivelyMaximized ? 'true' : 'false'}
    >
      {renderTerminalPanel('main')}
    </div>
  ) : null;

  const renderEditorPane = () => showEditorPane && (editorTarget || notesTarget) ? (
    <EditorPane
      followRequest={editorFollowRequest}
      focusRequest={editorFocusRequest}
      isMaximized={isEditorMaximized}
      mode={notesTarget ? 'notes' : 'code'}
      target={(notesTarget ?? editorTarget)!}
      terminalSlot={showTerminalInEditorPane ? renderTerminalPanel('pane') : undefined}
      onClose={() => closePane('editor')}
      onExpandedChange={nextExpanded => {
        if (nextExpanded) handleMainPaneMaximizeToggle('editor');
        else restoreMaximizedPane();
      }}
    />
  ) : null;

  const orderedMainPanes = [renderChatPane(), renderEditorPane(), renderTerminalPane()];
  const headerLeftActions = shouldRenderHeaderLeftActions ? (
    <>
      {showHeaderSidebarToggle ? renderSidebarToggleButton() : null}
      {renderGeneralTerminalButton()}
      {renderWindowStreamButton()}
    </>
  ) : undefined;
  const headerRightActions = (
    <>
      {hasChatPaneTarget ? (
        <Button
          className={showChatPane ? 'bg-accent' : ''}
          size="icon"
          variant="ghost"
          aria-label={showChatPane ? 'Hide chat' : 'Show chat'}
          data-active={showChatPane ? 'true' : 'false'}
          onClick={handleChatPaneToggle}
        >
          <MessageSquare size={18} />
        </Button>
      ) : null}
      {terminalTarget ? (
        <Button
          className={[
            showTerminalPane ? 'bg-accent' : '',
            hasActiveTerminal ? 'text-peach' : '',
          ].filter(Boolean).join(' ')}
          size="icon"
          variant="ghost"
          aria-label={showTerminalPane ? 'Hide terminal' : 'Show terminal'}
          data-active={showTerminalPane ? 'true' : 'false'}
          onClick={handleTerminalPaneToggle}
        >
          <TerminalSquare size={18} />
          <TerminalTabCountBadge count={terminalTabs.length} />
        </Button>
      ) : null}
      {editorTarget || notesTarget ? (
        <Button
          className={showEditorPane ? 'bg-accent' : ''}
          size="icon"
          variant="ghost"
          aria-label={notesTarget ? (showEditorPane ? 'Hide notes' : 'Show notes') : (showEditorPane ? 'Hide editor' : 'Show editor')}
          data-active={showEditorPane ? 'true' : 'false'}
          onClick={handleEditorPaneToggle}
        >
          {notesTarget ? <StickyNote size={18} /> : <Code2 size={18} />}
        </Button>
      ) : null}
    </>
  );
  const emptyMainPaneState = (
    <div className="grid min-h-0 min-w-0 flex-1 place-items-center bg-background text-xs text-muted-foreground">
      <div className="flex flex-col items-center gap-3">
        <div>No pane is open</div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {hasChatPaneTarget ? (
            <Button size="sm" variant="outline" onClick={() => openPane('chat')}>
              <MessageSquare size={14} />
              Open Chat
            </Button>
          ) : null}
          {hasTerminalPaneTarget ? (
            <Button size="sm" variant="outline" onClick={() => {
              openPane('terminal');
              window.requestAnimationFrame(focusTerminal);
            }}>
              <TerminalSquare size={14} />
              Open Terminal
            </Button>
          ) : null}
          {hasEditorPaneTarget ? (
            <Button size="sm" variant="outline" onClick={() => {
              openPane('editor');
              window.requestAnimationFrame(focusEditor);
            }}>
              {notesTarget ? <StickyNote size={14} /> : <Code2 size={14} />}
              Open Editor
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );

	  return (
	    <ShortcutProvider commands={shortcutCommands}>
	      <div ref={pageRef} className="weave-app-shell box-border flex overflow-hidden pt-[var(--weave-safe-area-top)]" data-weave-surface="app">
	      <span
	        ref={editorMinimumMeasureRef}
	        className="pointer-events-none fixed -left-[9999px] -top-[9999px] font-mono text-sm opacity-0"
	        aria-hidden="true"
	      >
	        {editorColumnMeasureText}
	      </span>
	      <AppSidebarHost
        closeOnPinnedSelect={isPortraitViewport}
        connectionSettingsButton={connectionSettingsButton}
        isPortraitViewport={isPortraitViewport}
        isSidebarOpen={isSidebarOpen}
        showSidebarPreview={showSidebarPreview}
        sidebarRef={sidebarSurfaceRef}
        onCloseSidebar={closeSidebar}
        onCloseSidebarPreview={closeSidebarPreview}
        onOpenSidebarPreview={openSidebarPreview}
        onScheduleSidebarPreviewClose={scheduleSidebarPreviewClose}
      />
      {shouldRenderFloatingLeftActions ? (
        <div
          className="weave-appbar-left-actions-floating flex items-center"
          data-has-sidebar-toggle={showHeaderSidebarToggle || showPinnedSidebarToggle ? 'true' : 'false'}
          {...floatingLeftActionHoverHandlers}
        >
          {showHeaderSidebarToggle || showPinnedSidebarToggle ? renderSidebarToggleButton() : null}
          {renderGeneralTerminalButton()}
          {renderWindowStreamButton()}
        </div>
      ) : null}
      <WorkspaceMainContent
        emptyState={emptyMainPaneState}
        isEmpty={!showChatPane && !showEditorPane && !showTerminalPane}
        isSidebarAutoHidden={isSidebarAutoHidden}
        isSidebarOpen={isSidebarOpen}
        isSidebarPinnedOpen={isSidebarPinnedOpen}
        leftActions={headerLeftActions}
        panes={orderedMainPanes}
        projectName={activeProject?.name}
        rightActions={headerRightActions}
        showSidebarPreview={showSidebarPreview}
        threadTitle={hasThreadTitle ? activeThread?.title : undefined}
        workspaceName={activeWorkspace?.name}
      />
      <GlobalTerminalOverlay
        activeTabId={activeGeneralTerminalTabId}
        error={generalTerminalError}
        focusRequest={generalTerminalFocusRequest}
        isOpen={isGeneralTerminalOpen}
        isSyncing={isGeneralTerminalSyncing}
        onActiveTabIdChange={setActiveGeneralTerminalTabId}
        onAddTab={() => void addTerminalTabForTarget(generalTerminalSyncTarget)}
        onCloseTab={tab => void closeTerminalTabForTarget(generalTerminalSyncTarget, tab, hideGeneralTerminal)}
        onExit={() => void handleTerminalExitForTarget(generalTerminalSyncTarget, hideGeneralTerminal)}
        onHide={hideGeneralTerminal}
        onSessionActiveChange={handleGeneralTerminalSessionActiveChange}
        onTabsChange={setGeneralTerminalTabs}
        tabs={generalTerminalTabs}
        target={generalTerminalTarget}
        transport={terminalTransport}
      />
      <WindowStreamOverlayHost
        isActive={isWindowStreamActive}
        isOpen={isWindowStreamOpen}
        portals={onlinePortals}
        onHide={() => setWindowStreamOpen(false)}
        onSessionActiveChange={setWindowStreamActive}
      />
    </div>
    </ShortcutProvider>
  );
};
