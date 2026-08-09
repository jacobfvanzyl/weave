import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Code2, MessageSquare, PanelLeft, StickyNote, TerminalSquare } from 'lucide-react';
import { listServerThreads } from '../../lib/chat-state-api';
import {
  type ClientAppDefinition,
  type ClientAppInputId,
  getClientAppDefinition,
  getClientAppNavigationProducts,
  getClientAppProductLabel,
  isProductAllowedForClientApp,
  sanitizeProductForClientApp,
} from '../../lib/client-app';
import { productForProjectKind, type ProductId, projectBelongsToProduct } from '../../lib/products';
import {
  editorLineHorizontalPaddingPx,
  getTwoColumnPaneLayout,
  mainPaneDividerWidthPx,
} from '../../lib/editor-layout';
import { proposalWorkflowEnabled } from '../../lib/proposal-workflow';
import { canViewProposalReview } from '../../lib/proposal-review-state';
import { createTerminalTransport, isDesktopTerminalTransportAvailable } from '../../lib/terminal-transport';
import { workspaceRefKey } from '../../lib/thread-eligibility';
import { type ChatThread, useChatStore } from '../../stores/chat-store';
import { useAppShellStore } from '../../stores/app-shell-store';
import { useClientSessionViewStore } from '../../stores/client-session-view-store';
import { defaultEditorExplorerVisible, getEditorTabTargetKey, useEditorTabStore } from '../../stores/editor-tab-store';
import { useProductStore } from '../../stores/product-store';
import { generalTerminalId, useTerminalStore } from '../../stores/terminal-store';
import { defaultTerminalPaneColumn,
  type MainPane, useWorkspaceSurfaceStore, } from '../../stores/workspace-surface-store';
