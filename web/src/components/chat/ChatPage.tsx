import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PanelLeft, Settings } from 'lucide-react';
import { listPlanes, listServerThreads } from '../../lib/chat-state-api';
import { useChatStore } from '../../stores/chat-store';
import { AssistantChat } from './AssistantChat';
import { ThreadSidebar } from './ThreadSidebar';

const isMobilePortraitNow = () => window.matchMedia('(max-width: 767px) and (orientation: portrait)').matches;

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
  const runningThreadIds = useChatStore(state => state.runningThreadIds);
  const setServerThreads = useChatStore(state => state.setServerThreads);
  const newThread = useChatStore(state => state.newThread);
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => !isMobilePortraitNow());
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const showToolCalls = useChatStore(state => state.showToolCalls);
  const setShowToolCalls = useChatStore(state => state.setShowToolCalls);
  const isMobilePortrait = useIsMobilePortrait();
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
  const { data: serverThreads = [], isFetched } = useQuery({
    queryKey: ['threads', resourceId],
    queryFn: () => listServerThreads(),
  });

  useEffect(() => {
    if (!isSettingsOpen) return undefined;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!settingsMenuRef.current?.contains(event.target as Node)) {
        setIsSettingsOpen(false);
      }
    };

    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [isSettingsOpen]);

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

  return (
    <div className="flex h-dvh overflow-hidden">
      {isSidebarOpen ? (
        <>
          <button
            className="fixed inset-0 z-30 bg-black/30 backdrop-blur-sm md:hidden"
            aria-label="Close sidebar"
            onClick={() => setIsSidebarOpen(false)}
          />
          <ThreadSidebar closeOnSelect={isMobilePortrait} onClose={() => setIsSidebarOpen(false)} />
        </>
      ) : null}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="relative z-20 flex h-14 shrink-0 items-center justify-center border-b border-border bg-background/80 px-4">
          <button
            className="absolute left-4 rounded-lg p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label={isSidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            onClick={() => setIsSidebarOpen(open => !open)}
          >
            <PanelLeft size={18} />
          </button>
          {activePlane || hasThreadTitle ? (
            <h2 className="flex max-w-[60%] items-center justify-center gap-1 truncate text-center text-sm font-semibold text-foreground">
              {activePlane ? (
                <>
                  <span className="min-w-0 truncate text-mauve">{activePlane.name}</span>
                  {activeDemiplane ? (
                    <>
                      <span className="shrink-0 text-muted-foreground">/</span>
                      <span className="min-w-0 truncate text-success">{activeDemiplane.name}</span>
                    </>
                  ) : null}
                  {hasThreadTitle ? <span className="shrink-0 text-muted-foreground">/</span> : null}
                </>
              ) : null}
              {hasThreadTitle ? <span className="min-w-0 truncate text-foreground">{activeThread?.title}</span> : null}
            </h2>
          ) : null}
          <div ref={settingsMenuRef} className="absolute right-4">
            <button
              className="rounded-lg p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              aria-label="Chat settings"
              onClick={() => setIsSettingsOpen(open => !open)}
            >
              <Settings size={18} />
            </button>
            {isSettingsOpen ? (
              <div className="absolute right-0 top-full z-50 mt-2 w-56 rounded-lg border border-border bg-background p-2 text-sm shadow-lg">
                <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-foreground transition hover:bg-muted">
                  <span>Show tool calls</span>
                  <input
                    type="checkbox"
                    checked={showToolCalls}
                    onChange={event => setShowToolCalls(event.target.checked)}
                  />
                </label>
              </div>
            ) : null}
          </div>
        </header>
        <div className="relative min-h-0 flex-1">
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
      </main>
    </div>
  );
};
