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
  runningThreadIds: string[];
  completedThreadIds: string[];
  setSelectedModel: (model: string) => void;
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
    title: 'New chat',
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
      runningThreadIds: [],
      completedThreadIds: [],
      setSelectedModel: selectedModel => set({ selectedModel }),
      setServerThreads: threads =>
        set(state => {
          const optimisticThreads = state.threads.filter(
            localThread => !threads.some(serverThread => serverThread.id === localThread.id),
          );
          const nextThreads = threads.length > 0
            ? [
                ...optimisticThreads,
                ...threads.map(serverThread => {
                  const localThread = state.threads.find(thread => thread.id === serverThread.id);
                  return localThread?.title && localThread.title !== 'New chat' && serverThread.title === 'New chat'
                    ? { ...serverThread, title: localThread.title }
                    : serverThread;
                }),
              ]
            : state.threads;

          return {
            threads: nextThreads,
            threadId: nextThreads.some(thread => thread.id === state.threadId) ? state.threadId : nextThreads[0]?.id || state.threadId,
          };
        }),
      newThread: async () => {
        const resourceId = get().resourceId;
        const localThread = createLocalThread();
        set(state => ({ threadId: localThread.id, threads: [localThread, ...state.threads] }));

        const serverThread = await createServerThread(resourceId, localThread.id);
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
        const resourceId = get().resourceId;
        try {
          await deleteServerThread(resourceId, threadId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes('thread not found')) throw error;
        }

        set(state => {
          const threads = state.threads.filter(thread => thread.id !== threadId);
          const nextThreads = threads.length > 0 ? threads : [createLocalThread()];
          const nextThreadId = state.threadId === threadId ? nextThreads[0].id : state.threadId;

          return {
            threads: nextThreads,
            threadId: nextThreadId,
            runningThreadIds: state.runningThreadIds.filter(id => id !== threadId),
            completedThreadIds: state.completedThreadIds.filter(id => id !== threadId),
          };
        });
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
        const threadTitle = title?.trim() || existing?.title || 'New chat';

        const shouldRename = title?.trim() && existing?.title === 'New chat';
        if (shouldRename) {
          void renameServerThread(get().resourceId, threadId, threadTitle).catch(error => {
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
                    title: thread.title === 'New chat' ? threadTitle : thread.title,
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
        resourceId: state.resourceId,
        threadId: state.threadId,
        selectedModel: state.selectedModel,
      }),
    },
  ),
);
