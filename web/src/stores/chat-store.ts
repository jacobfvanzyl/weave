import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createServerThread, deleteServerThread, renameServerThread } from '../lib/chat-state-api';
import { defaultModel } from '../lib/models';

const createId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

export type ChatThread = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

type ChatState = {
  resourceId: string;
  threadId: string;
  threads: ChatThread[];
  selectedModel: string;
  showToolCalls: boolean;
  runningThreadIds: string[];
  completedThreadIds: string[];
  deletedThreadIds: string[];
  hasInitializedThreads: boolean;
  setSelectedModel: (model: string) => void;
  setShowToolCalls: (showToolCalls: boolean) => void;
  setServerThreads: (threads: ChatThread[]) => void;
  newThread: () => Promise<void>;
  setThreadId: (threadId: string) => void;
  deleteThread: (threadId: string) => Promise<void>;
  touchThread: (threadId: string, title?: string, reorder?: boolean) => void;
  setThreadRunning: (threadId: string, running: boolean) => void;
  markThreadCompleted: (threadId: string) => void;
  clearThreadCompleted: (threadId: string) => void;
};

const createLocalThread = (): ChatThread => {
  const now = new Date().toISOString();

  return {
    id: createId('thread'),
    title: '...',
    createdAt: now,
    updatedAt: now,
  };
};

const initialThread = createLocalThread();

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      resourceId: createId('browser-user'),
      threadId: initialThread.id,
      threads: [initialThread],
      selectedModel: defaultModel,
      showToolCalls: true,
      runningThreadIds: [],
      completedThreadIds: [],
      deletedThreadIds: [],
      hasInitializedThreads: false,
      setSelectedModel: selectedModel => set({ selectedModel }),
      setShowToolCalls: showToolCalls => set({ showToolCalls }),
      setServerThreads: threads =>
        set(state => {
          const deletedThreadIds = new Set(state.deletedThreadIds);
          const activeThreads = threads.filter(thread => !deletedThreadIds.has(thread.id));
          const mappedServerThreads = activeThreads.map(serverThread => {
            const localThread = state.threads.find(thread => thread.id === serverThread.id);
            const hasLocalTitle = localThread?.title && !['New chat', '...'].includes(localThread.title);
            const hasPlaceholderServerTitle = !serverThread.title || ['New chat', '...'].includes(serverThread.title);
            return hasLocalTitle && hasPlaceholderServerTitle ? { ...serverThread, title: localThread.title } : serverThread;
          });
          const optimisticThreads = state.threads.filter(
            localThread =>
              !deletedThreadIds.has(localThread.id) &&
              !activeThreads.some(serverThread => serverThread.id === localThread.id) &&
              (activeThreads.length === 0 || state.hasInitializedThreads || !['New chat', '...'].includes(localThread.title)),
          );
          const nextThreads = activeThreads.length > 0 ? [...mappedServerThreads, ...optimisticThreads] : state.threads;
          const shouldSelectLastMessaged = !state.hasInitializedThreads && mappedServerThreads.length > 0;

          return {
            threads: nextThreads,
            threadId: shouldSelectLastMessaged
              ? mappedServerThreads[0].id
              : nextThreads.some(thread => thread.id === state.threadId)
                ? state.threadId
                : nextThreads[0]?.id || state.threadId,
            hasInitializedThreads: true,
          };
        }),
      newThread: async () => {
        const localThread = createLocalThread();
        set(state => ({ threadId: localThread.id, threads: [localThread, ...state.threads] }));

        const serverThread = await createServerThread(localThread.id);
        set(state => ({
          threadId: serverThread.id,
          threads: [serverThread, ...state.threads.filter(thread => thread.id !== localThread.id)],
        }));
      },
      setThreadId: threadId =>
        set(state => ({
          threadId,
          completedThreadIds: state.completedThreadIds.filter(id => id !== threadId),
        })),
      deleteThread: async threadId => {
        const previousState = get();

        set(state => {
          const threads = state.threads.filter(thread => thread.id !== threadId);
          const nextThreads = threads.length > 0 ? threads : [createLocalThread()];
          const nextThreadId = state.threadId === threadId ? nextThreads[0].id : state.threadId;

          return {
            threads: nextThreads,
            threadId: nextThreadId,
            runningThreadIds: state.runningThreadIds.filter(id => id !== threadId),
            completedThreadIds: state.completedThreadIds.filter(id => id !== threadId),
            deletedThreadIds: state.deletedThreadIds.includes(threadId) ? state.deletedThreadIds : [...state.deletedThreadIds, threadId],
          };
        });

        try {
          await deleteServerThread(threadId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('thread not found')) return;

          set({
            threadId: previousState.threadId,
            threads: previousState.threads,
            runningThreadIds: previousState.runningThreadIds,
            completedThreadIds: previousState.completedThreadIds,
            deletedThreadIds: previousState.deletedThreadIds,
          });
          throw error;
        }
      },
      setThreadRunning: (threadId, running) =>
        set(state => ({
          runningThreadIds: running
            ? state.runningThreadIds.includes(threadId)
              ? state.runningThreadIds
              : [...state.runningThreadIds, threadId]
            : state.runningThreadIds.filter(id => id !== threadId),
          completedThreadIds: running
            ? state.completedThreadIds.filter(id => id !== threadId)
            : state.completedThreadIds,
        })),
      markThreadCompleted: threadId =>
        set(state => ({
          completedThreadIds:
            state.threadId === threadId || state.completedThreadIds.includes(threadId)
              ? state.completedThreadIds
              : [...state.completedThreadIds, threadId],
        })),
      clearThreadCompleted: threadId =>
        set(state => ({
          completedThreadIds: state.completedThreadIds.filter(id => id !== threadId),
        })),
      touchThread: (threadId, title, reorder = false) => {
        const now = new Date().toISOString();
        const existing = get().threads.find(thread => thread.id === threadId);
        const threadTitle = title?.trim() || existing?.title || '...';
        const hasPlaceholderTitle = !existing?.title || ['New chat', '...'].includes(existing.title);

        const shouldRename = Boolean(title?.trim() && hasPlaceholderTitle);
        if (shouldRename) {
          void renameServerThread(threadId, threadTitle).catch(error => {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('thread not found')) console.error('[chat-store] Failed to rename thread', error);
          });
        }

        set(state => ({
          threads: state.threads
            .map(thread =>
              thread.id === threadId
                ? {
                    ...thread,
                    title: ['New chat', '...'].includes(thread.title) ? threadTitle : thread.title,
                    updatedAt: reorder ? now : thread.updatedAt,
                  }
                : thread,
            )
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        }));
      },
    }),
    {
      name: 'weave-chat',
      partialize: state => ({
        threadId: state.threadId,
        selectedModel: state.selectedModel,
        showToolCalls: state.showToolCalls,
      }),
    },
  ),
);
