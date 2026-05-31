import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Code2, PanelLeft, Settings, TerminalSquare } from 'lucide-react';
import { listPlanes, listServerThreads } from '../../lib/chat-state-api';
import { isEditorBackendAvailable } from '../../lib/editor-backend';
import { isDesktopTerminalTransportAvailable } from '../../lib/terminal-transport';
import { useChatStore } from '../../stores/chat-store';
import { Button } from '../ui/button';
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from '../ui/menu';
import { AssistantChat } from './AssistantChat';
import { PlanSidebar } from './PlanSidebar';
import { ThreadSidebar } from './ThreadSidebar';

const TerminalPanel = lazy(() => import('./TerminalPanel').then(module => ({ default: module.TerminalPanel })));
const EditorPanel = lazy(() => import('./EditorPanel').then(module => ({ default: module.EditorPanel })));

const isMobilePortraitNow = () => window.matchMedia('(max-width: 767px) and (orientation: portrait)').matches;
const isElectronWindowNow = () =>
  typeof document !== 'undefined' && document.documentElement.dataset.weaveWindowType === 'electron';
const chatContentMaxWidthPx = 48 * 16;
const threadSidebarWidthPx = 24 * 16;

const useIsMobilePortrait = () => {
  const [isMobilePortrait, setIsMobilePortrait] = useState(() => isMobilePortraitNow());

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px) and (orientation: portrait)');
    const sync = () => setIsMobilePortrait(mediaQuery.matches);

    sync();
    mediaQuery.addEventListener('change', sync);
    return () => mediaQuery.removeEventListener('change', sync);
  }, []);

  return isMobilePortrait;
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

