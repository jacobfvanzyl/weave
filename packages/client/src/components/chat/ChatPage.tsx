import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Code2, PanelLeft, Settings, TerminalSquare } from 'lucide-react';
import { listProjects, listPortals, listServerThreads } from '../../lib/chat-state-api';
import { isDesktopEditorBackendAvailable, isEditorBackendAvailable } from '../../lib/editor-backend';
import { isDesktopTerminalTransportAvailable, isTerminalTransportAvailable } from '../../lib/terminal-transport';
import { useChatStore } from '../../stores/chat-store';
import { Button } from '../ui/button';
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from '../ui/menu';
import { ShortcutProvider } from '../shortcuts';
import type { ShortcutCommand } from '../../lib/shortcuts';
import { AssistantChat } from './AssistantChat';
import { PlanSidebar } from './PlanSidebar';
import { ThreadSidebar } from './ThreadSidebar';
import type { TerminalPanelTab, TerminalPanelTabsChange } from './TerminalPanel';

const TerminalPanel = lazy(() => import('./TerminalPanel').then(module => ({ default: module.TerminalPanel })));
const EditorPanel = lazy(() => import('./EditorPanel').then(module => ({ default: module.EditorPanel })));

const isPortraitViewportNow = () => window.innerHeight > window.innerWidth;
const isElectronWindowNow = () =>
  typeof document !== 'undefined' && document.documentElement.dataset.weaveWindowType === 'electron';
const chatContentMaxWidthPx = 48 * 16;
const threadSidebarWidthPx = 24 * 16;
const generalTerminalId = 'weave-general-terminal';

let terminalPanelTabCounter = 0;

const getPrimaryTerminalTabId = (baseTerminalId: string) => `${baseTerminalId}:primary`;

