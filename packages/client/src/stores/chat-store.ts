import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { archiveServerThread, createProjectThread, createServerThread, deleteServerThread, renameServerThread } from '../lib/chat-state-api';

const createUuid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, char => {
    const randomValue = globalThis.crypto?.getRandomValues
      ? globalThis.crypto.getRandomValues(new Uint8Array(1))[0]
      : Math.floor(Math.random() * 256);
    return (Number(char) ^ (randomValue & (15 >> (Number(char) / 4)))).toString(16);
  });
};

const createId = (prefix: string) => `${prefix}_${createUuid()}`;

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
  draft?: boolean;
};

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

export type ThreadPlanStep = {
  step: string;
  status: PlanStepStatus;
};

export type ThreadPlan = {
  plan: ThreadPlanStep[];
  completed: number;
  total: number;
  updatedAt: string;
  isBusy?: boolean;
};

export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high';

export type ActiveSurface =
  | { kind: 'thread'; threadId: string }
  | { kind: 'workspace'; projectId: string; workspaceId: string };

export type MainPane = 'chat' | 'editor';

export type PaneVisibility = {
  chatOpen: boolean;
  editorOpen: boolean;
};

type PersistedChatState = {
  threadId: string;
  activeSurface?: ActiveSurface;
  paneVisibility?: PaneVisibility;
  maximizedPane?: MainPane | null;
  preMaximizePaneVisibility?: PaneVisibility;
  selectedModel: string;
  reasoningEffort: ReasoningEffort;
  showToolCalls: boolean;
  showReasoning: boolean;
  showPlanPanel: boolean;
  toolActivityCollapsed: Record<string, boolean>;
};

type ChatState = {
  resourceId: string;
  threadId: string;
  activeSurface: ActiveSurface;
  paneVisibility: PaneVisibility;
  maximizedPane: MainPane | null;
  preMaximizePaneVisibility?: PaneVisibility;
  threads: ChatThread[];
  selectedModel: string;
  reasoningEffort: ReasoningEffort;
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
  selectWorkspace: (projectId: string, workspaceId: string) => void;
  openPane: (pane: MainPane) => void;
  closePane: (pane: MainPane) => void;
  togglePane: (pane: MainPane) => void;
  toggleMaximizedPane: (pane: MainPane) => void;
  restoreMaximizedPane: () => void;
  setThreadId: (threadId: string) => void;
  archiveThread: (threadId: string) => Promise<void>;
  restoreThread: (threadId: string) => Promise<void>;
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
    draft: true,
  };
};

const isDraftThread = (thread: ChatThread | undefined) => thread?.draft === true;

const initialThread = createLocalThread();
const defaultPaneVisibility: PaneVisibility = { chatOpen: true, editorOpen: false };

const getPaneVisibilityForThread = (thread: ChatThread | undefined): PaneVisibility => ({
  chatOpen: true,
  editorOpen: Boolean(thread?.workspaceId),
});

const getEditorOnlyPaneVisibility = (): PaneVisibility => ({ chatOpen: false, editorOpen: true });

const setPaneOpen = (paneVisibility: PaneVisibility, pane: MainPane, open: boolean): PaneVisibility => (
  pane === 'chat'
    ? { ...paneVisibility, chatOpen: open }
    : { ...paneVisibility, editorOpen: open }
);

const isPersistedActiveSurface = (value: unknown): value is ActiveSurface => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.kind === 'thread') return typeof record.threadId === 'string' && Boolean(record.threadId);
  if (record.kind === 'workspace') {
    return typeof record.projectId === 'string' && Boolean(record.projectId)
      && typeof record.workspaceId === 'string' && Boolean(record.workspaceId);
  }
  return false;
};

const isPersistedPaneVisibility = (value: unknown): value is PaneVisibility => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.chatOpen === 'boolean' && typeof record.editorOpen === 'boolean';
};

const isPersistedMainPane = (value: unknown): value is MainPane => value === 'chat' || value === 'editor';