export const ChatPage = ({ connectionSettingsButton }: ChatPageProps = {}) => {
  const resourceId = useChatStore(state => state.resourceId);
  const threadId = useChatStore(state => state.threadId);
  const threads = useChatStore(state => state.threads);
  const activePlan = useChatStore(state => state.threadPlans[threadId]);
  const showPlanPanel = useChatStore(state => state.showPlanPanel);
  const runningThreadIds = useChatStore(state => state.runningThreadIds);
  const setServerThreads = useChatStore(state => state.setServerThreads);
  const newThread = useChatStore(state => state.newThread);
  const [pageRef, pageWidth] = useMeasuredElementWidth();
  const [isSidebarPinnedOpen, setIsSidebarPinnedOpen] = useState(() => !isMobilePortraitNow());
  const [isSidebarPreviewOpen, setIsSidebarPreviewOpen] = useState(false);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [isTerminalExpanded, setIsTerminalExpanded] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isEditorExpanded, setIsEditorExpanded] = useState(false);
  const [activeTerminalDemiplaneIds, setActiveTerminalDemiplaneIds] = useState<Set<string>>(() => new Set());
  const sidebarPreviewCloseTimeoutRef = useRef<number | undefined>(undefined);
  const showToolCalls = useChatStore(state => state.showToolCalls);
  const setShowToolCalls = useChatStore(state => state.setShowToolCalls);
  const isMobilePortrait = useIsMobilePortrait();
  const isElectronWindow = isElectronWindowNow();
  const workspaceWidthWithPinnedSidebar = Math.max(0, pageWidth - threadSidebarWidthPx);
  const wouldAutoHideSidebarIfPinned = isEditorOpen && !isMobilePortrait && workspaceWidthWithPinnedSidebar < chatContentMaxWidthPx * 2;
  const isSidebarAutoHidden = isSidebarPinnedOpen && wouldAutoHideSidebarIfPinned;
  const isSidebarOpen = isSidebarPinnedOpen && !isSidebarAutoHidden;
  const canPreviewSidebar = isElectronWindow && !isMobilePortrait && !isSidebarOpen;
  const showSidebarPreview = canPreviewSidebar && isSidebarPreviewOpen;
  const showPinnedSidebarToggle = isElectronWindow && !isMobilePortrait && isSidebarOpen;
  const showHeaderSidebarToggle = !isElectronWindow || !isSidebarOpen;
  const activeThread = threads.find(thread => thread.id === threadId);
  const hasThreadTitle = Boolean(activeThread && !['New chat', '...'].includes(activeThread.title));
  const { data: planes = [] } = useQuery({
    queryKey: ['planes', resourceId],
    queryFn: () => listPlanes(),
  });
  const activePlane = activeThread?.planeId ? planes.find(plane => plane.id === activeThread.planeId) : undefined;
  const activeDemiplane = activeThread?.demiplaneId
    ? activePlane?.demiplanes.find(demiplane => demiplane.id === activeThread.demiplaneId)
    : undefined;
  const activeGitDemiplaneTarget = activePlane?.projectKind === 'git' && activeDemiplane
    ? {
        planeId: activePlane.id,
        demiplaneId: activeDemiplane.id,
        planeName: activePlane.name,
        demiplaneName: activeDemiplane.name,
      }
    : undefined;
  const terminalTarget = isElectronWindow && isDesktopTerminalTransportAvailable()
    ? activeGitDemiplaneTarget
    : undefined;
  const editorTarget = isElectronWindow && isEditorBackendAvailable()
    ? activeGitDemiplaneTarget
    : undefined;
  const terminalDemiplaneId = terminalTarget?.demiplaneId;
  const hasActiveTerminal = terminalDemiplaneId ? activeTerminalDemiplaneIds.has(terminalDemiplaneId) : false;
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

  useEffect(() => {
    if (isMobilePortrait && activeThread) setIsSidebarPinnedOpen(false);
  }, [activeThread, isMobilePortrait]);

  useEffect(() => {
    if (isSidebarOpen || isMobilePortrait) setIsSidebarPreviewOpen(false);
  }, [isMobilePortrait, isSidebarOpen]);

  useEffect(() => {
    setIsTerminalExpanded(false);
    if (!terminalTarget) {
      setIsTerminalOpen(false);
    }
  }, [terminalTarget?.demiplaneId]);

  useEffect(() => {
    setIsEditorExpanded(false);
    if (!editorTarget) {
      setIsEditorOpen(false);
    }
  }, [editorTarget?.demiplaneId]);

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
    if (!isSidebarOpen && wouldAutoHideSidebarIfPinned) {
      setIsSidebarPinnedOpen(true);
      setIsSidebarPreviewOpen(open => !open);
      return;
    }

    setIsSidebarPreviewOpen(false);
    setIsSidebarPinnedOpen(open => !open);
  }, [clearSidebarPreviewCloseTimeout, isSidebarOpen, wouldAutoHideSidebarIfPinned]);

  const openSidebar = useCallback(() => {
    clearSidebarPreviewCloseTimeout();
    if (wouldAutoHideSidebarIfPinned) {
      setIsSidebarPinnedOpen(true);
      setIsSidebarPreviewOpen(true);
      return;
    }

    setIsSidebarPreviewOpen(false);
    setIsSidebarPinnedOpen(true);
  }, [clearSidebarPreviewCloseTimeout, wouldAutoHideSidebarIfPinned]);

  const toggleTerminal = useCallback(() => {
    if (isTerminalOpen) setIsTerminalExpanded(false);
    setIsEditorExpanded(false);
    setIsTerminalOpen(open => !open);
  }, [isTerminalOpen]);

  const hideTerminal = useCallback(() => {
    setIsTerminalOpen(false);
    setIsTerminalExpanded(false);
  }, []);

  const toggleEditor = useCallback(() => {
    if (isEditorOpen) setIsEditorExpanded(false);
    setIsTerminalExpanded(false);
    setIsEditorOpen(open => !open);
  }, [isEditorOpen]);

  const hideEditor = useCallback(() => {
    setIsEditorOpen(false);
    setIsEditorExpanded(false);
  }, []);

  const handleTerminalExpandedChange = useCallback((nextExpanded: boolean) => {
    setIsTerminalExpanded(nextExpanded);
    if (nextExpanded) setIsEditorExpanded(false);
  }, []);

  const handleEditorExpandedChange = useCallback((nextExpanded: boolean) => {
    setIsEditorExpanded(nextExpanded);
    if (nextExpanded) setIsTerminalExpanded(false);
  }, []);

  const handleTerminalSessionActiveChange = useCallback((isActive: boolean) => {
    if (!terminalDemiplaneId) return;
    setActiveTerminalDemiplaneIds(current => {
      const isCurrentlyActive = current.has(terminalDemiplaneId);
      if (isCurrentlyActive === isActive) return current;

      const next = new Set(current);
      if (isActive) {
        next.add(terminalDemiplaneId);
      } else {
        next.delete(terminalDemiplaneId);
      }
      return next;
    });
  }, [terminalDemiplaneId]);

  return (
    <div ref={pageRef} className="flex h-dvh overflow-hidden">
      {isSidebarOpen ? (
        <>
          <button
            className="fixed inset-0 z-30 bg-background/80 md:hidden"
            aria-label="Close sidebar"
            onClick={() => setIsSidebarPinnedOpen(false)}
          />
          {showPinnedSidebarToggle ? (
            <Button
              className="weave-desktop-sidebar-toggle"
              size="icon"
              variant="ghost"
              aria-label="Hide sidebar"
              onClick={toggleSidebar}
            >
              <PanelLeft size={18} />
            </Button>
          ) : null}
          <ThreadSidebar
            closeOnSelect={isMobilePortrait}
            connectionSettingsButton={connectionSettingsButton}
            onClose={() => setIsSidebarPinnedOpen(false)}
          />
        </>
      ) : null}
      {showSidebarPreview ? (
        <div
          data-weave-sidebar-preview
          onMouseEnter={openSidebarPreview}
          onMouseLeave={scheduleSidebarPreviewClose}
        >
          <Button
            className="weave-desktop-sidebar-toggle"
            size="icon"
            variant="ghost"
            aria-label="Show sidebar"
            onClick={openSidebar}
          >
            <PanelLeft size={18} />
          </Button>
          <ThreadSidebar
            presentation="overlay"
            closeOnSelect
            connectionSettingsButton={connectionSettingsButton}
            onClose={closeSidebarPreview}
          />
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
          {showHeaderSidebarToggle ? (
            <Button
              className="absolute left-4"
              size="icon"
              variant="ghost"
              aria-label={isSidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
              onClick={toggleSidebar}
              onMouseEnter={openSidebarPreview}
              onMouseLeave={scheduleSidebarPreviewClose}
            >
              <PanelLeft size={18} />
            </Button>
          ) : null}
          {activePlane || hasThreadTitle ? (
            <h2 className="flex max-w-[60%] items-center justify-center gap-1 truncate text-center text-sm font-semibold text-foreground">
              {activePlane ? (
                <>
                  <span className="min-w-0 truncate text-mauve">{activePlane.name}</span>
                  {activeDemiplane ? (
                    <>
                      <span className="shrink-0 text-muted-foreground">/</span>
                      <span className="min-w-0 truncate text-primary">{activeDemiplane.name}</span>
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
            : isSidebarAutoHidden
              ? 'flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden'
            : 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'}
          >
            <div
              className={isTerminalExpanded
                ? 'relative h-0 min-h-0 flex-none overflow-hidden'
                : 'relative min-h-0 flex-1 overflow-hidden'}
              data-weave-chat-pane
            >
              {threads
                .filter(thread => thread.id === threadId || runningThreadIds.includes(thread.id))
                .map(thread => (
                  <div
                    key={thread.id}
                    className={thread.id === threadId ? 'absolute inset-0' : 'absolute inset-0 hidden'}
                  >
                    <AssistantChat threadId={thread.id} />
                  </div>
                ))}
              {showPlanPanel ? <PlanSidebar plan={activePlan} /> : null}
            </div>
            {isTerminalOpen && terminalTarget ? (
              <Suspense fallback={null}>
                <TerminalPanel
                  isExpanded={isTerminalExpanded}
                  onExpandedChange={handleTerminalExpandedChange}
                  onSessionActiveChange={handleTerminalSessionActiveChange}
                  target={terminalTarget}
                  onHide={hideTerminal}
                />
              </Suspense>
            ) : null}
          </div>
          {isEditorOpen && editorTarget ? (
            <Suspense fallback={null}>
              <EditorPanel
                isExpanded={isEditorExpanded}
                isBalancedWidth={isSidebarAutoHidden}
                onExpandedChange={handleEditorExpandedChange}
                target={editorTarget}
                onHide={hideEditor}
              />
            </Suspense>
          ) : null}
        </div>
      </main>
    </div>
  );
};
