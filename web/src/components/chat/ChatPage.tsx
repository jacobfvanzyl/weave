import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PanelLeft, Settings } from 'lucide-react';
import { listPlanes, listServerThreads } from '../../lib/chat-state-api';
import { useChatStore } from '../../stores/chat-store';
import { Button } from '../ui/button';
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from '../ui/menu';
import { AssistantChat } from './AssistantChat';
import { PlanSidebar } from './PlanSidebar';
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
  const activePlan = useChatStore(state => state.threadPlans[threadId]);
  const runningThreadIds = useChatStore(state => state.runningThreadIds);
  const setServerThreads = useChatStore(state => state.setServerThreads);
  const newThread = useChatStore(state => state.newThread);
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => !isMobilePortraitNow());
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
            className="fixed inset-0 z-30 bg-background/80 md:hidden"
            aria-label="Close sidebar"
            onClick={() => setIsSidebarOpen(false)}
          />
          <ThreadSidebar closeOnSelect={isMobilePortrait} onClose={() => setIsSidebarOpen(false)} />
        </>
      ) : null}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="relative z-20 flex h-14 shrink-0 items-center justify-center border-b border-border bg-background px-4">
          <Button
            className="absolute left-4"
            size="icon"
            variant="ghost"
            aria-label={isSidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            onClick={() => setIsSidebarOpen(open => !open)}
          >
            <PanelLeft size={18} />
          </Button>
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
          <PlanSidebar plan={activePlan} />
        </div>
      </main>
    </div>
  );
};
