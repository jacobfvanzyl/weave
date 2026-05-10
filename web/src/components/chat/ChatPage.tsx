import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listServerThreads } from '../../lib/chat-state-api';
import { useChatStore } from '../../stores/chat-store';
import { AssistantChat } from './AssistantChat';
import { ThreadSidebar } from './ThreadSidebar';

export const ChatPage = () => {
  const resourceId = useChatStore(state => state.resourceId);
  const threadId = useChatStore(state => state.threadId);
  const threads = useChatStore(state => state.threads);
  const runningThreadIds = useChatStore(state => state.runningThreadIds);
  const setServerThreads = useChatStore(state => state.setServerThreads);
  const newThread = useChatStore(state => state.newThread);
  const activeThread = threads.find(thread => thread.id === threadId);
  const { data: serverThreads = [], isFetched } = useQuery({
    queryKey: ['threads', resourceId],
    queryFn: () => listServerThreads(resourceId),
  });

  useEffect(() => {
    if (serverThreads.length > 0) {
      setServerThreads(serverThreads);
      return;
    }

    if (isFetched && serverThreads.length === 0 && threads.length === 0) void newThread();
  }, [isFetched, newThread, serverThreads, setServerThreads, threads.length]);

  return (
    <div className="flex h-screen overflow-hidden">
      <ThreadSidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center border-b border-border bg-background/80 px-4">
          <h2 className="truncate text-sm font-semibold text-foreground">{activeThread?.title || 'New chat'}</h2>
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