const createTerminalPanelTab = (
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

const TerminalTabCountBadge = ({ count }: { count: number }) => count > 0 ? (
  <span
    className="pointer-events-none absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-background bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground shadow-sm"
    data-weave-terminal-count-badge
  >
    {count}
  </span>
) : null;

const useIsPortraitViewport = () => {
  const [isPortraitViewport, setIsPortraitViewport] = useState(() => isPortraitViewportNow());

  useEffect(() => {
    const sync = () => setIsPortraitViewport(isPortraitViewportNow());

    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  return isPortraitViewport;
};

const useMeasuredElementWidth = () => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    const updateWidth = () => setWidth(element.getBoundingClientRect().width);
    updateWidth();

    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, []);

  return [ref, width] as const;
};

type ChatPageProps = {
  connectionSettingsButton?: ReactNode;
};

type WindowSurfacesInput = {
  editorTargetKey?: string;
  hasGeneralTerminalTarget: boolean;
  isPortraitViewport: boolean;
  pageWidth: number;
  terminalWorkspaceId?: string;
};

const useWindowSurfaces = ({
  editorTargetKey,
  hasGeneralTerminalTarget,
  isPortraitViewport,
  pageWidth,
  terminalWorkspaceId,
}: WindowSurfacesInput) => {
  const [isSidebarPinnedOpen, setIsSidebarPinnedOpen] = useState(() => !isPortraitViewportNow());
  const [isSidebarPreviewOpen, setIsSidebarPreviewOpen] = useState(false);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [isTerminalExpanded, setIsTerminalExpanded] = useState(false);
  const [isGeneralTerminalOpen, setIsGeneralTerminalOpen] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isEditorExpanded, setIsEditorExpanded] = useState(false);
  const [terminalFocusRequest, setTerminalFocusRequest] = useState(0);
  const [generalTerminalFocusRequest, setGeneralTerminalFocusRequest] = useState(0);
  const [editorFocusRequest, setEditorFocusRequest] = useState(0);
  const [activeTerminalWorkspaceIds, setActiveTerminalWorkspaceIds] = useState<Set<string>>(() => new Set());
  const [isGeneralTerminalActive, setIsGeneralTerminalActive] = useState(false);
  const sidebarPreviewCloseTimeoutRef = useRef<number | undefined>(undefined);
  const workspaceWidthWithPinnedSidebar = Math.max(0, pageWidth - threadSidebarWidthPx);
  const chatWidthWithPinnedSidebar = isEditorOpen
    ? workspaceWidthWithPinnedSidebar / 2
    : workspaceWidthWithPinnedSidebar;
  const wouldAutoHideSidebarIfPinned = isEditorOpen && !isPortraitViewport && chatWidthWithPinnedSidebar < chatContentMaxWidthPx;
  const isSidebarAutoHidden = isSidebarPinnedOpen && wouldAutoHideSidebarIfPinned;
  const isSidebarOpen = isSidebarPinnedOpen && !isSidebarAutoHidden && !isPortraitViewport;
  const workspaceWidth = isSidebarOpen ? workspaceWidthWithPinnedSidebar : pageWidth;
  const shouldClampChatPaneForEditor = isEditorOpen && !isEditorExpanded && workspaceWidth >= chatContentMaxWidthPx * 2;
  const canPreviewSidebar = !isSidebarOpen;
  const showSidebarPreview = canPreviewSidebar && isSidebarPreviewOpen;
  const showPinnedSidebarToggle = isSidebarOpen;
  const showHeaderSidebarToggle = !isSidebarOpen;
  const hasTerminalTarget = Boolean(terminalWorkspaceId);
  const hasEditorTarget = Boolean(editorTargetKey);
  const hasActiveTerminal = terminalWorkspaceId ? activeTerminalWorkspaceIds.has(terminalWorkspaceId) : false;

  useEffect(() => {
    if (isPortraitViewport) setIsSidebarPinnedOpen(false);
  }, [isPortraitViewport]);

  useEffect(() => {
    if (isSidebarOpen) setIsSidebarPreviewOpen(false);
  }, [isSidebarOpen]);

  useEffect(() => {
    setIsTerminalExpanded(false);
    if (!hasTerminalTarget) setIsTerminalOpen(false);
  }, [hasTerminalTarget, terminalWorkspaceId]);

  useEffect(() => {
    if (!hasGeneralTerminalTarget) {
      setIsGeneralTerminalOpen(false);
      setIsGeneralTerminalActive(false);
    }
  }, [hasGeneralTerminalTarget]);

  useEffect(() => {
    setIsEditorExpanded(false);
    if (!hasEditorTarget) setIsEditorOpen(false);
  }, [editorTargetKey, hasEditorTarget]);

  useEffect(() => () => {
    if (sidebarPreviewCloseTimeoutRef.current !== undefined) {
      window.clearTimeout(sidebarPreviewCloseTimeoutRef.current);
    }
  }, []);

  const clearSidebarPreviewCloseTimeout = useCallback(() => {
    if (sidebarPreviewCloseTimeoutRef.current === undefined) return;
    window.clearTimeout(sidebarPreviewCloseTimeoutRef.current);
    sidebarPreviewCloseTimeoutRef.current = undefined;
  }, []);

  const openSidebarPreview = useCallback(() => {
    if (!canPreviewSidebar) return;
    clearSidebarPreviewCloseTimeout();
    setIsSidebarPreviewOpen(true);
  }, [canPreviewSidebar, clearSidebarPreviewCloseTimeout]);

  const closeSidebarPreview = useCallback(() => {
    clearSidebarPreviewCloseTimeout();
    setIsSidebarPreviewOpen(false);
  }, [clearSidebarPreviewCloseTimeout]);

  const scheduleSidebarPreviewClose = useCallback(() => {
    clearSidebarPreviewCloseTimeout();
    sidebarPreviewCloseTimeoutRef.current = window.setTimeout(() => {
      sidebarPreviewCloseTimeoutRef.current = undefined;
      setIsSidebarPreviewOpen(false);
    }, 140);
  }, [clearSidebarPreviewCloseTimeout]);

  const toggleSidebar = useCallback(() => {
    clearSidebarPreviewCloseTimeout();
    if (isPortraitViewport) {
      setIsSidebarPinnedOpen(false);
      setIsSidebarPreviewOpen(open => !open);
      return;
    }

    if (!isSidebarOpen && wouldAutoHideSidebarIfPinned) {
      setIsSidebarPinnedOpen(true);
      setIsSidebarPreviewOpen(open => !open);
      return;
    }

    setIsSidebarPreviewOpen(false);
    setIsSidebarPinnedOpen(open => !open);
  }, [clearSidebarPreviewCloseTimeout, isPortraitViewport, isSidebarOpen, wouldAutoHideSidebarIfPinned]);

  const closeSidebar = useCallback(() => {
    clearSidebarPreviewCloseTimeout();
    setIsSidebarPinnedOpen(false);
    setIsSidebarPreviewOpen(false);
  }, [clearSidebarPreviewCloseTimeout]);

  const toggleTerminal = useCallback(() => {
    if (!hasTerminalTarget) return;
    if (isTerminalOpen) setIsTerminalExpanded(false);
    setIsEditorExpanded(false);
    setIsTerminalOpen(open => !open);
  }, [hasTerminalTarget, isTerminalOpen]);

  const hideTerminal = useCallback(() => {
    setIsTerminalOpen(false);
    setIsTerminalExpanded(false);
  }, []);

  const toggleTerminalExpanded = useCallback(() => {
    if (!hasTerminalTarget) return;
    setIsEditorExpanded(false);
    setIsTerminalOpen(true);
    setIsTerminalExpanded(expanded => !expanded);
  }, [hasTerminalTarget]);

  const focusTerminal = useCallback(() => {
    if (!hasTerminalTarget) return;
    setIsTerminalOpen(true);
    setTerminalFocusRequest(request => request + 1);
  }, [hasTerminalTarget]);

  const toggleGeneralTerminal = useCallback(() => {
    if (!hasGeneralTerminalTarget) return;
    setIsGeneralTerminalOpen(open => !open);
  }, [hasGeneralTerminalTarget]);

  const hideGeneralTerminal = useCallback(() => {
    setIsGeneralTerminalOpen(false);
  }, []);

  const focusGeneralTerminal = useCallback(() => {
    if (!hasGeneralTerminalTarget) return;
    setIsGeneralTerminalOpen(true);
    setGeneralTerminalFocusRequest(request => request + 1);
  }, [hasGeneralTerminalTarget]);

  const toggleEditor = useCallback(() => {
    if (!hasEditorTarget) return;
    if (isEditorOpen) setIsEditorExpanded(false);
    setIsTerminalExpanded(false);
    setIsEditorOpen(open => !open);
  }, [hasEditorTarget, isEditorOpen]);

  const hideEditor = useCallback(() => {
    setIsEditorOpen(false);
    setIsEditorExpanded(false);
  }, []);

  const toggleEditorExpanded = useCallback(() => {
    if (!hasEditorTarget) return;
    setIsTerminalExpanded(false);
    setIsEditorOpen(true);
    setIsEditorExpanded(expanded => !expanded);
  }, [hasEditorTarget]);

  const focusEditor = useCallback(() => {
    if (!hasEditorTarget) return;
    setIsEditorOpen(true);
    setEditorFocusRequest(request => request + 1);
  }, [hasEditorTarget]);

  const handleTerminalExpandedChange = useCallback((nextExpanded: boolean) => {
    setIsTerminalExpanded(nextExpanded);
    if (nextExpanded) setIsEditorExpanded(false);
  }, []);

  const handleEditorExpandedChange = useCallback((nextExpanded: boolean) => {
    setIsEditorExpanded(nextExpanded);
    if (nextExpanded) setIsTerminalExpanded(false);
  }, []);

  const handleTerminalSessionActiveChange = useCallback((isActive: boolean) => {
    if (!terminalWorkspaceId) return;
    setActiveTerminalWorkspaceIds(current => {
      const isCurrentlyActive = current.has(terminalWorkspaceId);
      if (isCurrentlyActive === isActive) return current;

      const next = new Set(current);
      if (isActive) {
        next.add(terminalWorkspaceId);
      } else {
        next.delete(terminalWorkspaceId);
      }
      return next;
    });
  }, [terminalWorkspaceId]);

  const handleGeneralTerminalSessionActiveChange = useCallback((isActive: boolean) => {
    setIsGeneralTerminalActive(isActive);
  }, []);

  return {
    closeSidebar,
    closeSidebarPreview,
    editorFocusRequest,
    focusEditor,
    focusGeneralTerminal,
    focusTerminal,
    handleEditorExpandedChange,
    handleGeneralTerminalSessionActiveChange,
    handleTerminalExpandedChange,
    handleTerminalSessionActiveChange,
    hasActiveTerminal,
    hasEditorTarget,
    hasGeneralTerminalTarget,
    hasTerminalTarget,
    hideEditor,
    hideGeneralTerminal,
    hideTerminal,
    isEditorExpanded,
    isEditorOpen,
    isGeneralTerminalActive,
    isGeneralTerminalOpen,
    isSidebarAutoHidden,
    isSidebarOpen,
    isSidebarPinnedOpen,
    isTerminalExpanded,
    isTerminalOpen,
    openSidebarPreview,
    scheduleSidebarPreviewClose,
    shouldClampChatPaneForEditor,
    showHeaderSidebarToggle,
    showPinnedSidebarToggle,
    showSidebarPreview,
    generalTerminalFocusRequest,
    terminalFocusRequest,
    toggleEditor,
    toggleEditorExpanded,
    toggleGeneralTerminal,
    toggleSidebar,
    toggleTerminal,
    toggleTerminalExpanded,
  };
};

