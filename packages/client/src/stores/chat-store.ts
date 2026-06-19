import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { archiveServerThread, createProjectThread, createServerThread, deleteServerThread, renameServerThread, type RemovedWorkspaceSnapshot } from '../lib/chat-state-api';
import { createClientId } from '../lib/client-id';
import {
  initialSurfaceThreadId,
  useWorkspaceSurfaceStore,
  type ThreadSurfaceContext,
  type WorkspaceSurfaceSnapshot,
} from './workspace-surface-store';

export type { ActiveSurface, MainPane, PaneVisibility } from './workspace-surface-store';

export type ChatThread = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sortOrder?: number;
  projectId?: string;
  workspaceId?: string;
  profileId?: string;
  archived?: boolean;
  adHoc?: boolean;
  workspacePath?: string;
  removedWorkspace?: RemovedWorkspaceSnapshot;
  latestPlan?: ThreadPlan;
  draft?: boolean;
};

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export type ThreadPlanStep = {
  id?: string;
  step: string;
  status: PlanStepStatus;
};

export type ThreadPlan = {
  id?: string;
  title?: string;
  path?: string;
  status?: PlanStepStatus;
  plan: ThreadPlanStep[];
  completed: number;
  total: number;
  updatedAt: string;
  contentHash?: string;
  isBusy?: boolean;
};

export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high';

type PersistedChatState = {
  selectedModel: string;
  reasoningEffort: ReasoningEffort;
  followWrites: boolean;
  showToolCalls: boolean;
  showReasoning: boolean;
  showPlanPanel: boolean;
  toolActivityCollapsed: Record<string, boolean>;
};