const repairThreadSurface = (activeSurface: ActiveSurface, threads: ChatThread[], fallbackThreadId: string): ActiveSurface => {
  if (activeSurface.kind === 'workspace') return activeSurface;
  return threads.some(thread => thread.id === activeSurface.threadId)
    ? activeSurface
    : { kind: 'thread', threadId: fallbackThreadId };
};

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      resourceId: createId('browser-user'),
      threadId: initialThread.id,
      activeSurface: { kind: 'thread', threadId: initialThread.id },
      paneVisibility: defaultPaneVisibility,
      maximizedPane: null,
      threads: [initialThread],
      selectedModel: '',
      reasoningEffort: 'medium',
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
          const nextThreadId = shouldSelectLastMessaged
            ? mappedServerThreads[0].id
            : nextThreads.some(thread => thread.id === state.threadId)
              ? state.threadId
              : nextThreads[0]?.id || state.threadId;
          const nextActiveSurface = shouldSelectLastMessaged && state.activeSurface.kind === 'thread'
            ? { kind: 'thread' as const, threadId: mappedServerThreads[0].id }
            : repairThreadSurface(state.activeSurface, nextThreads, nextThreadId);
          const nextSelectedThread = nextThreads.find(thread => thread.id === (
            nextActiveSurface.kind === 'thread' ? nextActiveSurface.threadId : nextThreadId
          ));

          return {
            threads: nextThreads,
            threadId: nextThreadId,
            activeSurface: nextActiveSurface,
            paneVisibility: shouldSelectLastMessaged && nextActiveSurface.kind === 'thread'
              ? getPaneVisibilityForThread(nextSelectedThread)
              : state.paneVisibility,
            maximizedPane: shouldSelectLastMessaged ? null : state.maximizedPane,
            preMaximizePaneVisibility: shouldSelectLastMessaged ? undefined : state.preMaximizePaneVisibility,
            hasInitializedThreads: true,
          };
        }),
      newThread: async (projectId, workspaceId) => {
        const localThread = { ...createLocalThread(), projectId, workspaceId };
        set(state => ({
          threadId: localThread.id,
          activeSurface: { kind: 'thread', threadId: localThread.id },
          paneVisibility: getPaneVisibilityForThread(localThread),
          maximizedPane: null,
          preMaximizePaneVisibility: undefined,
          threads: [localThread, ...state.threads.filter(thread => thread.id !== state.threadId || !isDraftThread(thread))],
        }));
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
      setThreadId: threadId =>
        set(state => {
          const nextThread = state.threads.find(thread => thread.id === threadId);
          if (state.threadId === threadId) {
            return {
              activeSurface: { kind: 'thread', threadId },
              paneVisibility: getPaneVisibilityForThread(nextThread),
              maximizedPane: null,
              preMaximizePaneVisibility: undefined,
              completedThreadIds: state.completedThreadIds.filter(id => id !== threadId),
            };
          }

          const currentThread = state.threads.find(thread => thread.id === state.threadId);
          const shouldDiscardCurrentDraft = isDraftThread(currentThread) && state.threads.some(thread => thread.id === threadId);

          return {
            threadId,
            activeSurface: { kind: 'thread', threadId },
            paneVisibility: getPaneVisibilityForThread(nextThread),
            maximizedPane: null,
            preMaximizePaneVisibility: undefined,
            threads: shouldDiscardCurrentDraft
              ? state.threads.filter(thread => thread.id !== state.threadId)
              : state.threads,
            runningThreadIds: shouldDiscardCurrentDraft
              ? state.runningThreadIds.filter(id => id !== state.threadId)
              : state.runningThreadIds,
            completedThreadIds: state.completedThreadIds.filter(id => id !== threadId && (!shouldDiscardCurrentDraft || id !== state.threadId)),
          };
        }),
      selectThread: threadId => get().setThreadId(threadId),
      selectWorkspace: (projectId, workspaceId) =>
        set({
          activeSurface: { kind: 'workspace', projectId, workspaceId },
          paneVisibility: getEditorOnlyPaneVisibility(),
          maximizedPane: null,
          preMaximizePaneVisibility: undefined,
        }),
      openPane: pane =>
        set(state => ({
          paneVisibility: setPaneOpen(state.paneVisibility, pane, true),
          maximizedPane: null,
          preMaximizePaneVisibility: undefined,
        })),
      closePane: pane =>
        set(state => {
          const restoredVisibility = state.maximizedPane === pane && state.preMaximizePaneVisibility
            ? state.preMaximizePaneVisibility
            : state.paneVisibility;
          return {
            paneVisibility: setPaneOpen(restoredVisibility, pane, false),
            maximizedPane: null,
            preMaximizePaneVisibility: undefined,
          };
        }),
      togglePane: pane =>
        set(state => {
          const isOpen = pane === 'chat' ? state.paneVisibility.chatOpen : state.paneVisibility.editorOpen;
          const restoredVisibility = state.maximizedPane && state.preMaximizePaneVisibility
            ? state.preMaximizePaneVisibility
            : state.paneVisibility;
          return {
            paneVisibility: setPaneOpen(restoredVisibility, pane, !isOpen),
            maximizedPane: null,
            preMaximizePaneVisibility: undefined,
          };
        }),
      toggleMaximizedPane: pane =>
        set(state => {
          if (state.maximizedPane === pane) {
            return {
              paneVisibility: state.preMaximizePaneVisibility ?? state.paneVisibility,
              maximizedPane: null,
              preMaximizePaneVisibility: undefined,
            };
          }
          const previousPaneVisibility = state.maximizedPane && state.preMaximizePaneVisibility
            ? state.preMaximizePaneVisibility
            : state.paneVisibility;
          return {
            paneVisibility: {
              chatOpen: pane === 'chat',
              editorOpen: pane === 'editor',
            },
            maximizedPane: pane,
            preMaximizePaneVisibility: previousPaneVisibility,
          };
        }),
      restoreMaximizedPane: () =>
        set(state => state.maximizedPane
          ? {
              paneVisibility: state.preMaximizePaneVisibility ?? state.paneVisibility,
              maximizedPane: null,
              preMaximizePaneVisibility: undefined,
            }
          : state),
      archiveThread: async threadId => {
        if (isDraftThread(get().threads.find(thread => thread.id === threadId))) {
          set(state => {
            const threads = state.threads.filter(thread => thread.id !== threadId);
            const nextThreads = threads.length > 0 ? threads : [createLocalThread()];
            const nextThreadId = state.threadId === threadId ? nextThreads[0].id : state.threadId;
            const nextActiveSurface = state.activeSurface.kind === 'thread' && state.activeSurface.threadId === threadId
              ? { kind: 'thread' as const, threadId: nextThreadId }
              : state.activeSurface;
            return {
              threads: nextThreads,
              threadId: nextThreadId,
              activeSurface: nextActiveSurface,
              paneVisibility: nextActiveSurface.kind === 'thread'
                ? getPaneVisibilityForThread(nextThreads.find(thread => thread.id === nextActiveSurface.threadId))
                : state.paneVisibility,
              maximizedPane: nextActiveSurface.kind === 'thread' ? null : state.maximizedPane,
              preMaximizePaneVisibility: nextActiveSurface.kind === 'thread' ? undefined : state.preMaximizePaneVisibility,
              runningThreadIds: state.runningThreadIds.filter(id => id !== threadId),
              completedThreadIds: state.completedThreadIds.filter(id => id !== threadId),
            };
          });
          return;
        }

        set(state => {
          const nextThreads = state.threads.map(thread => thread.id === threadId ? { ...thread, archived: true } : thread);
          const visibleThreads = nextThreads.filter(thread => !thread.archived);
          const nextThreadId = state.threadId === threadId ? visibleThreads[0]?.id ?? state.threadId : state.threadId;
          const nextActiveSurface = state.activeSurface.kind === 'thread' && state.activeSurface.threadId === threadId
            ? { kind: 'thread' as const, threadId: nextThreadId }
            : state.activeSurface;
          return {
            threads: nextThreads,
            threadId: nextThreadId,
            activeSurface: nextActiveSurface,
            paneVisibility: nextActiveSurface.kind === 'thread'
              ? getPaneVisibilityForThread(nextThreads.find(thread => thread.id === nextActiveSurface.threadId))
              : state.paneVisibility,
            maximizedPane: nextActiveSurface.kind === 'thread' ? null : state.maximizedPane,
            preMaximizePaneVisibility: nextActiveSurface.kind === 'thread' ? undefined : state.preMaximizePaneVisibility,
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
        const isDraft = isDraftThread(previousState.threads.find(thread => thread.id === threadId));

        set(state => {
          const threads = state.threads.filter(thread => thread.id !== threadId);
          const nextThreads = threads.length > 0 ? threads : [createLocalThread()];
          const nextThreadId = state.threadId === threadId ? nextThreads[0].id : state.threadId;
          const nextActiveSurface = state.activeSurface.kind === 'thread' && state.activeSurface.threadId === threadId
            ? { kind: 'thread' as const, threadId: nextThreadId }
            : state.activeSurface;

          return {
            threads: nextThreads,
            threadId: nextThreadId,
            activeSurface: nextActiveSurface,
            paneVisibility: nextActiveSurface.kind === 'thread'
              ? getPaneVisibilityForThread(nextThreads.find(thread => thread.id === nextActiveSurface.threadId))
              : state.paneVisibility,
            maximizedPane: nextActiveSurface.kind === 'thread' ? null : state.maximizedPane,
            preMaximizePaneVisibility: nextActiveSurface.kind === 'thread' ? undefined : state.preMaximizePaneVisibility,
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
            threadId: previousState.threadId,
            activeSurface: previousState.activeSurface,
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
      version: 9,
      migrate: persistedState => {
        const state = persistedState as Partial<PersistedChatState>;
        const reasoningEffort = state.reasoningEffort;
        const threadId = typeof state.threadId === 'string' ? state.threadId : initialThread.id;
        const paneVisibility = isPersistedPaneVisibility(state.paneVisibility)
          ? state.paneVisibility
          : defaultPaneVisibility;
        const maximizedPane = isPersistedMainPane(state.maximizedPane) ? state.maximizedPane : null;
        return {
          threadId,
          activeSurface: isPersistedActiveSurface(state.activeSurface) ? state.activeSurface : { kind: 'thread', threadId },
          paneVisibility,
          maximizedPane,
          preMaximizePaneVisibility: isPersistedPaneVisibility(state.preMaximizePaneVisibility)
            ? state.preMaximizePaneVisibility
            : undefined,
          selectedModel: typeof state.selectedModel === 'string' ? state.selectedModel : '',
          reasoningEffort: reasoningEffort === 'off' || reasoningEffort === 'minimal' || reasoningEffort === 'low' || reasoningEffort === 'medium' || reasoningEffort === 'high'
            ? reasoningEffort
            : 'medium',
          showToolCalls: typeof state.showToolCalls === 'boolean' ? state.showToolCalls : true,
          showReasoning: typeof state.showReasoning === 'boolean' ? state.showReasoning : true,
          showPlanPanel: typeof state.showPlanPanel === 'boolean' ? state.showPlanPanel : true,
          toolActivityCollapsed: state.toolActivityCollapsed && typeof state.toolActivityCollapsed === 'object' && !Array.isArray(state.toolActivityCollapsed)
            ? state.toolActivityCollapsed
            : {},
        };
      },
      partialize: state => ({
        threadId: state.threadId,
        activeSurface: state.activeSurface,
        paneVisibility: state.paneVisibility,
        maximizedPane: state.maximizedPane,
        preMaximizePaneVisibility: state.preMaximizePaneVisibility,
        selectedModel: state.selectedModel,
        reasoningEffort: state.reasoningEffort,
        showToolCalls: state.showToolCalls,
        showReasoning: state.showReasoning,
        showPlanPanel: state.showPlanPanel,
        toolActivityCollapsed: state.toolActivityCollapsed,
      }),
    },
  ),
);