export const ChatPage = ({ connectionSettingsButton }: ChatPageProps = {}) => {
  const resourceId = useChatStore(state => state.resourceId);
  const threadId = useChatStore(state => state.threadId);
  const threads = useChatStore(state => state.threads);
  const activePlan = useChatStore(state => state.threadPlans[threadId]);
  const showPlanPanel = useChatStore(state => state.showPlanPanel);
  const runningThreadIds = useChatStore(state => state.runningThreadIds);
  const setServerThreads = useChatStore(state => state.setServerThreads);
  const newThread = useChatStore(state => state.newThread);
  const setShowPlanPanel = useChatStore(state => state.setShowPlanPanel);
  const queryClient = useQueryClient();
  const [pageRef, pageWidth] = useMeasuredElementWidth();
  const sidebarSurfaceRef = useRef<HTMLElement | null>(null);
  const chatSurfaceRef = useRef<HTMLDivElement | null>(null);
  const showToolCalls = useChatStore(state => state.showToolCalls);
  const setShowToolCalls = useChatStore(state => state.setShowToolCalls);
  const isPortraitViewport = useIsPortraitViewport();
  const isElectronWindow = isElectronWindowNow();
  const activeThread = threads.find(thread => thread.id === threadId);
  const hasThreadTitle = Boolean(activeThread && !['New chat', '...'].includes(activeThread.title));
  const { data: projects = [] } = useQuery({
    queryKey: ['projects', resourceId],
    queryFn: () => listProjects(),
  });
  const { data: portals = [] } = useQuery({
    queryKey: ['portals', resourceId],
    queryFn: listPortals,
  });
  const onlinePortals = portals.filter(portal => portal.status === 'online');
  const onlinePortalIds = new Set(onlinePortals.map(portal => portal.portalId));
  const defaultGlobalPortal = onlinePortals[0];
  const defaultGlobalRootId = defaultGlobalPortal?.roots[0]?.id ?? 'default';
  const activeProject = activeThread?.projectId ? projects.find(project => project.id === activeThread.projectId) : undefined;
  const activeWorkspace = activeThread?.workspaceId
    ? activeProject?.workspaces.find(workspace => workspace.id === activeThread.workspaceId)
    : undefined;
  const activeWorkspacePortalId = activeWorkspace?.portalId ?? activeProject?.portalId;
  const activeGitWorkspaceTarget = activeProject?.projectKind === 'git' && activeWorkspace
    ? {
        kind: 'workspace' as const,
        terminalId: activeWorkspace.id,
        projectId: activeProject.id,
        workspaceId: activeWorkspace.id,
        portalId: activeWorkspacePortalId,
        rootId: activeProject.portalRootId,
        repoPath: activeProject.repoPath,
        workspacePath: activeWorkspace.path,
        projectName: activeProject.name,
        workspaceName: activeWorkspace.name,
        title: `${activeProject.name} / ${activeWorkspace.name}`,
      }
    : undefined;
  const hasDesktopTerminalTransport = isDesktopTerminalTransportAvailable();
  const hasAnyTerminalTransport = isTerminalTransportAvailable();
  const hasOnlinePortalForActiveWorkspace = Boolean(activeWorkspacePortalId && onlinePortalIds.has(activeWorkspacePortalId));
  const generalTerminalTarget = hasAnyTerminalTransport && (defaultGlobalPortal || (isElectronWindow && hasDesktopTerminalTransport))
    ? {
        kind: 'general' as const,
        terminalId: generalTerminalId,
        portalId: defaultGlobalPortal?.portalId,
        rootId: defaultGlobalRootId,
        title: 'Weave Terminal',
      }
    : undefined;
  const terminalTarget = hasAnyTerminalTransport && (hasOnlinePortalForActiveWorkspace || (isElectronWindow && hasDesktopTerminalTransport))
    ? activeGitWorkspaceTarget
    : undefined;
  const hasDesktopEditorBackend = isDesktopEditorBackendAvailable();
  const editorTarget = isEditorBackendAvailable() && (hasOnlinePortalForActiveWorkspace || (isElectronWindow && hasDesktopEditorBackend))
    ? activeGitWorkspaceTarget
    : undefined;
  const terminalWorkspaceId = terminalTarget?.workspaceId;
  const terminalTargetKey = terminalTarget?.terminalId;
  const [generalTerminalTabs, setGeneralTerminalTabs] = useState<TerminalPanelTab[]>(() => []);
  const [activeGeneralTerminalTabId, setActiveGeneralTerminalTabId] = useState(() => getPrimaryTerminalTabId(generalTerminalId));
  const [terminalTabsByTarget, setTerminalTabsByTarget] = useState<Record<string, TerminalPanelTab[]>>({});
  const [activeTerminalTabByTarget, setActiveTerminalTabByTarget] = useState<Record<string, string>>({});
  const windowSurfaces = useWindowSurfaces({
    editorTargetKey: editorTarget?.workspaceId,
    hasGeneralTerminalTarget: Boolean(generalTerminalTarget),
    isPortraitViewport,
    pageWidth,
    terminalWorkspaceId,
  });
  const {
    closeSidebar,
    closeSidebarPreview,
    editorFocusRequest,
    focusEditor,
    focusGeneralTerminal,
    focusTerminal,
    handleEditorExpandedChange,
    handleGeneralTerminalSessionActiveChange,
    handleTerminalExpandedChange,
    handleTerminalSessionActiveChange,
    hasActiveTerminal,
    hasEditorTarget,
    hasGeneralTerminalTarget,
    hasTerminalTarget,
    hideEditor,
    hideGeneralTerminal,
    hideTerminal,
    isEditorExpanded,
    isEditorOpen,
    isGeneralTerminalActive,
    isGeneralTerminalOpen,
    isSidebarAutoHidden,
    isSidebarOpen,
    isSidebarPinnedOpen,
    isTerminalExpanded,
    isTerminalOpen,
    openSidebarPreview,
    scheduleSidebarPreviewClose,
    shouldClampChatPaneForEditor,
    showHeaderSidebarToggle,
    showPinnedSidebarToggle,
    showSidebarPreview,
    generalTerminalFocusRequest,
    terminalFocusRequest,
    toggleEditor,
    toggleEditorExpanded,
    toggleGeneralTerminal,
    toggleSidebar,
    toggleTerminal,
    toggleTerminalExpanded,
  } = windowSurfaces;
  const terminalTabs = terminalTargetKey ? terminalTabsByTarget[terminalTargetKey] ?? [] : [];
  const activeTerminalTabId = terminalTargetKey
    ? activeTerminalTabByTarget[terminalTargetKey] ?? terminalTabs[0]?.id
    : undefined;

  const handleTerminalTabsChange = useCallback((tabsChange: TerminalPanelTabsChange) => {
    if (!terminalTargetKey) return;
    setTerminalTabsByTarget(current => {
      const currentTabs = current[terminalTargetKey] ?? [];
      const nextTabs = typeof tabsChange === 'function' ? tabsChange(currentTabs) : tabsChange;
      if (nextTabs === currentTabs) return current;
      return { ...current, [terminalTargetKey]: nextTabs };
    });
  }, [terminalTargetKey]);

  const handleActiveTerminalTabChange = useCallback((tabId: string) => {
    if (!terminalTargetKey) return;
    setActiveTerminalTabByTarget(current => ({ ...current, [terminalTargetKey]: tabId }));
  }, [terminalTargetKey]);

  const createTerminalTab = useCallback((ordinal: number) => (
    createTerminalPanelTab(terminalTargetKey ?? 'weave-terminal', ordinal)
  ), [terminalTargetKey]);

  const createGeneralTerminalTab = useCallback((ordinal: number) => (
    createTerminalPanelTab(generalTerminalId, ordinal)
  ), []);
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
    handleTerminalExpandedChange(false);
    handleEditorExpandedChange(false);
    window.requestAnimationFrame(() => {
      chatSurfaceRef.current
        ?.querySelector<HTMLTextAreaElement>('[data-weave-active-thread="true"] textarea:not([disabled])')
        ?.focus();
    });
  }, [handleEditorExpandedChange, handleTerminalExpandedChange]);

  const createThreadFromShortcut = useCallback(() => {
    void newThread()
      .then(() => queryClient.invalidateQueries({ queryKey: ['threads', resourceId] }))
      .then(() => focusChat());
  }, [focusChat, newThread, queryClient, resourceId]);
  const handleGeneralTerminalToggle = useCallback(() => {
    const shouldFocusAfterOpen = !isGeneralTerminalOpen;
    toggleGeneralTerminal();
    if (shouldFocusAfterOpen) window.requestAnimationFrame(focusGeneralTerminal);
  }, [focusGeneralTerminal, isGeneralTerminalOpen, toggleGeneralTerminal]);

  const shortcutCommands = useMemo<ShortcutCommand[]>(() => [
    {
      id: 'shortcuts.open',
      label: 'Open shortcuts',
      surface: 'app',
      run: () => undefined,
    },
    {
      id: 'sidebar.toggle',
      label: 'Toggle sidebar',
      surface: 'sidebar',
      run: () => {
        const shouldFocusAfterOpen = !isSidebarOpen && !showSidebarPreview;
        toggleSidebar();
        if (shouldFocusAfterOpen) focusSidebar();
      },
    },
    {
      id: 'chat.focus',
      label: 'Focus chat',
      surface: 'chat',
      run: focusChat,
    },
    {
      id: 'thread.new',
      label: 'New thread',
      surface: 'chat',
      run: createThreadFromShortcut,
    },
    {
      id: 'plan.toggle',
      label: 'Toggle plan',
      surface: 'plan',
      run: () => setShowPlanPanel(!showPlanPanel),
    },
    {
      id: 'terminal.globalToggle',
      label: 'Toggle global terminal',
      surface: 'terminal',
      isEnabled: () => hasGeneralTerminalTarget,
      run: handleGeneralTerminalToggle,
    },
    {
      id: 'terminal.toggle',
      label: 'Toggle terminal pane',
      surface: 'terminal',
      isEnabled: () => hasTerminalTarget,
      run: () => {
        const shouldFocusAfterOpen = !isTerminalOpen;
        toggleTerminal();
        if (shouldFocusAfterOpen) window.requestAnimationFrame(focusTerminal);
      },
    },
    {
      id: 'terminal.expandToggle',
      label: 'Expand terminal pane',
      surface: 'terminal',
      isEnabled: () => hasTerminalTarget,
      run: () => {
        toggleTerminalExpanded();
        window.requestAnimationFrame(focusTerminal);
      },
    },
    {
      id: 'editor.toggle',
      label: 'Toggle editor pane',
      surface: 'editor',
      isEnabled: () => hasEditorTarget,
      run: () => {
        const shouldFocusAfterOpen = !isEditorOpen;
        toggleEditor();
        if (shouldFocusAfterOpen) window.requestAnimationFrame(focusEditor);
      },
    },
    {
      id: 'editor.expandToggle',
      label: 'Expand editor pane',
      surface: 'editor',
      isEnabled: () => hasEditorTarget,
      run: () => {
        toggleEditorExpanded();
        window.requestAnimationFrame(focusEditor);
      },
    },
  ], [
    createThreadFromShortcut,
    focusChat,
    focusEditor,
    focusSidebar,
    focusTerminal,
    handleGeneralTerminalToggle,
    hasEditorTarget,
    hasGeneralTerminalTarget,
    hasTerminalTarget,
    isEditorOpen,
    isSidebarOpen,
    isTerminalOpen,
    setShowPlanPanel,
    showPlanPanel,
    showSidebarPreview,
    toggleEditor,
    toggleEditorExpanded,
    toggleSidebar,
    toggleTerminal,
    toggleTerminalExpanded,
  ]);
  const isSidebarSurfaceVisible = isSidebarOpen || showSidebarPreview;
  const shouldRenderFloatingLeftActions = (isElectronWindow || isSidebarSurfaceVisible)
    && (showHeaderSidebarToggle || showPinnedSidebarToggle || Boolean(generalTerminalTarget));
  const shouldRenderHeaderLeftActions = !isElectronWindow
    && !isSidebarSurfaceVisible
    && (showHeaderSidebarToggle || Boolean(generalTerminalTarget));
  const sidebarToggleHoverHandlers = isPortraitViewport
    ? {}
    : {
        onMouseEnter: openSidebarPreview,
        onMouseLeave: scheduleSidebarPreviewClose,
      };
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
        isGeneralTerminalActive ? 'text-mauve' : '',
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

  return (
    <ShortcutProvider commands={shortcutCommands}>
      <div ref={pageRef} className="weave-app-shell box-border flex overflow-hidden pt-[var(--weave-safe-area-top)]" data-weave-surface="app">
      {isSidebarOpen ? (
        <>
          <button
            className="fixed inset-0 z-30 bg-background/80 md:hidden"
            aria-label="Close sidebar"
            onClick={closeSidebar}
          />
          <ThreadSidebar
            ref={sidebarSurfaceRef}
            closeOnSelect={isPortraitViewport}
            connectionSettingsButton={connectionSettingsButton}
            onClose={closeSidebar}
          />
        </>
      ) : null}
      {showSidebarPreview ? (
        <div
          data-weave-sidebar-preview
          {...(!isPortraitViewport
            ? {
                onMouseEnter: openSidebarPreview,
                onMouseLeave: scheduleSidebarPreviewClose,
              }
            : {})}
        >
          {isPortraitViewport ? (
            <button
              className="fixed inset-0 z-30 bg-background/80"
              aria-label="Close sidebar"
              onClick={closeSidebarPreview}
            />
          ) : null}
          <ThreadSidebar
            ref={sidebarSurfaceRef}
            presentation="overlay"
            closeOnSelect
            connectionSettingsButton={connectionSettingsButton}
            onClose={closeSidebarPreview}
          />
        </div>
      ) : null}
      {shouldRenderFloatingLeftActions ? (
        <div
          className="weave-appbar-left-actions-floating flex items-center"
          data-has-sidebar-toggle={showHeaderSidebarToggle || showPinnedSidebarToggle ? 'true' : 'false'}
        >
          {showHeaderSidebarToggle || showPinnedSidebarToggle ? renderSidebarToggleButton() : null}
          {renderGeneralTerminalButton()}
        </div>
      ) : null}
      <main
        className="flex min-w-0 flex-1 flex-col"
        data-sidebar-open={isSidebarOpen ? 'true' : 'false'}
        data-sidebar-pinned-open={isSidebarPinnedOpen ? 'true' : 'false'}
        data-sidebar-auto-hidden={isSidebarAutoHidden ? 'true' : 'false'}
        data-sidebar-preview-open={showSidebarPreview ? 'true' : 'false'}
      >
        <header className="relative z-20 flex h-14 shrink-0 items-center justify-center border-b border-border bg-background px-4">
          {shouldRenderHeaderLeftActions ? (
            <div className="weave-appbar-left-actions absolute left-4 flex items-center gap-2">
              {showHeaderSidebarToggle ? renderSidebarToggleButton() : null}
              {renderGeneralTerminalButton()}
            </div>
          ) : null}
          {activeProject || hasThreadTitle ? (
            <h2 className="flex max-w-[60%] items-center justify-center gap-1 truncate text-center text-sm font-semibold text-foreground">
              {activeProject ? (
                <>
                  <span className="min-w-0 truncate text-success">{activeProject.name}</span>
                  {activeWorkspace ? (
                    <>
                      <span className="shrink-0 text-muted-foreground">/</span>
                      <span className="min-w-0 truncate text-peach">{activeWorkspace.name}</span>
                    </>
                  ) : null}
                  {hasThreadTitle ? <span className="shrink-0 text-muted-foreground">/</span> : null}
                </>
              ) : null}
              {hasThreadTitle ? <span className="min-w-0 truncate text-foreground">{activeThread?.title}</span> : null}
            </h2>
          ) : null}
          <div className="absolute right-4 flex items-center gap-3">
            {terminalTarget ? (
              <Button
                className={[
                  isTerminalOpen ? 'bg-accent' : '',
                  hasActiveTerminal ? 'text-mauve' : '',
                ].filter(Boolean).join(' ')}
                size="icon"
                variant="ghost"
                aria-label={isTerminalOpen ? 'Hide terminal' : 'Show terminal'}
                data-active={isTerminalOpen ? 'true' : 'false'}
                onClick={toggleTerminal}
              >
                <TerminalSquare size={18} />
                <TerminalTabCountBadge count={terminalTabs.length} />
              </Button>
            ) : null}
            {editorTarget ? (
              <Button
                className={isEditorOpen ? 'bg-accent' : ''}
                size="icon"
                variant="ghost"
                aria-label={isEditorOpen ? 'Hide editor' : 'Show editor'}
                data-active={isEditorOpen ? 'true' : 'false'}
                onClick={toggleEditor}
              >
                <Code2 size={18} />
              </Button>
            ) : null}
            <Menu>
              <MenuTrigger
                render={<Button size="icon" variant="ghost" aria-label="Chat settings" />}
              >
                <Settings size={18} />
              </MenuTrigger>
              <MenuPopup align="end" sideOffset={8} className="w-56">
                <MenuCheckboxItem
                  checked={showToolCalls}
                  variant="switch"
                  onCheckedChange={checked => setShowToolCalls(checked)}
                >
                  Show tool calls
                </MenuCheckboxItem>
              </MenuPopup>
            </Menu>
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <div className={isEditorExpanded
            ? 'flex w-0 min-w-0 flex-none flex-col overflow-hidden'
            : shouldClampChatPaneForEditor
              ? 'flex min-h-0 min-w-0 w-[var(--weave-chat-content-max-width)] max-w-full shrink-0 flex-col overflow-hidden'
            : isEditorOpen
              ? 'flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden'
            : 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'}
          >
            <div
              ref={chatSurfaceRef}
              className={isTerminalExpanded
                ? 'relative h-0 min-h-0 flex-none overflow-hidden'
                : 'relative min-h-0 flex-1 overflow-hidden'}
              data-weave-chat-pane
              data-weave-surface="chat"
            >
              {threads
                .filter(thread => thread.id === threadId || runningThreadIds.includes(thread.id))
                .map(thread => (
                  <div
                    key={thread.id}
                    className={thread.id === threadId ? 'absolute inset-0' : 'absolute inset-0 hidden'}
                    data-weave-active-thread={thread.id === threadId ? 'true' : 'false'}
                  >
                    <AssistantChat threadId={thread.id} />
                  </div>
                ))}
              {showPlanPanel ? <PlanSidebar plan={activePlan} /> : null}
            </div>
            {isTerminalOpen && terminalTarget ? (
              <Suspense fallback={null}>
                <TerminalPanel
                  activeTabId={activeTerminalTabId}
                  focusRequest={terminalFocusRequest}
                  isExpanded={isTerminalExpanded}
                  onActiveTabIdChange={handleActiveTerminalTabChange}
                  onCreateTab={createTerminalTab}
                  onExpandedChange={handleTerminalExpandedChange}
                  onSessionActiveChange={handleTerminalSessionActiveChange}
                  onTabsChange={handleTerminalTabsChange}
                  tabs={terminalTabs}
                  target={terminalTarget}
                  onHide={hideTerminal}
                />
              </Suspense>
            ) : null}
          </div>
          {isEditorOpen && editorTarget ? (
            <Suspense fallback={null}>
              <EditorPanel
                focusRequest={editorFocusRequest}
                isExpanded={isEditorExpanded}
                onExpandedChange={handleEditorExpandedChange}
                target={editorTarget}
                onHide={hideEditor}
              />
            </Suspense>
          ) : null}
        </div>
      </main>
      {isGeneralTerminalOpen && generalTerminalTarget ? (
        <div
          className="pointer-events-none fixed inset-0 z-50 bg-background/20 backdrop-blur-sm"
          data-weave-general-terminal-overlay
        >
          <div
            className="pointer-events-auto absolute inset-0 min-h-0 min-w-0"
          >
            <Suspense fallback={null}>
              <TerminalPanel
                activeTabId={activeGeneralTerminalTabId}
                focusRequest={generalTerminalFocusRequest}
                isExpanded={false}
                onActiveTabIdChange={setActiveGeneralTerminalTabId}
                onCreateTab={createGeneralTerminalTab}
                onSessionActiveChange={handleGeneralTerminalSessionActiveChange}
                onTabsChange={setGeneralTerminalTabs}
                tabs={generalTerminalTabs}
                target={generalTerminalTarget}
                onHide={hideGeneralTerminal}
                variant="overlay"
              />
            </Suspense>
          </div>
        </div>
      ) : null}
    </div>
    </ShortcutProvider>
  );
};