type ChatState = {
  resourceId: string;
  threads: ChatThread[];
  selectedModel: string;
  reasoningEffort: ReasoningEffort;
  followWrites: boolean;
  showToolCalls: boolean;
  showReasoning: boolean;
  showPlanPanel: boolean;
  runningThreadIds: string[];
  completedThreadIds: string[];
  deletedThreadIds: string[];
  threadPlans: Record<string, ThreadPlan | undefined>;
  toolActivityCollapsed: Record<string, boolean>;
  hasInitializedThreads: boolean;
  setSelectedModel: (model: string) => void;
  setReasoningEffort: (reasoningEffort: ReasoningEffort) => void;
  setFollowWrites: (followWrites: boolean) => void;
  setShowToolCalls: (showToolCalls: boolean) => void;
  setShowReasoning: (showReasoning: boolean) => void;
  setShowPlanPanel: (showPlanPanel: boolean) => void;
  setThreadPlan: (threadId: string, plan: ThreadPlan) => void;
  clearThreadPlan: (threadId: string) => void;
  setToolActivityCollapsed: (groupId: string, collapsed: boolean) => void;
  setDraftThreadProfile: (threadId: string, profileId: string | null) => void;
  setServerThreads: (threads: ChatThread[]) => void;
  newThread: (projectId?: string, workspaceId?: string) => Promise<void>;
  ensureThreadPersisted: (threadId: string, title?: string) => Promise<void>;
  selectThread: (threadId: string) => void;
  archiveThread: (threadId: string) => Promise<void>;
  restoreThread: (threadId: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  touchThread: (threadId: string, title?: string, reorder?: boolean) => void;
  setThreadRunning: (threadId: string, running: boolean) => void;
  markThreadCompleted: (threadId: string) => void;
  clearThreadCompleted: (threadId: string) => void;
};

const createLocalThread = (id = createClientId('thread')): ChatThread => {
  const now = new Date().toISOString();

  return {
    id,
    title: '...',
    createdAt: now,
    updatedAt: now,
    draft: true,
  };
};

const isDraftThread = (thread: ChatThread | undefined) => thread?.draft === true;

const initialThread = createLocalThread(initialSurfaceThreadId);
const toSurfaceThread = (thread: ChatThread): ThreadSurfaceContext => ({ id: thread.id, workspaceId: thread.workspaceId });
const getSurfaceSnapshot = (): WorkspaceSurfaceSnapshot => {
  const surface = useWorkspaceSurfaceStore.getState();
  return {
    threadId: surface.threadId,
    activeSurface: surface.activeSurface,
    paneVisibility: surface.paneVisibility,
    surfaceLayouts: surface.surfaceLayouts,
    maximizedPane: surface.maximizedPane,
    preMaximizePaneVisibility: surface.preMaximizePaneVisibility,
  };
};

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      resourceId: createClientId('browser-user'),
      threads: [initialThread],
      selectedModel: '',
      reasoningEffort: 'medium',
      followWrites: false,
      showToolCalls: true,
      showReasoning: true,
      showPlanPanel: true,
      runningThreadIds: [],
      completedThreadIds: [],
      deletedThreadIds: [],
      threadPlans: {},
      toolActivityCollapsed: {},
      hasInitializedThreads: false,
      setSelectedModel: selectedModel => set({ selectedModel }),
      setReasoningEffort: reasoningEffort => set({ reasoningEffort }),
      setFollowWrites: followWrites => set({ followWrites }),
      setShowToolCalls: showToolCalls => set({ showToolCalls }),
      setShowReasoning: showReasoning => set({ showReasoning }),
      setShowPlanPanel: showPlanPanel => set({ showPlanPanel }),
      setThreadPlan: (threadId, plan) =>
        set(state => {
          const isFirstPlanForThread = !state.threadPlans[threadId];
          return {
            threadPlans: { ...state.threadPlans, [threadId]: plan },
            showPlanPanel: isFirstPlanForThread ? true : state.showPlanPanel,
          };
        }),
      clearThreadPlan: threadId =>
        set(state => {
          const { [threadId]: _removed, ...threadPlans } = state.threadPlans;
          return { threadPlans };
        }),
      setToolActivityCollapsed: (groupId, collapsed) =>
        set(state => ({
          toolActivityCollapsed: { ...state.toolActivityCollapsed, [groupId]: collapsed },
        })),
      setDraftThreadProfile: (threadId, profileId) =>
        set(state => ({
          threads: state.threads.map(thread =>
            thread.id === threadId && thread.draft === true
              ? { ...thread, profileId: profileId?.trim() || undefined }
              : thread,
          ),
        })),
      setServerThreads: threads =>
        set(state => {
          const surface = useWorkspaceSurfaceStore.getState();
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
          const nextThreadId = shouldSelectLastMessaged ? mappedServerThreads[0].id : undefined;
          const threadPlans = { ...state.threadPlans };
          for (const thread of nextThreads) {
            if (!thread.latestPlan) continue;
            const currentPlan = threadPlans[thread.id];
            threadPlans[thread.id] = currentPlan?.isBusy ? currentPlan : thread.latestPlan;
          }

          surface.syncThreads(nextThreads.map(toSurfaceThread), { selectThreadId: nextThreadId });

          return {
            threads: nextThreads,
            threadPlans,
            hasInitializedThreads: true,
          };
        }),
      newThread: async (projectId, workspaceId) => {
        const localThread = { ...createLocalThread(), projectId, workspaceId };
        const surface = useWorkspaceSurfaceStore.getState();
        const surfaceThreadId = surface.threadId;
        set(state => ({
          threads: [localThread, ...state.threads.filter(thread => thread.id !== surfaceThreadId || !isDraftThread(thread))],
        }));
        useWorkspaceSurfaceStore.getState().selectThread(localThread.id, toSurfaceThread(localThread), {
          preserveTerminalVisibility: Boolean(workspaceId),
        });
      },
      ensureThreadPersisted: async (threadId, title) => {
        const existing = get().threads.find(thread => thread.id === threadId);
        if (!isDraftThread(existing)) return;

        const threadTitle = title?.trim() || existing?.title || '...';
        const now = new Date().toISOString();
        set(state => ({
          threads: state.threads.map(thread =>
            thread.id === threadId
              ? { ...thread, title: threadTitle, updatedAt: now, draft: false }
              : thread,
          ),
        }));

        const serverThread = existing?.projectId
          ? (await createProjectThread(existing.projectId, threadId, existing.workspaceId, threadTitle, existing.profileId)).thread
          : await createServerThread(threadId, undefined, undefined, threadTitle, existing?.profileId);

        set(state => ({
          threads: state.threads.map(thread =>
            thread.id === threadId
              ? { ...serverThread, title: thread.title && !['New chat', '...'].includes(thread.title) ? thread.title : serverThread.title }
              : thread,
          ),
        }));
      },
      selectThread: threadId =>
        set(state => {
          const nextThread = state.threads.find(thread => thread.id === threadId);
          const surfaceThreadId = useWorkspaceSurfaceStore.getState().threadId;
          useWorkspaceSurfaceStore.getState().selectThread(threadId, nextThread ? toSurfaceThread(nextThread) : undefined);
          if (surfaceThreadId === threadId) {
            return {
              completedThreadIds: state.completedThreadIds.filter(id => id !== threadId),
            };
          }

          const currentThread = state.threads.find(thread => thread.id === surfaceThreadId);
          const shouldDiscardCurrentDraft = isDraftThread(currentThread) && state.threads.some(thread => thread.id === threadId);

          return {
            threads: shouldDiscardCurrentDraft
              ? state.threads.filter(thread => thread.id !== surfaceThreadId)
              : state.threads,
            runningThreadIds: shouldDiscardCurrentDraft
              ? state.runningThreadIds.filter(id => id !== surfaceThreadId)
              : state.runningThreadIds,
            completedThreadIds: state.completedThreadIds.filter(id => id !== threadId && (!shouldDiscardCurrentDraft || id !== surfaceThreadId)),
          };
        }),
      archiveThread: async threadId => {
        if (isDraftThread(get().threads.find(thread => thread.id === threadId))) {
          set(state => {
            const threads = state.threads.filter(thread => thread.id !== threadId);
            const nextThreads = threads.length > 0 ? threads : [createLocalThread()];
            useWorkspaceSurfaceStore.getState().syncThreads(nextThreads.map(toSurfaceThread));
            return {
              threads: nextThreads,
              runningThreadIds: state.runningThreadIds.filter(id => id !== threadId),
              completedThreadIds: state.completedThreadIds.filter(id => id !== threadId),
            };
          });
          return;
        }

        set(state => {
          const nextThreads = state.threads.map(thread => thread.id === threadId ? { ...thread, archived: true } : thread);
          const visibleThreads = nextThreads.filter(thread => !thread.archived);
          useWorkspaceSurfaceStore.getState().syncThreads(visibleThreads.map(toSurfaceThread));
          return {
            threads: nextThreads,
            runningThreadIds: state.runningThreadIds.filter(id => id !== threadId),
            completedThreadIds: state.completedThreadIds.filter(id => id !== threadId),
          };
        });
        await archiveServerThread(threadId, true);
      },
      restoreThread: async threadId => {
        set(state => ({
          threads: state.threads.map(thread => thread.id === threadId ? { ...thread, archived: false } : thread),
        }));
        await archiveServerThread(threadId, false);
      },
      deleteThread: async threadId => {
        const previousState = get();
        const previousSurfaceState = getSurfaceSnapshot();
        const isDraft = isDraftThread(previousState.threads.find(thread => thread.id === threadId));

        set(state => {
          const threads = state.threads.filter(thread => thread.id !== threadId);
          const nextThreads = threads.length > 0 ? threads : [createLocalThread()];
          useWorkspaceSurfaceStore.getState().syncThreads(nextThreads.map(toSurfaceThread));

          return {
            threads: nextThreads,
            runningThreadIds: state.runningThreadIds.filter(id => id !== threadId),
            completedThreadIds: state.completedThreadIds.filter(id => id !== threadId),
            deletedThreadIds: isDraft || state.deletedThreadIds.includes(threadId) ? state.deletedThreadIds : [...state.deletedThreadIds, threadId],
          };
        });

        if (isDraft) return;

        try {
          await deleteServerThread(threadId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('thread not found')) return;

          set({
            threads: previousState.threads,
            runningThreadIds: previousState.runningThreadIds,
            completedThreadIds: previousState.completedThreadIds,
            deletedThreadIds: previousState.deletedThreadIds,
          });
          useWorkspaceSurfaceStore.getState().restoreSurfaceSnapshot(previousSurfaceState);
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
            useWorkspaceSurfaceStore.getState().threadId === threadId || state.completedThreadIds.includes(threadId)
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
      version: 12,
      migrate: persistedState => {
        const state = persistedState as Partial<PersistedChatState>;
        const reasoningEffort = state.reasoningEffort;
        return {
          selectedModel: typeof state.selectedModel === 'string' ? state.selectedModel : '',
          reasoningEffort: reasoningEffort === 'off' || reasoningEffort === 'minimal' || reasoningEffort === 'low' || reasoningEffort === 'medium' || reasoningEffort === 'high'
            ? reasoningEffort
            : 'medium',
          followWrites: typeof state.followWrites === 'boolean' ? state.followWrites : false,
          showToolCalls: typeof state.showToolCalls === 'boolean' ? state.showToolCalls : true,
          showReasoning: typeof state.showReasoning === 'boolean' ? state.showReasoning : true,
          showPlanPanel: typeof state.showPlanPanel === 'boolean' ? state.showPlanPanel : true,
          toolActivityCollapsed: state.toolActivityCollapsed && typeof state.toolActivityCollapsed === 'object' && !Array.isArray(state.toolActivityCollapsed)
            ? state.toolActivityCollapsed
            : {},
        };
      },
      partialize: state => ({
        selectedModel: state.selectedModel,
        reasoningEffort: state.reasoningEffort,
        followWrites: state.followWrites,
        showToolCalls: state.showToolCalls,
        showReasoning: state.showReasoning,
        showPlanPanel: state.showPlanPanel,
        toolActivityCollapsed: state.toolActivityCollapsed,
      }),
    },
  ),
);