import { Button } from '../ui/button';
import { ShortcutProvider } from '../shortcuts';
import { AppSidebarHost } from './AppSidebarHost';
import { useAppShortcuts } from './useAppShortcuts';
import { useShellLayout } from './useShellLayout';
import { ChatPaneHost, LegacyUnscopedChatPane } from '../chat/ChatPane';
import { ClientToolHost } from './ClientToolHost';
import { EditorPaneHost } from '../editor/EditorPane';
import { ProposalReviewPane } from '../proposals/ProposalReviewPane';
import { GlobalTerminalOverlay } from '../terminal/GlobalTerminalOverlay';
import { TerminalPaneHost } from '../terminal/TerminalPaneHost';
import type { TerminalPanelTab, TerminalPanelTabsChange, TerminalPanelTarget } from '../terminal/TerminalPanel';
import { createTerminalLayoutSyncKey } from '../terminal/terminal-resize-sync';
import type { TerminalTargetInput, TerminalTransport, TerminalWindowRecord } from '../../lib/terminal-types';
import { NotificationHost } from '../notifications/NotificationHost';
import { PaneContentHost, type PaneContentType, type PaneHostIdentity } from '../panes/PaneContentHost';
import { ContextBreadcrumb } from '../workspace/ContextBreadcrumb';
import { WorkspaceMainContent } from '../workspace/WorkspaceMainContent';
import {
  chatPaneMinimumWidthPx,
  editorColumnMeasureText,
  threadSidebarWidthPx,
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
const emptyServerThreads: ChatThread[] = [];

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

const terminalTargetInputForTab = (target: TerminalPanelTarget, tab: TerminalPanelTab): TerminalTargetInput => ({
  ...terminalTargetInput(target),
  terminalId: tab.terminalId,
  portalId: tab.portalId ?? target.portalId,
  rootId: tab.rootId ?? target.rootId,
  projectId: tab.projectId ?? target.projectId,
  workspaceId: tab.workspaceId ?? target.workspaceId,
  cwd: tab.cwd ?? target.cwd,
});

const isTerminalWindowForTarget = (window: TerminalWindowRecord, target: TerminalPanelTarget) => {
  if (window.kind !== target.kind) return false;
  if (target.kind === 'workspace') {
    return window.projectId === target.projectId && window.workspaceId === target.workspaceId;
  }

  if (target.portalId && window.portalId && window.portalId !== target.portalId) return false;
  if (target.rootId && window.rootId && window.rootId !== target.rootId) { return false;
  }
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
  adoptedLocalPortalId?: string;
  clientApp?: ClientAppInputId | ClientAppDefinition;
  connectionSettingsButton?: ReactNode;
};

export const WeaveAppShell = ({ adoptedLocalPortalId, clientApp: clientAppInput, connectionSettingsButton }: WeaveAppShellProps = {}) => {
  const clientApp = useMemo(() => getClientAppDefinition(clientAppInput), [clientAppInput]);
  const resourceId = useChatStore((state) => state.resourceId);
  const threadId = useWorkspaceSurfaceStore((state) => state.threadId);
  const activeSurface = useWorkspaceSurfaceStore((state) => state.activeSurface);
  const selectWorkspaceSurface = useWorkspaceSurfaceStore((state) => state.selectWorkspace);
  const threads = useChatStore((state) => state.threads);
  const runningThreadIds = useChatStore((state) => state.runningThreadIds);
  const setServerThreads = useChatStore((state) => state.setServerThreads);
  const reconcileEditorTargets = useEditorTabStore((state) => state.reconcileTargets);
  const reconcileTerminalTargets = useTerminalStore((state) => state.reconcileWorkspaceTargets);
  const reconcileSessionProjects = useClientSessionViewStore((state) => state.reconcileProjects);
  const newThread = useChatStore((state) => state.newThread);
  const selectThreadSurface = useChatStore((state) => state.selectThread);
  const paneVisibility = useWorkspaceSurfaceStore((state) => state.paneVisibility);
  const maximizedPane = useWorkspaceSurfaceStore((state) => state.maximizedPane);
  const editorFollowRequest = useWorkspaceSurfaceStore((state) => state.editorFollowRequest);
  const editorSlotMode = useWorkspaceSurfaceStore((state) => state.editorSlotMode);
  const activeProposalPath = useWorkspaceSurfaceStore((state) => state.activeProposalPath);
  const activeProposalFilePath = useWorkspaceSurfaceStore((state) => state.activeProposalFilePath);
  const openPane = useWorkspaceSurfaceStore((state) => state.openPane);
  const openProposalReview = useWorkspaceSurfaceStore((state) => state.openProposalReview);
  const closePane = useWorkspaceSurfaceStore((state) => state.closePane);
  const closeProposalReview = useWorkspaceSurfaceStore((state) => state.closeProposalReview);
  const requestEditorFollow = useWorkspaceSurfaceStore((state) => state.requestEditorFollow);
  const togglePane = useWorkspaceSurfaceStore((state) => state.togglePane);
  const toggleMaximizedPane = useWorkspaceSurfaceStore((state) => state.toggleMaximizedPane);
  const restoreMaximizedPane = useWorkspaceSurfaceStore((state) => state.restoreMaximizedPane);
  const terminalPaneColumnsByWorkspace = useWorkspaceSurfaceStore((state) => state.terminalPaneColumnsByWorkspace);
  const toggleTerminalPaneColumn = useWorkspaceSurfaceStore((state) => state.toggleTerminalPaneColumn);
  const queryClient = useQueryClient();
  const storedActiveProduct = useProductStore((state) => state.activeProduct);
  const setActiveProduct = useProductStore((state) => state.setActiveProduct);
  const activeProduct = sanitizeProductForClientApp(storedActiveProduct, clientApp);
  const { editorMinimumMeasureRef, editorMinimumWidthPx, pageRef, pageWidth } = useMainPaneMetrics();
  const sidebarSurfaceRef = useRef<HTMLElement | null>(null);
  const legacyPaneIdsRef = useRef(new Map<string, string>());
  const [chatFocusRequest, setChatFocusRequest] = useState(0);
  const getLegacyPaneIdentity = (paneType: PaneContentType, workspaceId: string): PaneHostIdentity => {
    const key = `${workspaceId}:${paneType}`;
    let paneId = legacyPaneIdsRef.current.get(key);
    if (!paneId) {
      paneId = `legacy-pane:${paneType}:${globalThis.crypto.randomUUID()}`;
      legacyPaneIdsRef.current.set(key, paneId);
    }
    return { paneId, workspaceId };
  };
  const isPortraitViewport = useIsPortraitViewport();
  const isElectronWindow = isElectronWindowNow();
  const workspaceTargets = useWorkspaceTargets({
    activeSurface,
    isElectronWindow,
    resourceId,
    threadId,
    threads,
  });
  const {
    activeThread,
    activeThreadId,
    hasChatPaneTarget: hasWorkspaceChatPaneTarget,
    hasThreadTitle,
    projects,
    projectsQuery,
  } = workspaceTargets;
  const hasInitializedThreads = useChatStore((state) => state.hasInitializedThreads);
  const activeThreadProposal = useChatStore((state) => state.threadProposals[activeThreadId]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const productForProjectId = useCallback((projectId: string): ProductId | undefined => {
    const project = projectById.get(projectId);
    return project ? productForProjectKind(project.projectKind) : undefined;
  }, [projectById],);
  const productForThread = useCallback((thread: ChatThread | undefined): ProductId | undefined => {
    if (!thread) return undefined;
    if (!thread.projectId || thread.adHoc) return 'chat';
    return productForProjectId(thread.projectId);
  }, [productForProjectId],);
  const activeSurfaceProduct = activeSurface.kind === 'workspace'
    ? productForProjectId(activeSurface.projectId)
    : productForThread(activeThread);
  const hasLoadedSurfaceContext = hasInitializedThreads && projectsQuery.isSuccess;
  const isActiveSurfaceSupported = activeSurfaceProduct
    ? isProductAllowedForClientApp(activeSurfaceProduct, clientApp)
    : !hasLoadedSurfaceContext;
  const activeProjectProduct = workspaceTargets.activeProject
    ? productForProjectKind(workspaceTargets.activeProject.projectKind)
    : undefined;
  const hasChatPaneTarget = isActiveSurfaceSupported && hasWorkspaceChatPaneTarget;
  const activeProject = isActiveSurfaceSupported
    && workspaceTargets.activeProject
    && activeProjectProduct
    && isProductAllowedForClientApp(activeProjectProduct, clientApp)
    ? workspaceTargets.activeProject
    : undefined;
  const activeWorkspace = activeProject ? workspaceTargets.activeWorkspace : undefined;
  const hasCodeSurfaceContext = isActiveSurfaceSupported && activeSurfaceProduct === 'code';
  const editorTarget = hasCodeSurfaceContext ? workspaceTargets.editorTarget : undefined;
  const notesTarget = isActiveSurfaceSupported && activeSurfaceProduct === 'notes' ? workspaceTargets.notesTarget : undefined;
  const isNotesSurface = activeSurfaceProduct === 'notes';
  const rawGeneralTerminalTarget = workspaceTargets.generalTerminalTarget;
  const generalTerminalTarget = useMemo(() => rawGeneralTerminalTarget ?{
    ...rawGeneralTerminalTarget,
    title: `${clientApp.displayName} Terminal`,
  } : undefined, [clientApp.displayName, rawGeneralTerminalTarget],);
  const terminalTarget = hasCodeSurfaceContext ? workspaceTargets.terminalTarget : undefined;
  const showGlobalTerminalButton = true;
  const activeSurfaceKey = activeSurface.kind === 'thread'
    ? `thread:${activeSurface.threadId}`
    : `workspace:${activeSurface.projectId}:${activeSurface.workspaceId}`;
  const currentProposalReviewKey = proposalWorkflowEnabled && activeProposalPath ? `${activeSurfaceKey}:proposal:${activeProposalPath}` : undefined;
  const [validatedProposalReviewKey, setValidatedProposalReviewKey] = useState<string | undefined>();
  const canAutoShowActiveProposalReview = Boolean(
    proposalWorkflowEnabled
      && activeSurface.kind === 'thread'
      && activeThreadProposal?.path === activeProposalPath
      && canViewProposalReview(activeThreadProposal),
  );
  const canBackToActiveProposalReview = Boolean(
    proposalWorkflowEnabled
      && editorSlotMode === 'editor'
      && activeProposalPath
      && activeThreadProposal?.path === activeProposalPath
      && canViewProposalReview(activeThreadProposal),
  );
  const showChatPane = hasChatPaneTarget && paneVisibility.chatOpen;
  const isChatMaximized = maximizedPane === 'chat';
  const hasEditorPaneTarget = Boolean(
    hasCodeSurfaceContext ? workspaceTargets.activeGitWorkspaceTarget : workspaceTargets.activeNotesWorkspaceTarget,);
  const showEditorPane = hasEditorPaneTarget && paneVisibility.editorOpen;
  const isEditorMaximized = maximizedPane === 'editor';
  const hasWorkspaceTerminalContext = Boolean(
    hasCodeSurfaceContext && workspaceTargets.activeProjectId && workspaceTargets.activeWorkspaceId,);
  const hasTerminalPaneTarget = hasWorkspaceTerminalContext;
  const showTerminalPane = hasTerminalPaneTarget && paneVisibility.terminalOpen;
  const isTerminalMaximized = maximizedPane === 'terminal';
  const isTerminalOnlyPane = showTerminalPane && !showChatPane && !showEditorPane;
  const isTerminalEffectivelyMaximized = isTerminalMaximized || isTerminalOnlyPane;
  const canToggleTerminalMaximized = isTerminalMaximized || showChatPane || showEditorPane;
  const terminalWorkspaceRef =
    workspaceTargets.activeProjectId && workspaceTargets.activeWorkspaceId ? workspaceRefKey(workspaceTargets.activeProjectId, workspaceTargets.activeWorkspaceId) : undefined;
  const terminalPaneColumn = terminalWorkspaceRef
    ? ( terminalPaneColumnsByWorkspace[terminalWorkspaceRef] ?? defaultTerminalPaneColumn)
    : defaultTerminalPaneColumn;
  const canToggleTerminalPaneColumn = Boolean(showTerminalPane && showChatPane && showEditorPane && terminalTarget);
  const sideEditorMode = activeSurfaceProduct === 'notes' ? 'notes' : activeSurfaceProduct === 'code' ? 'code' : undefined;
  const sideEditorTargetKey = sideEditorMode && workspaceTargets.activeProjectId && workspaceTargets.activeWorkspaceId
    ? getEditorTabTargetKey(sideEditorMode, workspaceTargets.activeProjectId, workspaceTargets.activeWorkspaceId)
    : undefined;
  const isEditorExplorerPinned = useEditorTabStore((state) => {
    if (!sideEditorTargetKey || editorSlotMode !== 'editor') return false;
    const tabSet = state.editorTabsByTarget[sideEditorTargetKey];
    const activeEditorTab = tabSet?.tabs.find((tab) => tab.id === tabSet.activeTabId) ?? tabSet?.tabs[0];
    return (state.explorerVisibleByTarget[sideEditorTargetKey] ?? defaultEditorExplorerVisible) || !activeEditorTab;
  });
  const visibleMainPaneMinimumWidthPx = (showChatPane ? chatPaneMinimumWidthPx : 0)
    + (showEditorPane ? editorMinimumWidthPx : 0)
    + (showChatPane && showEditorPane ? mainPaneDividerWidthPx : 0)
    + (showTerminalPane && !showChatPane && !showEditorPane ? editorMinimumWidthPx : 0);
  const terminalHost = showTerminalPane
    ? showChatPane && showEditorPane
      ? terminalPaneColumn === 'right' ? 'editor' : 'chat'
      : showEditorPane
        ? 'editor'
        : showChatPane
          ? 'chat'
          : 'standalone'
    : null;
  const showTerminalInChatPane = terminalHost === 'chat';
  const showTerminalInEditorPane = terminalHost === 'editor';
  const showStandaloneTerminalPane = terminalHost === 'standalone';
  const terminalLayoutSyncKey = createTerminalLayoutSyncKey({
    isTerminalEffectivelyMaximized,
    showChatPane,
    showEditorPane,
    showTerminalPane,
    target: terminalTarget,
    terminalHost,
    terminalPaneColumn,
  });
  const breadcrumbPane = showChatPane ? 'chat' : showEditorPane ? 'editor' : showStandaloneTerminalPane ? 'terminal' : undefined;
  const contextBreadcrumb = activeProject?.name || (hasThreadTitle && activeThread?.title) ? (
    <ContextBreadcrumb
      projectName={activeProject?.name}
      threadTitle={hasThreadTitle ? activeThread?.title : undefined}
      workspaceName={activeWorkspace?.name}
    />
  ) : undefined;
  const editorBreadcrumb = activeProject?.name ? (
    <ContextBreadcrumb projectName={activeProject.name} workspaceName={activeWorkspace?.name} />
  ) : undefined;
  const appBarBreadcrumb = breadcrumbPane === 'chat'
    ? contextBreadcrumb
    : breadcrumbPane === 'editor'
      ? editorBreadcrumb
      : undefined;
  const terminalWorkspaceId = workspaceTargets.activeWorkspaceId;
  const terminalTargetKey = terminalTarget?.terminalId ?? terminalWorkspaceId;
  const terminalTransport = useMemo<TerminalTransport | undefined>(() => createTerminalTransport(), []);
  const [terminalSyncingTargets, setTerminalSyncingTargets] = useState<Set<string>>(() => new Set());
  const [terminalSyncErrors, setTerminalSyncErrors] = useState<Record<string, string | undefined>>({});
  const terminalSyncSequenceRef = useRef(0);
  const latestTerminalSyncByTargetRef = useRef<Map<string, number>>(new Map());
  const generalTerminalTabs = useTerminalStore((state) => state.generalTerminalTabs);
  const setGeneralTerminalTabs = useTerminalStore((state) => state.setGeneralTerminalTabs);
  const setGeneralTerminalWindows = useTerminalStore((state) => state.setGeneralTerminalWindows);
  const refreshGeneralTerminalWindowMetadata = useTerminalStore((state) => state.refreshGeneralTerminalWindowMetadata);
  const activeGeneralTerminalTabId = useTerminalStore((state) => state.activeGeneralTerminalTabId);
  const setActiveGeneralTerminalTabId = useTerminalStore((state) => state.setActiveGeneralTerminalTabId);
  const terminalTabsByTarget = useTerminalStore((state) => state.terminalTabsByTarget);
  const setTerminalTabs = useTerminalStore((state) => state.setTerminalTabs);
  const setTerminalWindows = useTerminalStore((state) => state.setTerminalWindows);
  const refreshWorkspaceTerminalWindowMetadata = useTerminalStore((state) => state.refreshTerminalWindowMetadata);
  const setTerminalSnapshotWindows = useTerminalStore((state) => state.setTerminalSnapshotWindows);
  const activeTerminalTabByTarget = useTerminalStore((state) => state.activeTerminalTabByTarget);
  const setActiveTerminalTab = useTerminalStore((state) => state.setActiveTerminalTab);
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
  const mainPaneAvailableWidthPx = Math.max(
    0,
    pageWidth - (isSidebarOpen ? threadSidebarWidthPx : 0),
  );
  const twoColumnPaneLayout = showChatPane && showEditorPane
    ? getTwoColumnPaneLayout({
      availableWidthPx: mainPaneAvailableWidthPx,
      chatMinimumWidthPx: chatPaneMinimumWidthPx,
      editorMinimumWidthPx,
      isExplorerPinned: isEditorExplorerPinned,
    })
    : undefined;
  const forceExplorerHoverOnly = twoColumnPaneLayout?.shouldForceExplorerHoverOnly ?? false;
  const terminalTabs = terminalTargetKey ? ( terminalTabsByTarget[terminalTargetKey] ?? []) : [];
  const activeTerminalTabId = terminalTargetKey
    ? ( activeTerminalTabByTarget[terminalTargetKey] ?? terminalTabs[0]?.id)
    : undefined;
  const generalTerminalSyncTarget = useMemo<TerminalPanelTarget | undefined>(() => generalTerminalTarget ?{
    kind: 'general',
    terminalId: generalTerminalId,
    portalId: generalTerminalTarget.portalId,
    rootId: generalTerminalTarget.rootId,
    title: generalTerminalTarget.title,
  } : undefined, [
    generalTerminalTarget?.portalId,
    generalTerminalTarget?.rootId,
    generalTerminalTarget?.title],);
  const workspaceTerminalSyncTarget = useMemo<TerminalPanelTarget | undefined>(() => terminalTarget ?{
    kind: 'workspace',
    terminalId: terminalTarget.terminalId,
    projectId: terminalTarget.projectId,
    workspaceId: terminalTarget.workspaceId,
    portalId: terminalTarget.portalId,
    rootId: terminalTarget.rootId,
    repoPath: terminalTarget.repoPath,
    workspacePath: terminalTarget.workspacePath,
    title: terminalTarget.title,
  } : undefined, [
    terminalTarget?.portalId,
    terminalTarget?.projectId,
    terminalTarget?.repoPath,
    terminalTarget?.rootId,
    terminalTarget?.terminalId,
    terminalTarget?.title,
    terminalTarget?.workspaceId,
    terminalTarget?.workspacePath,
  ],);
  const generalSyncKey = terminalSyncKey(generalTerminalSyncTarget);
  const workspaceSyncKey = terminalSyncKey(workspaceTerminalSyncTarget);
  const isGeneralTerminalSyncing = generalSyncKey ? terminalSyncingTargets.has(generalSyncKey) : false;
  const isWorkspaceTerminalSyncing = workspaceSyncKey ? terminalSyncingTargets.has(workspaceSyncKey) : false;
  const generalTerminalError = generalSyncKey ? terminalSyncErrors[generalSyncKey] : undefined;
  const workspaceTerminalError = workspaceSyncKey ? terminalSyncErrors[workspaceSyncKey] : undefined;
  const handleTerminalTabsChange = useCallback((tabsChange: TerminalPanelTabsChange) => {
    if (!terminalTargetKey) return;
    setTerminalTabs(terminalTargetKey, tabsChange);
  }, [setTerminalTabs, terminalTargetKey],);

  const handleActiveTerminalTabChange = useCallback((tabId: string) => {
    if (!terminalTargetKey) return;
    setActiveTerminalTab(terminalTargetKey, tabId);
  }, [setActiveTerminalTab, terminalTargetKey],);

  const setTerminalTargetSyncing = useCallback((key: string, isSyncing: boolean) => {
    setTerminalSyncingTargets((current) => {
      const next = new Set(current);
      if (isSyncing) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const setTerminalTargetError = useCallback((key: string, error?: string) => {
    setTerminalSyncErrors((current) => {
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
    latestTerminalSyncByTargetRef.current.get(key) === sequence, [],);

  const applyTerminalWindows = useCallback((target: TerminalPanelTarget, windows: TerminalWindowRecord[]) => {
    if (target.kind === 'general') {
      setGeneralTerminalWindows(windows);
      return;
    }
    setTerminalWindows(target.terminalId, windows);
  }, [setGeneralTerminalWindows, setTerminalWindows],);

  const refreshTerminalWindowMetadata = useCallback((target: TerminalPanelTarget, windows: TerminalWindowRecord[]) => {
    if (target.kind === 'general') {
      refreshGeneralTerminalWindowMetadata(windows);
      return;
    }
    refreshWorkspaceTerminalWindowMetadata(target.terminalId, windows);
  }, [refreshGeneralTerminalWindowMetadata, refreshWorkspaceTerminalWindowMetadata],);

  const refreshTerminalSnapshotWindows = useCallback(async () => {
    if (!terminalTransport || !isDesktopTerminalTransportAvailable()) return;
    try {
      setTerminalSnapshotWindows(await terminalTransport.snapshot());
    } catch {
      // Full snapshots are opportunistic; visible terminal panes surface target-specific errors.
    }
  }, [setTerminalSnapshotWindows, terminalTransport]);

  const listTerminalWindowsForTarget = useCallback(async (target: TerminalPanelTarget) => {
    if (!terminalTransport) { throw new Error('Terminal transport is unavailable in this client.');
      }
    const input = terminalTargetInput(target);
    const windows = await terminalTransport.snapshot(input);
    if (isDesktopTerminalTransportAvailable()) { setTerminalSnapshotWindows(windows);
      }
    return windows.filter((window) => isTerminalWindowForTarget(window, target));
  }, [setTerminalSnapshotWindows, terminalTransport],);

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
  }, [listTerminalWindowsForTarget, refreshTerminalWindowMetadata],);

  const syncTerminalTarget = useCallback(async (
    target: TerminalPanelTarget | undefined,
    options: { ensure?: boolean; preferredActiveTabId?: string; requiredWindow?: TerminalWindowRecord; } = {},
  ) => {
    if (!target) return [];
    const key = terminalSyncKey(target);
    if (!key) return [];
    const sequence = beginTerminalSync(key);
    setTerminalTargetSyncing(key, true);
    setTerminalTargetError(key, undefined);
    try {
      if (!terminalTransport) { throw new Error('Terminal transport is unavailable in this client.');
        }
      let windows = await listTerminalWindowsForTarget(target);
      if (options.ensure && windows.length === 0) {
        const created = await terminalTransport.create(terminalTargetInput(target));
        windows = await listTerminalWindowsForTarget(target);
        if (!windows.some((window) => window.terminalId === created.terminalId)) windows = [created];
      }
      const requiredWindow = options.requiredWindow;
      if (
        requiredWindow
        && isTerminalWindowForTarget(requiredWindow, target)
        && !windows.some((window) => window.terminalId === requiredWindow.terminalId)
      ) {
        windows = [...windows, requiredWindow];
      }
      if (!isLatestTerminalSync(key, sequence)) return undefined;
      applyTerminalWindows(target, windows);
      const preferredActiveTabId = options.preferredActiveTabId;
      if (preferredActiveTabId && windows.some((window) => window.terminalId === preferredActiveTabId)) {
        if (target.kind === 'general') { setActiveGeneralTerminalTabId(preferredActiveTabId);
          }
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
      if (isLatestTerminalSync(key, sequence)) { setTerminalTargetSyncing(key, false);
        }
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
  ],);

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
      await syncTerminalTarget(target, { preferredActiveTabId: created.terminalId, requiredWindow: created, });
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
  ],);

  const closeTerminalTabForTarget = useCallback(async (
    target: TerminalPanelTarget | undefined,
    tab: TerminalPanelTab,
    onEmpty: () => void
  ) => {
    if (!target || !terminalTransport) return;
    const key = terminalSyncKey(target);
    if (key) {
      beginTerminalSync(key);
      setTerminalTargetSyncing(key, true);
      setTerminalTargetError(key, undefined);
    }
    try {
      await terminalTransport.close(tab.terminalId, terminalTargetInputForTab(target, tab));
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
    terminalTransport],);

  const handleTerminalExitForTarget = useCallback(async (
    target: TerminalPanelTarget | undefined,
    onEmpty: () => void
  ) => {
    if (!target) return;
    const windows = await syncTerminalTarget(target);
    if (windows?.length === 0) onEmpty();
  }, [syncTerminalTarget],);

  useEffect(() => {
    if (!generalTerminalSyncTarget) return;
    void syncTerminalTarget(generalTerminalSyncTarget, { ensure: isGeneralTerminalOpen, });
  }, [generalSyncKey, generalTerminalSyncTarget, isGeneralTerminalOpen, syncTerminalTarget]);

  useEffect(() => {
    if (!workspaceTerminalSyncTarget) return;
    void syncTerminalTarget(workspaceTerminalSyncTarget, { ensure: showTerminalPane, });
  }, [showTerminalPane, syncTerminalTarget, workspaceSyncKey, workspaceTerminalSyncTarget]);

  useEffect(() => {
    void refreshTerminalSnapshotWindows();
  }, [refreshTerminalSnapshotWindows]);

  useEffect(() => {
    if (!terminalTransport || !isDesktopTerminalTransportAvailable()) { return undefined;
    }
    const interval = window.setInterval(() => {
      void refreshTerminalSnapshotWindows();
    }, terminalSnapshotRefreshMs);
    return () => window.clearInterval(interval);
  }, [refreshTerminalSnapshotWindows, terminalTransport]);

  useEffect(() => {
    if (!terminalTransport || !isDesktopTerminalTransportAvailable()) { return undefined;
    }
    return terminalTransport.subscribe((event) => {
      if (event.type === 'created' || event.type === 'exit') { void refreshTerminalSnapshotWindows();
      }
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
  const { data: queriedServerThreads, isSuccess: areThreadsLoaded } = useQuery({
    queryKey: ['threads', resourceId],
    queryFn: () => listServerThreads(),
  });
  const serverThreads = queriedServerThreads ?? emptyServerThreads;

  useEffect(() => {
    if (!areThreadsLoaded || !projectsQuery.isSuccess) return;
    setServerThreads(serverThreads, projects);
  }, [areThreadsLoaded, projects, projectsQuery.isSuccess, serverThreads, setServerThreads]);

  useEffect(() => {
    if (!projectsQuery.isSuccess) return;
    const editorTargetKeys = new Set<string>();
    const workspaceIds = new Set<string>();
    const projectIds = new Set(projects.map((project) => project.id));
    for (const project of projects) {
      const product = productForProjectKind(project.projectKind);
      if (product !== 'code' && product !== 'notes') continue;
      for (const workspace of project.workspaces) {
        workspaceIds.add(workspace.id);
        editorTargetKeys.add(getEditorTabTargetKey(product, project.id, workspace.id));
      }
    }
    reconcileEditorTargets(editorTargetKeys);
    reconcileTerminalTargets(workspaceIds);
    reconcileSessionProjects(projectIds);
  }, [projects, projectsQuery.isSuccess, reconcileEditorTargets, reconcileSessionProjects, reconcileTerminalTargets]);

  useEffect(() => {
    if (!proposalWorkflowEnabled) {
      if (editorSlotMode === 'proposal_review') closeProposalReview();
      if (validatedProposalReviewKey) setValidatedProposalReviewKey(undefined);
      return;
    }

    if (editorSlotMode !== 'proposal_review' || !activeProposalPath || !currentProposalReviewKey) {
      if (validatedProposalReviewKey) setValidatedProposalReviewKey(undefined);
      return;
    }
    if (!hasInitializedThreads) return;
    if (validatedProposalReviewKey === currentProposalReviewKey) return;

    if (canAutoShowActiveProposalReview) {
      setValidatedProposalReviewKey(currentProposalReviewKey);
      return;
    }

    closeProposalReview();
  }, [
    activeProposalPath,
    canAutoShowActiveProposalReview,
    closeProposalReview,
    currentProposalReviewKey,
    editorSlotMode,
    hasInitializedThreads,
    validatedProposalReviewKey,
  ]);

  useEffect(() => {
    if (storedActiveProduct !== activeProduct) setActiveProduct(activeProduct);
  }, [activeProduct, setActiveProduct, storedActiveProduct]);

  useEffect(() => {
    if (!areThreadsLoaded || !projectsQuery.isSuccess) return;

    if (isActiveSurfaceSupported) return;

    const nextProject = projects.find(
      (project) =>
        projectBelongsToProduct(project, activeProduct) && project.workspaces.length > 0,
    );
    const nextWorkspace = nextProject?.workspaces[0];
    if (nextProject && nextWorkspace) {
      selectWorkspaceSurface(nextProject.id, nextWorkspace.id);
      return;
    }

    const nextThread = threads.find((thread) => {
      const product = productForThread(thread);
      return thread.archived !== true && product !== undefined && isProductAllowedForClientApp(product, clientApp);
    });
    if (nextThread) {
      selectThreadSurface(nextThread.id);
      return;
    }

  }, [
    activeProduct,
    clientApp,
    isActiveSurfaceSupported,
    areThreadsLoaded,
    productForThread,
    projects,
    projectsQuery.isSuccess,
    selectThreadSurface,
    selectWorkspaceSurface,
    threads,
  ]);

  const focusSidebar = useCallback(() => {
    window.requestAnimationFrame(() => {
      const sidebar = sidebarSurfaceRef.current;
      const firstControl = sidebar?.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',);
      (firstControl ?? sidebar)?.focus();
    });
  }, []);

  const focusChat = useCallback(() => {
    if (hasChatPaneTarget) openPane('chat');
    setChatFocusRequest((request) => request + 1);
  }, [hasChatPaneTarget, openPane]);

  const createThreadFromShortcut = useCallback(() => {
    const activeThreadProduct = productForThread(activeThread);
    const creationProduct = activeSurfaceProduct && isProductAllowedForClientApp(activeSurfaceProduct, clientApp)
      ? activeSurfaceProduct
      : activeProduct;
    const projectId = activeSurface.kind === 'workspace'
      ? activeSurface.projectId
      : activeThreadProduct === creationProduct ? activeThread?.projectId : undefined;
    const workspaceId = activeSurface.kind === 'workspace'
      ? activeSurface.workspaceId
      : activeThreadProduct === creationProduct ? activeThread?.workspaceId : undefined;

    if (!projectId || !workspaceId) return;

    void newThread(projectId, workspaceId)
      .then(() => queryClient.invalidateQueries({ queryKey: ['threads', resourceId] }))
      .then(() => focusChat());
  }, [activeProduct, activeSurface, activeSurfaceProduct, activeThread, clientApp, focusChat, newThread, productForThread, queryClient, resourceId,]);
  const handleGeneralTerminalToggle = useCallback(() => {
    const shouldFocusAfterOpen = !isGeneralTerminalOpen;
    toggleGeneralTerminal();
    if (shouldFocusAfterOpen) { window.requestAnimationFrame(focusGeneralTerminal);
    }
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
  }, [focusChat, focusEditor, focusTerminal, hasChatPaneTarget, hasEditorPaneTarget, hasTerminalPaneTarget, toggleMaximizedPane,],);

  const handleTerminalPaneColumnToggle = useCallback(() => {
    if (!terminalTarget || !canToggleTerminalPaneColumn) return;
    toggleTerminalPaneColumn(terminalTarget.projectId, terminalTarget.workspaceId);
    window.requestAnimationFrame(focusTerminal);
  }, [
    canToggleTerminalPaneColumn,
    focusTerminal,
    terminalTarget?.projectId,
    terminalTarget?.workspaceId,
    toggleTerminalPaneColumn,
  ]);

  const shortcutCommands = useAppShortcuts({
    createThreadFromShortcut,
    focusChat,
    focusEditor,
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
    showChatPane,
    showEditorPane,
    showSidebarPreview,
    showTerminalPane,
    toggleSidebar,
  });
  useEffect(() => {
    if (activeSurface.kind !== 'workspace' || !sideEditorTargetKey || !showEditorPane) return;
    focusEditor();
  }, [activeSurface, focusEditor, showEditorPane, sideEditorTargetKey
  ]);
  const isSidebarSurfaceVisible = isSidebarOpen || showSidebarPreview;
  const hasFloatingLeftAction = showHeaderSidebarToggle || showPinnedSidebarToggle || showGlobalTerminalButton;
  const hasHeaderLeftAction = showHeaderSidebarToggle || showGlobalTerminalButton;
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
  const renderGeneralTerminalButton = () => {
    const isAvailable = Boolean(generalTerminalTarget);
    const isOpen = isAvailable && isGeneralTerminalOpen;

    return showGlobalTerminalButton ? (
      <Button
        className={[
          isOpen ? 'bg-accent' : '',
          isAvailable && isGeneralTerminalActive ? 'text-foreground' : ''
        ].filter(Boolean).join(' ')}
        size="icon"
        variant="ghost"
        aria-label={isOpen ? 'Hide general terminal' : 'Show general terminal'}
        data-active={isOpen ? 'true' : 'false'}
        disabled={!isAvailable}
        onClick={handleGeneralTerminalToggle}
        title={isAvailable ? undefined : 'Global terminal unavailable'}
      >
        <TerminalSquare size={18} />
        <TerminalTabCountBadge count={generalTerminalTabs.length} />
      </Button>
    ) : null;
  };
  const renderProductNavigation = () => {
    const products = getClientAppNavigationProducts(clientApp);
    if (products.length <= 1) return undefined;

    return (
      <nav className="weave-product-rail flex min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-md text-base font-semibold" aria-label={`${clientApp.displayName} sections`}>
        {products.map((product) => {
          const label = getClientAppProductLabel(clientApp, product);
          return (
            <button
              key={product}
              type="button"
              className={[
                'h-8 shrink-0 rounded-md px-2.5 leading-none outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background sm:px-3',
                activeProduct === product
                  ? 'bg-accent text-foreground shadow-sm'
                  : 'text-foreground/70 hover:bg-accent/60 hover:text-foreground',
              ].filter(Boolean).join(' ')}
              data-active={activeProduct === product ? 'true' : 'false'}
              aria-current={activeProduct === product ? 'page' : undefined}
              aria-label={`Switch to ${label}`}
              onClick={() => setActiveProduct(product)}
            >
              {label}
            </button>
          );
        })}
      </nav>
    );
  };
  const renderAppBarCenterContent = () => renderProductNavigation() ?? appBarBreadcrumb;

  const renderTerminalPanel = (variant: 'pane' | 'main') => showTerminalPane ? (
    terminalTarget ? (
    <TerminalPaneHost
      activeTabId={activeTerminalTabId}
      breadcrumb={breadcrumbPane === 'terminal' && variant === 'main' ? contextBreadcrumb : undefined}
      canToggleMaximized={canToggleTerminalMaximized}
      error={workspaceTerminalError}
      identity={getLegacyPaneIdentity('terminal', terminalTarget.workspaceId)}
      isSyncing={isWorkspaceTerminalSyncing}
      isEffectivelyMaximized={isTerminalEffectivelyMaximized}
      layoutSyncKey={terminalLayoutSyncKey}
      lifecycle={{
        focusRequest: terminalFocusRequest,
        onClose: () => closePane('terminal'),
      }}
      onActiveTabIdChange={handleActiveTerminalTabChange}
      onAddTab={() => void addTerminalTabForTarget(workspaceTerminalSyncTarget)}
      onCloseTab={(tab) => void closeTerminalTabForTarget(workspaceTerminalSyncTarget, tab, () => closePane('terminal'))}
      onExit={() => void handleTerminalExitForTarget(workspaceTerminalSyncTarget, () => closePane('terminal'))}
      onMaximizeToggle={() => handleMainPaneMaximizeToggle('terminal')}
      onRestoreMaximized={restoreMaximizedPane}
      onSessionActiveChange={handleTerminalSessionActiveChange}
      onTabsChange={handleTerminalTabsChange}
      tabs={terminalTabs}
      target={terminalTarget}
      terminalColumn={canToggleTerminalPaneColumn ? terminalPaneColumn : undefined}
      transport={terminalTransport}
      onTerminalColumnToggle={canToggleTerminalPaneColumn ? handleTerminalPaneColumnToggle : undefined}
      variant={variant}
    />
    ) : workspaceTargets.activeWorkspaceId ? (
      <PaneContentHost
        className="grid min-h-0 flex-1 place-items-center bg-background text-sm text-muted-foreground"
        identity={getLegacyPaneIdentity('terminal', workspaceTargets.activeWorkspaceId)}
        paneType="terminal"
        data-weave-terminal-unavailable
      >
        <div
          className="max-w-sm text-center"
        >
          Terminal unavailable. Weave will reconnect this pane when the workspace Portal returns.
        </div>
      </PaneContentHost>
    ) : (
      <div
        className="grid min-h-0 flex-1 place-items-center bg-background text-sm text-muted-foreground"
        data-weave-terminal-unavailable
      >
        <div className="max-w-sm text-center">
          Terminal unavailable. Weave will reconnect this pane when the workspace Portal returns.
        </div>
      </div>
    )
  ) : null;

  const renderChatPane = () => {
    if (!showChatPane) return null;
    const chatPaneProps = {
      activeThreadId,
      isMaximized: isChatMaximized,
      lifecycle: {
        focusRequest: chatFocusRequest,
        onClose: () => closePane('chat'),
      },
      runningThreadIds,
      terminalSlot: showTerminalInChatPane ? renderTerminalPanel('pane') : undefined,
      threads,
      onMaximizeToggle: () => handleMainPaneMaximizeToggle('chat'),
    };
    return (
      <div
        key="chat"
        className={twoColumnPaneLayout?.editorReservedWidthPx !== undefined
          ? 'flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden'
          : 'flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden'}
        style={twoColumnPaneLayout?.editorReservedWidthPx === undefined
          ? undefined
          : { width: `max(0px, calc(100% - ${twoColumnPaneLayout.editorReservedWidthPx}px - ${mainPaneDividerWidthPx}px))` }}
        data-weave-main-pane="chat"
        data-maximized={isChatMaximized ? 'true' : 'false'}
        data-weave-right-pane-reserved-width={twoColumnPaneLayout?.editorReservedWidthPx}
      >
        {activeThread?.workspaceId ? (
          <ChatPaneHost
            {...chatPaneProps}
            identity={getLegacyPaneIdentity('thread', activeThread.workspaceId)}
          />
        ) : (
          <LegacyUnscopedChatPane {...chatPaneProps} />
        )}
      </div>
    );
  };

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

  const renderEditorPane = () => {
    if (!showEditorPane) return null;

    if (!editorTarget && !notesTarget && workspaceTargets.activeWorkspaceId) {
      return (
        <PaneContentHost
          key="editor-unavailable"
          className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden"
          identity={getLegacyPaneIdentity('editor', workspaceTargets.activeWorkspaceId)}
          paneType="editor"
          data-weave-main-pane="editor"
          data-weave-editor-unavailable
        >
          <div className="grid min-h-0 flex-1 place-items-center bg-background text-sm text-muted-foreground">
            <div className="max-w-sm text-center">
              {activeSurfaceProduct === 'notes' ? 'Notes vault' : 'Editor'} unavailable. Weave will restore it when the
              workspace Portal returns.
            </div>
          </div>
          {showTerminalInEditorPane ? renderTerminalPanel('pane') : null}
        </PaneContentHost>
      );
    }

    if (!editorTarget && !notesTarget) {
      return (
        <div
          key="editor-unavailable"
          className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden"
          data-weave-main-pane="editor"
          data-weave-editor-unavailable
        >
          <div className="grid min-h-0 flex-1 place-items-center bg-background text-sm text-muted-foreground">
            <div className="max-w-sm text-center">
              Editor unavailable. Weave will reconnect this pane when the workspace Portal returns.
            </div>
          </div>
          {showTerminalInEditorPane ? renderTerminalPanel('pane') : null}
        </div>
      );
    }

    if (
      proposalWorkflowEnabled
      && editorSlotMode === 'proposal_review'
      && activeProposalPath
      && editorTarget
      && validatedProposalReviewKey === currentProposalReviewKey
    ) {
      return (
        <PaneContentHost
          key="proposal-review"
          className="contents"
          identity={getLegacyPaneIdentity('editor', editorTarget.workspaceId)}
          paneType="editor"
        >
          <ProposalReviewPane
            proposalPath={activeProposalPath}
            target={editorTarget}
            threadId={activeThreadId}
            isMaximized={isEditorMaximized}
            terminalSlot={showTerminalInEditorPane ? renderTerminalPanel('pane') : undefined}
            selectedFilePath={activeProposalFilePath}
            onClose={closeProposalReview}
            onOpenSource={(path) => {
              if (!activeThread?.workspaceId) return;
              requestEditorFollow({
                threadId: activeThreadId,
                workspaceId: activeThread.workspaceId,
                path,
                line: 1,
                toolCallId: 'proposal-review',
              });
            }}
            onExpandedChange={(nextExpanded) => {
              if (nextExpanded) handleMainPaneMaximizeToggle('editor');
              else restoreMaximizedPane();
            }}
          />
        </PaneContentHost>
      );
    }

    const target = (notesTarget ?? editorTarget)!;
    return (
      <div
        key="editor"
        className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden"
        data-weave-main-pane="editor"
        data-maximized={isEditorMaximized ? 'true' : 'false'}
      >
        <EditorPaneHost
          followRequest={editorFollowRequest}
          forceExplorerHoverOnly={forceExplorerHoverOnly}
          identity={getLegacyPaneIdentity('editor', target.workspaceId)}
          isMaximized={isEditorMaximized}
          lifecycle={{
            focusRequest: editorFocusRequest,
            onClose: () => closePane('editor'),
          }}
          mode={notesTarget ? 'notes' : 'code'}
          target={target}
          terminalSlot={showTerminalInEditorPane ? renderTerminalPanel('pane') : undefined}
          proposalBackFilePath={canBackToActiveProposalReview ? activeProposalFilePath : undefined}
          onBackToProposalPreview={canBackToActiveProposalReview && activeProposalPath ? ( path) => openProposalReview(activeProposalPath, { filePath: path }) : undefined}
          onExpandedChange={(nextExpanded) => {
            if (nextExpanded) handleMainPaneMaximizeToggle('editor');
            else restoreMaximizedPane();
          }}
        />
      </div>
    );
  };

  const orderedMainPanes = [renderChatPane(), renderEditorPane(), renderTerminalPane()];
  const headerLeftActions = shouldRenderHeaderLeftActions ? (
    <>
      {showHeaderSidebarToggle ? renderSidebarToggleButton() : null}
      {renderGeneralTerminalButton()}
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
      {hasTerminalPaneTarget ? (
        <Button
          className={[
            showTerminalPane ? 'bg-accent' : '',
            hasActiveTerminal ? 'text-foreground' : ''
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
      {hasEditorPaneTarget ? (
        <Button
          className={showEditorPane ? 'bg-accent' : ''}
          size="icon"
          variant="ghost"
          aria-label={isNotesSurface ?showEditorPane ? 'Hide notes' : 'Show notes' :showEditorPane ? 'Hide editor' : 'Show editor'}
          data-active={showEditorPane ? 'true' : 'false'}
          data-weave-project-code-pane-toggle={editorTarget ? 'true' : undefined}
          onClick={handleEditorPaneToggle}
        >
          {isNotesSurface ? <StickyNote size={18} /> : <Code2 size={18} />}
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
              {isNotesSurface ? <StickyNote size={14} /> : <Code2 size={14} />}
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
	        className="pointer-events-none fixed -left-[9999px] -top-[9999px] font-mono opacity-0"
	        style={{
	          fontSize: 'var(--weave-editor-font-size)',
	          paddingLeft: `calc(var(--weave-editor-gutter-width) + ${editorLineHorizontalPaddingPx}px)`,
	          paddingRight: `${editorLineHorizontalPaddingPx}px`,
	        }}
	        aria-hidden="true"
      >
        {editorColumnMeasureText}
      </span>
      <ClientToolHost
        active={Boolean(activeProject && activeWorkspace)}
        projectId={activeProject?.id}
        resourceId={resourceId}
        threadId={activeThreadId}
        workspaceId={activeWorkspace?.id}
      />
      <NotificationHost />
      <AppSidebarHost
        adoptedLocalPortalId={adoptedLocalPortalId}
        closeOnPinnedSelect={isPortraitViewport}
        clientApp={clientApp}
        connectionSettingsButton={connectionSettingsButton}
        isPortraitViewport={isPortraitViewport}
        isSidebarOpen={isSidebarOpen}
        product={activeProduct}
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
        </div>
      ) : null}
      <WorkspaceMainContent
        centerContent={renderAppBarCenterContent()}
        emptyState={emptyMainPaneState}
        isEmpty={!showChatPane && !showEditorPane && !showTerminalPane}
        isSidebarAutoHidden={isSidebarAutoHidden}
        isSidebarOpen={isSidebarOpen}
        isSidebarPinnedOpen={isSidebarPinnedOpen}
        leftActions={headerLeftActions}
        panes={orderedMainPanes}
        rightActions={headerRightActions}
        showSidebarPreview={showSidebarPreview}
      />
      <GlobalTerminalOverlay
        activeTabId={activeGeneralTerminalTabId}
        error={generalTerminalError}
        focusRequest={generalTerminalFocusRequest}
        isOpen={isGeneralTerminalOpen}
        isSyncing={isGeneralTerminalSyncing}
        onActiveTabIdChange={setActiveGeneralTerminalTabId}
        onAddTab={() => void addTerminalTabForTarget(generalTerminalSyncTarget)}
        onCloseTab={(tab) => void closeTerminalTabForTarget(generalTerminalSyncTarget, tab, hideGeneralTerminal)}
        onExit={() => void handleTerminalExitForTarget(generalTerminalSyncTarget, hideGeneralTerminal)}
        onHide={hideGeneralTerminal}
        onSessionActiveChange={handleGeneralTerminalSessionActiveChange}
        onTabsChange={setGeneralTerminalTabs}
        tabs={generalTerminalTabs}
        target={generalTerminalTarget}
        transport={terminalTransport}
      />
    </div>
    </ShortcutProvider>
  );
};
