import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PanelLeft, Settings, TerminalSquare } from 'lucide-react';
import { listPlanes, listServerThreads } from '../../lib/chat-state-api';
import { isDesktopTerminalTransportAvailable } from '../../lib/terminal-transport';
import { useChatStore } from '../../stores/chat-store';
import { Button } from '../ui/button';
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from '../ui/menu';
import { AssistantChat } from './AssistantChat';
import { PlanSidebar } from './PlanSidebar';
import { ThreadSidebar } from './ThreadSidebar';

const TerminalPanel = lazy(() => import('./TerminalPanel').then(module => ({ default: module.TerminalPanel })));

const isMobilePortraitNow = () => window.matchMedia('(max-width: 767px) and (orientation: portrait)').matches;
const isElectronWindowNow = () =>
  typeof document !== 'undefined' && document.documentElement.dataset.weaveWindowType === 'electron';

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

export const ChatPage = () => {
  const resourceId = useChatStore(state => state.resourceId);
  const threadId = useChatStore(state => state.threadId);
  const threads = useChatStore(state => state.threads);
  const activePlan = useChatStore(state => state.threadPlans[threadId]);
  const showPlanPanel = useChatStore(state => state.showPlanPanel);
  const runningThreadIds = useChatStore(state => state.runningThreadIds);
  const setServerThreads = useChatStore(state => state.setServerThreads);
  const newThread = useChatStore(state => state.newThread);
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => !isMobilePortraitNow());
  const [isSidebarPreviewOpen, setIsSidebarPreviewOpen] = useState(false);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [isTerminalExpanded, setIsTerminalExpanded] = useState(false);
  const [activeTerminalDemiplaneIds, setActiveTerminalDemiplaneIds] = useState<Set<string>>(() => new Set());
  const sidebarPreviewCloseTimeoutRef = useRef<number | undefined>(undefined);
  const showToolCalls = useChatStore(state => state.showToolCalls);
  const setShowToolCalls = useChatStore(state => state.setShowToolCalls);
  const isMobilePortrait = useIsMobilePortrait();
  const isElectronWindow = isElectronWindowNow();
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
  const terminalTarget = isElectronWindow
    && isDesktopTerminalTransportAvailable()
    && activePlane?.projectKind === 'git'
    && activeDemiplane
    ? {
        planeId: activePlane.id,
        demiplaneId: activeDemiplane.id,
        planeName: activePlane.name,
        demiplaneName: activeDemiplane.name,
      }
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
    if (isMobilePortrait && activeThread) setIsSidebarOpen(false);
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
    closeSidebarPreview();
    setIsSidebarOpen(open => !open);
  }, [closeSidebarPreview]);

  const openSidebar = useCallback(() => {
    closeSidebarPreview();
    setIsSidebarOpen(true);
  }, [closeSidebarPreview]);

  const toggleTerminal = useCallback(() => {
    if (isTerminalOpen) setIsTerminalExpanded(false);
    setIsTerminalOpen(open => !open);
  }, [isTerminalOpen]);

  const hideTerminal = useCallback(() => {
    setIsTerminalOpen(false);
    setIsTerminalExpanded(false);
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
    <div className="flex h-dvh overflow-hidden">
      {isSidebarOpen ? (
        <>
          <button
            className="fixed inset-0 z-30 bg-background/80 md:hidden"
            aria-label="Close sidebar"
            onClick={() => setIsSidebarOpen(false)}
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
          <ThreadSidebar closeOnSelect={isMobilePortrait} onClose={() => setIsSidebarOpen(false)} />
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
          <ThreadSidebar presentation="overlay" closeOnSelect onClose={closeSidebarPreview} />
        </div>
      ) : null}
      <main
        className="flex min-w-0 flex-1 flex-col"
        data-sidebar-open={isSidebarOpen ? 'true' : 'false'}
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
          {terminalTarget ? (
            <Button
              className={[
                'absolute right-28',
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
          <Menu>
            <MenuTrigger
              className="absolute right-4"
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
        </header>
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className={isTerminalExpanded ? 'relative h-0 min-h-0 flex-none overflow-hidden' : 'relative min-h-0 flex-1 overflow-hidden'}>
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
            </div>
            {isTerminalOpen && terminalTarget ? (
              <Suspense fallback={null}>
                <TerminalPanel
                  isExpanded={isTerminalExpanded}
                  onExpandedChange={setIsTerminalExpanded}
                  onSessionActiveChange={handleTerminalSessionActiveChange}
                  target={terminalTarget}
                  onHide={hideTerminal}
                />
              </Suspense>
            ) : null}
          </div>
          {showPlanPanel ? <PlanSidebar plan={activePlan} /> : null}
        </div>
      </main>
    </div>
  );
};
