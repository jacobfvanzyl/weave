import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { archiveServerThread, createProjectThread, createServerThread, deleteServerThread,
  type RemovedWorkspaceSnapshot, renameServerThread, } from '../lib/chat-state-api';
import { createClientAppPersistStorage, getClientAppStorageKey } from '../lib/client-app';
import { createClientId } from '../lib/client-id';
import { getActiveClientSessionIdentity } from '../lib/client-session';
import { selectPreferredThreadPlan, shouldAcceptThreadPlanUpdate } from '../lib/plan-state';
import { selectPreferredThreadProposal, shouldAcceptThreadProposalUpdate } from '../lib/proposal-review-state';
import {
  createThreadOpenabilityContext,
  emptyThreadOpenabilityContext,
  getOpenableThreads,
  isOpenableThread,
  type ThreadOpenabilityContext,
  type ThreadOpenabilityProject,
} from '../lib/thread-eligibility';
import { resolveStartupSurface } from '../lib/startup-surface-resolver';
import { type PersistedLocalDraft, useClientSessionViewStore } from './client-session-view-store';
import {
  initialSurfaceThreadId,
  type ThreadSurfaceContext,
  useWorkspaceSurfaceStore,
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
  archived?: boolean;
  adHoc?: boolean;
  workspacePath?: string;
  removedWorkspace?: RemovedWorkspaceSnapshot;
  latestPlan?: ThreadPlan;
  latestProposal?: ThreadProposal;
  draft?: boolean;
  // Local-only handoff state; a stale server list must not discard a first-send thread.
  persistenceState?: 'creating' | 'awaiting_server_list';
};

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export type ThreadPlanStep = {
  id?: string;
  step: string;
  status: PlanStepStatus;
};

export type ThreadPlan = {
  title?: string;
  artifactPath?: string;
  status?: PlanStepStatus;
  plan: ThreadPlanStep[];
  completed: number;
  total: number;
  updatedAt: string;
  isBusy?: boolean;
};

export type ProposalItemStatus = 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'applied' | 'stale';
export type ProposalStatus =
  | 'draft' | 'ready' | 'partially_approved' | 'approved' | 'changes_requested' | 'applied' | 'rejected' | 'stale';

export type ThreadProposalItem = {
  id: string;
  kind: string;
  status: ProposalItemStatus;
  title: string;
  path?: string;
  additions: number;
  deletions: number;
  viewed: boolean;
  currentHash?: string;
  proposedHash?: string;
  comment?: string;
};

export type ThreadProposal = {
  id?: string;
  title?: string;
  path?: string;
  planPath?: string;
  status?: ProposalStatus;
  summary?: string;
  items: ThreadProposalItem[];
  counts: Record<string, number>;
  updatedAt: string;
  contentHash?: string;
  isBusy?: boolean;
};

export type ProposalImplementationRequest = {
  id: string;
  proposalPath: string;
  approvedItemIds: string[];
  mode?: 'implement' | 'address_feedback';
  requestedAt: string;
};

export type SubmittedProposalImplementation = {
  requestId: string;
  proposalPath: string;
  proposalContentHash?: string;
  mode?: ProposalImplementationRequest['mode'];
  requestedAt: string;
};

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ServiceTier = 'auto' | 'default' | 'flex' | 'priority';
export type ExecutionProfile = 'observe' | 'workspace' | 'host';

type PersistedChatState = {
  selectedModel: string;
  reasoningEffort: ReasoningEffort | 'off';
  serviceTier?: ServiceTier | 'fast' | null;
  executionProfile?: ExecutionProfile;
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
  serviceTier: ServiceTier | null;
  executionProfile: ExecutionProfile;
  followWrites: boolean;
  showToolCalls: boolean;
  showReasoning: boolean;
  showPlanPanel: boolean;
  runningThreadIds: string[];
  completedThreadIds: string[];
  deletedThreadIds: string[];
  threadPlans: Record<string, ThreadPlan | undefined>;
  threadProposals: Record<string, ThreadProposal | undefined>;
  pendingProposalImplementationRequests: Record<string, ProposalImplementationRequest | undefined>;
  submittedProposalImplementations: Record<string, SubmittedProposalImplementation | undefined>;
  guidedTaskExpandedByThread: Record<string, boolean | undefined>;
  toolActivityCollapsed: Record<string, boolean>;
  hasInitializedThreads: boolean;
  threadOpenabilityContext: ThreadOpenabilityContext;
  setSelectedModel: (model: string) => void;
  setReasoningEffort: (reasoningEffort: ReasoningEffort) => void;
  setServiceTier: (serviceTier: ServiceTier | null) => void;
  setExecutionProfile: (executionProfile: ExecutionProfile) => void;
  setFollowWrites: (followWrites: boolean) => void;
  setShowToolCalls: (showToolCalls: boolean) => void;
  setShowReasoning: (showReasoning: boolean) => void;
  setShowPlanPanel: (showPlanPanel: boolean) => void;
  setThreadPlan: (threadId: string, plan: ThreadPlan, options?: { autoExpand?: boolean }) => void;
  setThreadProposal: (threadId: string, proposal: ThreadProposal, options?: { autoExpand?: boolean }) => boolean;
  clearThreadPlan: (threadId: string) => void;
  clearThreadProposal: (threadId: string) => void;
  enqueueProposalImplementationRequest: (threadId: string, request: Omit<ProposalImplementationRequest, 'id' | 'requestedAt'> & Partial<Pick<ProposalImplementationRequest, 'id' | 'requestedAt'>>,) => ProposalImplementationRequest;
  consumeProposalImplementationRequest: (threadId: string, requestId: string) => void;
  setGuidedTaskExpanded: (threadId: string, expanded: boolean) => void;
  setToolActivityCollapsed: (groupId: string, collapsed: boolean) => void;
  setServerThreads: (threads: ChatThread[], projects?: ThreadOpenabilityProject[]) => void;
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
const isDisposableDraftThread = (thread: ChatThread | undefined) =>
  Boolean(isDraftThread(thread) && thread && !useClientSessionViewStore.getState().composerDrafts[thread.id]);
const normalizeReasoningEffort = (value: unknown): ReasoningEffort =>
  value === 'off' || value === 'minimal'
    ? 'low'
    : value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' ||
        value === 'max'
    ? value
    : 'medium';

const normalizeServiceTier = (value: unknown): ServiceTier | null =>
  value === 'fast'
    ? 'priority'
    : value === 'auto' || value === 'default' || value === 'flex' || value === 'priority'
    ? value
    : null;

const initialThread = createLocalThread(initialSurfaceThreadId);
const toSurfaceThread = (thread: ChatThread): ThreadSurfaceContext => ({ id: thread.id, workspaceId: thread.workspaceId, });
const withOpenableThreadFallback = (
  threads: ChatThread[],
  context: ThreadOpenabilityContext,
  fallbackCandidates: ChatThread[] = [],
) => {
  const openableThreads = getOpenableThreads(threads, context);
  if (openableThreads.length > 0) return { threads, openableThreads };

  const fallbackThread =
    fallbackCandidates.find((thread) => isDraftThread(thread) && isOpenableThread(thread, context))
    ?? threads.find((thread) => isDraftThread(thread) && isOpenableThread(thread, context))
    ?? createLocalThread();
  const nextThreads = threads.some((thread) => thread.id === fallbackThread.id)
    ? threads
    : [fallbackThread, ...threads];
  return { threads: nextThreads, openableThreads: [fallbackThread] };
};
const getSurfaceSnapshot = (): WorkspaceSurfaceSnapshot => {
  const surface = useWorkspaceSurfaceStore.getState();
  return {
    threadId: surface.threadId,
    activeSurface: surface.activeSurface,
    paneVisibility: surface.paneVisibility,
    surfaceLayouts: surface.surfaceLayouts,
    terminalPaneColumnsByWorkspace: surface.terminalPaneColumnsByWorkspace,
    editorSlotMode: surface.editorSlotMode,
    activeProposalPath: surface.activeProposalPath,
    maximizedPane: surface.maximizedPane,
    preMaximizePaneVisibility: surface.preMaximizePaneVisibility,
  };
};

const withoutRecordKey = <T>(record: Record<string, T | undefined>, key: string): Record<string, T | undefined> => {
  const { [key]: _removed, ...rest } = record;
  return rest;
};

const shouldClearSubmittedProposalForProposal = (
  submittedProposal: SubmittedProposalImplementation | undefined,
  proposal: ThreadProposal,
) => Boolean(
  submittedProposal
    && (
      submittedProposal.proposalPath !== proposal.path
      || (
        submittedProposal.proposalContentHash
        && proposal.contentHash
        && submittedProposal.proposalContentHash !== proposal.contentHash
      )
    ),
);

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      resourceId: createClientId('browser-user'),
      threads: [initialThread],
      selectedModel: '',
      reasoningEffort: 'medium',
      serviceTier: null,
      executionProfile: 'workspace',
      followWrites: false,
      showToolCalls: true,
      showReasoning: true,
      showPlanPanel: true,
      runningThreadIds: [],
      completedThreadIds: [],
      deletedThreadIds: [],
      threadPlans: {},
      threadProposals: {},
      pendingProposalImplementationRequests: {},
      submittedProposalImplementations: {},
      guidedTaskExpandedByThread: {},
      toolActivityCollapsed: {},
      hasInitializedThreads: false,
      threadOpenabilityContext: emptyThreadOpenabilityContext,
      setSelectedModel: ( selectedModel) => set({ selectedModel }),
      setReasoningEffort: ( reasoningEffort) => set({ reasoningEffort }),
      setServiceTier: ( serviceTier) => set({ serviceTier }),
      setExecutionProfile: (executionProfile) => set({ executionProfile }),
      setFollowWrites: ( followWrites) => set({ followWrites }),
      setShowToolCalls: ( showToolCalls) => set({ showToolCalls }),
      setShowReasoning: ( showReasoning) => set({ showReasoning }),
      setShowPlanPanel: ( showPlanPanel) => set({ showPlanPanel }),
      setThreadPlan: (threadId, plan, options = {}) =>
        set((state) => {
          const previous = state.threadPlans[threadId];
          if (!shouldAcceptThreadPlanUpdate(previous, plan)) return state;
          const hasBlockedStep = plan.plan.some((item) => item.status === 'blocked') || plan.status === 'blocked';
          const isComplete = plan.total > 0 && plan.completed >= plan.total;
          const wasComplete = Boolean(previous && previous.total > 0 && previous.completed >= previous.total);
          const completedNow = Boolean(previous) && isComplete && !wasComplete;
          const shouldExpand = options.autoExpand !== false && (hasBlockedStep || completedNow);
          return {
            threadPlans: { ...state.threadPlans, [threadId]: plan },
            guidedTaskExpandedByThread: {
              ...state.guidedTaskExpandedByThread,
              [threadId]: shouldExpand ? true : ( state.guidedTaskExpandedByThread[threadId] ?? false),
            },
          };
        }),
      clearThreadPlan: ( threadId) =>
        set((state) => {
          const { [threadId]: _removed, ...threadPlans } = state.threadPlans;
          return { threadPlans };
        }),
      setThreadProposal: (threadId, proposal, options = {}) => {
        let accepted = false;
        set((state) => {
          const previous = state.threadProposals[threadId];
          if (!shouldAcceptThreadProposalUpdate(previous, proposal)) { return state;
          }
          accepted = true;
          const submittedProposal = state.submittedProposalImplementations[threadId];
          const shouldClearSubmittedProposal = shouldClearSubmittedProposalForProposal(submittedProposal, proposal);
          const pendingCount = proposal.counts.pending ?? proposal.items.filter((item) => item.status === 'pending').length;
          const approvedCount = proposal.counts.approved ?? proposal.items.filter((item) => item.status === 'approved').length;
          const canViewProposal = Boolean(proposal.path && proposal.items.length > 0);
          const canSubmitProposal = canViewProposal && proposal.status !== 'draft';
          const hasNewPendingApprovals = pendingCount > 0
            && canSubmitProposal
            && (!previous || previous.contentHash !== proposal.contentHash || (previous.counts.pending ?? 0) < pendingCount);
          const hasNewApprovedImplementation = approvedCount > 0
            && canSubmitProposal
            && (!previous || (previous.counts.approved ?? 0) < approvedCount);
          const hasNewDraftReview = proposal.status === 'draft'
            && canViewProposal
            && (!previous || previous.path !== proposal.path || previous.status !== 'draft');
          const shouldExpand = options.autoExpand !== false
            && canViewProposal
            && (hasNewDraftReview || proposal.status === 'changes_requested' || proposal.status === 'stale' || hasNewPendingApprovals || hasNewApprovedImplementation);
          return {
            threadProposals: { ...state.threadProposals, [threadId]: proposal },
            submittedProposalImplementations: shouldClearSubmittedProposal
              ? withoutRecordKey(state.submittedProposalImplementations, threadId)
              : state.submittedProposalImplementations,
            guidedTaskExpandedByThread: {
              ...state.guidedTaskExpandedByThread,
              [threadId]: shouldExpand ? true : ( state.guidedTaskExpandedByThread[threadId] ?? false),
            },
          };
        });
        return accepted;
      },
      clearThreadProposal: ( threadId) =>
        set((state) => {
          const threadProposals = withoutRecordKey(state.threadProposals, threadId);
          const submittedProposalImplementations = withoutRecordKey(state.submittedProposalImplementations, threadId);
          return { threadProposals, submittedProposalImplementations };
        }),
      enqueueProposalImplementationRequest: (threadId, input) => {
        const request: ProposalImplementationRequest = {
          id: input.id ?? createClientId('proposal-implementation'),
          proposalPath: input.proposalPath,
          approvedItemIds: input.approvedItemIds,
          mode: input.mode,
          requestedAt: input.requestedAt ?? new Date().toISOString(),
        };
        set((state) => {
          const proposal = state.threadProposals[threadId];
          return {
            pendingProposalImplementationRequests: {
              ...state.pendingProposalImplementationRequests,
              [threadId]: request,
            },
            submittedProposalImplementations: {
              ...state.submittedProposalImplementations,
              [threadId]: {
                requestId: request.id,
                proposalPath: request.proposalPath,
                ...(proposal?.path === request.proposalPath && proposal.contentHash ? { proposalContentHash: proposal.contentHash } : {}),
                ...(request.mode ? { mode: request.mode } : {}),
                requestedAt: request.requestedAt,
              },
            },
            guidedTaskExpandedByThread: {
              ...state.guidedTaskExpandedByThread,
              [threadId]: request.mode === 'implement' ? false : true,
            },
          };
        });
        return request;
      },
      consumeProposalImplementationRequest: (threadId, requestId) =>
        set((state) => {
          if (state.pendingProposalImplementationRequests[threadId]?.id !== requestId) return state;
          const { [threadId]: _removed, ...pendingProposalImplementationRequests } = state.pendingProposalImplementationRequests;
          return { pendingProposalImplementationRequests };
        }),
      setGuidedTaskExpanded: (threadId, expanded) =>
        set((state) => {
          useClientSessionViewStore.getState ().setGuidedTaskExpanded(threadId, expanded);
          return{
          guidedTaskExpandedByThread: { ...state.guidedTaskExpandedByThread, [threadId]: expanded, },
        };
        }),
      setToolActivityCollapsed: (groupId, collapsed) =>
        set((state) => {
          useClientSessionViewStore.getState ().setToolActivityCollapsed(groupId, collapsed);
          return{
          toolActivityCollapsed: { ...state.toolActivityCollapsed, [groupId]: collapsed, },
        };
        }),
      setServerThreads: (threads, projects = []) =>
        set((state) => {
          const surface = useWorkspaceSurfaceStore.getState();
          const threadOpenabilityContext = createThreadOpenabilityContext(projects);
          const deletedThreadIds = new Set(state.deletedThreadIds);
          const activeThreads = threads.filter((thread) => !deletedThreadIds.has(thread.id));
          const mappedServerThreads = activeThreads.map((serverThread) => {
            const localThread = state.threads.find((thread) => thread.id === serverThread.id);
            const hasLocalTitle = localThread?.title && !['New chat', '...'].includes(localThread.title);
            const hasPlaceholderServerTitle = !serverThread.title || ['New chat', '...'].includes(serverThread.title);
            return hasLocalTitle && hasPlaceholderServerTitle ? { ...serverThread, title: localThread.title } : serverThread;
          });
          const optimisticThreads = state.threads.filter((
            localThread) => {
              return ( !deletedThreadIds.has(localThread.id) &&
                !activeThreads.some((serverThread) => serverThread.id === localThread.id) &&
              (isDraftThread(localThread) || localThread.persistenceState !== undefined));
            }
          );
          let nextThreads = [...mappedServerThreads, ...optimisticThreads];
          const openableThreads = getOpenableThreads(nextThreads, threadOpenabilityContext);
          const startupResolution = resolveStartupSurface({
            activeSurface : surface.activeSurface,
            openableThreads,
            workspaceRefs: threadOpenabilityContext.workspaceRefs,
          });
          if (startupResolution.kind === 'create-root-draft') {
            const staleThreadId = surface.activeSurface.kind === 'thread' ? surface.activeSurface.threadId : undefined;
            const staleThread = staleThreadId ? nextThreads.find((thread) => thread.id === staleThreadId) : undefined;
            if (staleThreadId && startupResolution.discardStaleComposer && staleThread?.archived !== true) {
              useClientSessionViewStore.getState().discardThreadView(staleThreadId);
            }
            nextThreads = nextThreads.filter((thread) => !(thread.id === staleThreadId && isDraftThread(thread)));
            const rootDraft =
              nextThreads.find((thread) => isDraftThread(thread) && !thread.projectId && !thread.workspaceId) ??
              createLocalThread();
            if ( !nextThreads.some((thread) => thread.id === rootDraft.id)) {
            nextThreads = [rootDraft, ...nextThreads];
          }
            surface.restoreSurface({ kind: 'thread', threadId: rootDraft.id }, toSurfaceThread(rootDraft), {
              useDefaultLayout: true,
            });
          } else if (startupResolution.kind === 'restore-thread') {
          const thread = nextThreads.find((candidate) => candidate.id === startupResolution.threadId);
            surface.restoreSurface(
              {
                kind: 'thread',
                threadId: startupResolution.threadId,
              },
              thread ? toSurfaceThread(thread) : undefined,
            );
          } else if (startupResolution.kind === 'restore-draft') {
          const thread = nextThreads.find((candidate) => candidate.id === startupResolution.draftId);
            surface.restoreSurface(
              {
                kind: 'thread',
                threadId: startupResolution.draftId,
              },
              thread ? toSurfaceThread(thread) : undefined,
            );
          } else {
            surface.restoreSurface({
              kind: 'workspace',
              projectId: startupResolution.projectId,
              workspaceId: startupResolution.workspaceId,
            });
          }
          surface.reconcilePersistedSurfaces(
            new Set(nextThreads.map((thread) => thread.id)), threadOpenabilityContext.workspaceRefs,);
          useClientSessionViewStore.getState().reconcileThreadViews(new Set(
          nextThreads.map((thread) => thread.id)));
          const threadPlans = { ...state.threadPlans };
          const threadProposals = { ...state.threadProposals };
          let submittedProposalImplementations = state.submittedProposalImplementations;
          for (const thread of nextThreads) {
            if (thread.latestPlan) {
              const currentPlan = threadPlans[thread.id];
              const nextPlan = selectPreferredThreadPlan(currentPlan, thread.latestPlan, { preserveBusy: true });
              if (nextPlan) threadPlans[thread.id] = nextPlan;
            }
            if (thread.latestProposal) {
              const currentProposal = threadProposals[thread.id];
              const nextProposal = currentProposal?.isBusy
                ? currentProposal
                : selectPreferredThreadProposal(currentProposal, thread.latestProposal);
              if (!nextProposal) continue;
              threadProposals[thread.id] = nextProposal;
              if (shouldClearSubmittedProposalForProposal(submittedProposalImplementations[thread.id], nextProposal)) {
                submittedProposalImplementations = withoutRecordKey(submittedProposalImplementations, thread.id);
              }
            }
          }

          return {
            threads: nextThreads,
            threadPlans,
            threadProposals,
            submittedProposalImplementations,
            hasInitializedThreads: true,
            threadOpenabilityContext,
          };
        }),
      newThread: async (projectId, workspaceId) => {
        const localThread = { ...createLocalThread(), projectId, workspaceId };
        const surface = useWorkspaceSurfaceStore.getState();
        const surfaceThreadId = surface.threadId;
        set((state) => ({
          threads: [localThread, ...state.threads.filter((thread) => thread.id !== surfaceThreadId || !isDisposableDraftThread(thread)),],
        }));
        useWorkspaceSurfaceStore.getState().selectThread(localThread.id, toSurfaceThread(localThread), {
          preserveTerminalVisibility: Boolean(workspaceId),
        });
      },
      ensureThreadPersisted: async (threadId, title) => {
        const existing = get().threads.find((thread) => thread.id === threadId);
        if (!isDraftThread(existing)) return;

        const threadTitle = title?.trim() || existing?.title || '...';
        const now = new Date().toISOString();
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId
              ? { ...thread, title: threadTitle, updatedAt: now, draft: false, persistenceState: 'creating' }
              : thread,
          ),
        }));

        let serverThread: ChatThread;
        try {
          serverThread = existing?.projectId
            ? (await createProjectThread(existing.projectId, threadId, existing.workspaceId, threadTitle)).thread
            : await createServerThread(threadId, undefined, undefined, threadTitle);
        } catch (error) {
          set((state) => ({
            threads: state.threads.map((thread) =>
              thread.id === threadId && thread.persistenceState === 'creating'
                ? { ...thread, draft: true, persistenceState: undefined }
                : thread,
            ),
          }));
          throw error;
        }

        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId
              ? {
                ...serverThread,
                title: thread.title && !['New chat', '...'].includes(thread.title) ? thread.title : serverThread.title,
                ...(thread.persistenceState === 'creating'
                  ? { persistenceState: 'awaiting_server_list' as const }
                  : {}),
              }
              : thread,
          ),
        }));
      },
      selectThread: ( threadId) =>
        set((state) => {
          const nextThread = state.threads.find((thread) => thread.id === threadId);
          const surfaceThreadId = useWorkspaceSurfaceStore.getState().threadId;
          useWorkspaceSurfaceStore.getState().selectThread(threadId, nextThread ? toSurfaceThread(nextThread) : undefined);
          if (surfaceThreadId === threadId) {
            return {
              completedThreadIds: state.completedThreadIds.filter((id) => id !== threadId),
            };
          }

          const currentThread = state.threads.find((thread) => thread.id === surfaceThreadId);
          const shouldDiscardCurrentDraft =
            isDisposableDraftThread(currentThread) && state.threads.some((thread) => thread.id === threadId);

          return {
            threads: shouldDiscardCurrentDraft
              ? state.threads.filter((thread) => thread.id !== surfaceThreadId)
              : state.threads,
            runningThreadIds: shouldDiscardCurrentDraft
              ? state.runningThreadIds.filter((id) => id !== surfaceThreadId)
              : state.runningThreadIds,
            completedThreadIds: state.completedThreadIds.filter(
              (id) => id !== threadId && (!shouldDiscardCurrentDraft || id !== surfaceThreadId),),
            guidedTaskExpandedByThread: {
              ...state.guidedTaskExpandedByThread,
              [threadId]: false,
            },
          };
        }),
      archiveThread: async ( threadId) => {
        if (isDraftThread(get().threads.find((thread) => thread.id === threadId))) {
          set((state) => {
            const threads = state.threads.filter((thread) => thread.id !== threadId);
            const nextThreads = threads.length > 0 ? threads : [createLocalThread()];
            const fallback = withOpenableThreadFallback(nextThreads, state.threadOpenabilityContext, state.threads);
            useWorkspaceSurfaceStore.getState().syncThreads(fallback.openableThreads.map(toSurfaceThread), {
              workspaceRefs: state.threadOpenabilityContext.workspaceRefs,
            });
            return {
              threads: fallback.threads,
              runningThreadIds: state.runningThreadIds.filter((id) => id !== threadId),
              completedThreadIds: state.completedThreadIds.filter((id) => id !== threadId),
              submittedProposalImplementations: withoutRecordKey(state.submittedProposalImplementations, threadId),
            };
          });
          return;
        }

        set((state) => {
          const nextThreads = state.threads.map((thread) => thread.id === threadId ? { ...thread, archived: true } : thread,);
          const fallback = withOpenableThreadFallback(nextThreads, state.threadOpenabilityContext, state.threads);
          useWorkspaceSurfaceStore.getState().syncThreads(fallback.openableThreads.map(toSurfaceThread), {
            workspaceRefs: state.threadOpenabilityContext.workspaceRefs,
          });
          return {
            threads: fallback.threads,
            runningThreadIds: state.runningThreadIds.filter((id) => id !== threadId),
            completedThreadIds: state.completedThreadIds.filter((id) => id !== threadId),
            submittedProposalImplementations: withoutRecordKey(state.submittedProposalImplementations, threadId),
          };
        });
        await archiveServerThread(threadId, true);
      },
      restoreThread: async ( threadId) => {
        set((state) => ({
          threads: state.threads.map((thread) => ( thread.id === threadId ? { ...thread, archived: false } : thread)),
        }));
        await archiveServerThread(threadId, false);
      },
      deleteThread: async ( threadId) => {
        const previousState = get();
        const previousSurfaceState = getSurfaceSnapshot();
        const isDraft = isDraftThread(previousState.threads.find((thread) => thread.id === threadId));

        set((state) => {
          const threads = state.threads.filter((thread) => thread.id !== threadId);
          const fallback = withOpenableThreadFallback(
            threads.length > 0 ? threads : [createLocalThread()],
            state.threadOpenabilityContext,
            state.threads,
          );
          useWorkspaceSurfaceStore.getState().syncThreads(fallback.openableThreads.map(toSurfaceThread), {
            workspaceRefs: state.threadOpenabilityContext.workspaceRefs,
          });

          return {
            threads: fallback.threads,
            runningThreadIds: state.runningThreadIds.filter((id) => id !== threadId),
            completedThreadIds: state.completedThreadIds.filter((id) => id !== threadId),
            deletedThreadIds: isDraft || state.deletedThreadIds.includes(threadId) ? state.deletedThreadIds : [...state.deletedThreadIds, threadId],
            submittedProposalImplementations: withoutRecordKey(state.submittedProposalImplementations, threadId),
          };
        });

        if (isDraft) {
          useClientSessionViewStore.getState().discardThreadView(threadId); return;
        }

        try {
          await deleteServerThread(threadId);
          useClientSessionViewStore.getState().discardThreadView(threadId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('thread not found')) {
            useClientSessionViewStore.getState().discardThreadView(threadId); return;
          }

          set({
            threads: previousState.threads,
            runningThreadIds: previousState.runningThreadIds,
            completedThreadIds: previousState.completedThreadIds,
            deletedThreadIds: previousState.deletedThreadIds,
            submittedProposalImplementations: previousState.submittedProposalImplementations,
          });
          useWorkspaceSurfaceStore.getState().restoreSurfaceSnapshot(previousSurfaceState);
          throw error;
        }
      },
      setThreadRunning: (threadId, running) =>
        set((state) => ({
          runningThreadIds: running
            ? state.runningThreadIds.includes(threadId)
              ? state.runningThreadIds
              : [...state.runningThreadIds, threadId]
            : state.runningThreadIds.filter((id) => id !== threadId),
          completedThreadIds: running
            ? state.completedThreadIds.filter((id) => id !== threadId)
            : state.completedThreadIds,
        })),
      markThreadCompleted: ( threadId) =>
        set((state) => ({
          completedThreadIds: state.completedThreadIds.includes(threadId)
            ? state.completedThreadIds
            : [...state.completedThreadIds, threadId],
        })),
      clearThreadCompleted: ( threadId) =>
        set((state) => ({
          completedThreadIds: state.completedThreadIds.filter((id) => id !== threadId),
        })),
      touchThread: (threadId, title, reorder = false) => {
        const now = new Date().toISOString();
        const existing = get().threads.find((thread) => thread.id === threadId);
        const threadTitle = title?.trim() || existing?.title || '...';
        const hasPlaceholderTitle = !existing?.title || ['New chat', '...'].includes(existing.title);

        const shouldRename = Boolean(title?.trim() && hasPlaceholderTitle);
        if (shouldRename) {
          void renameServerThread(threadId, threadTitle).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('thread not found')) { console.error('[chat-store] Failed to rename thread', error);
          }
          });
        }

        set((state) => ({
          threads: state.threads
            .map((thread) =>
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
      name: getClientAppStorageKey('weave-chat'),
      version: 14,
      storage: createClientAppPersistStorage('weave-chat'),
      migrate: ( persistedState) => {
        const state = persistedState as Partial<PersistedChatState>;
        return {
          selectedModel: typeof state.selectedModel === 'string' ? state.selectedModel : '',
          reasoningEffort: normalizeReasoningEffort(state.reasoningEffort),
          serviceTier: normalizeServiceTier(state.serviceTier),
          executionProfile:
            state.executionProfile === 'observe' || state.executionProfile === 'host'
              ? state.executionProfile
              : 'workspace',
          followWrites: typeof state.followWrites === 'boolean' ? state.followWrites : false,
          showToolCalls: typeof state.showToolCalls === 'boolean' ? state.showToolCalls : true,
          showReasoning: typeof state.showReasoning === 'boolean' ? state.showReasoning : true,
          showPlanPanel: typeof state.showPlanPanel === 'boolean' ? state.showPlanPanel : true,
          toolActivityCollapsed: state.toolActivityCollapsed && typeof state.toolActivityCollapsed === 'object' && !Array.isArray(state.toolActivityCollapsed)
            ? state.toolActivityCollapsed
            : {},
        };
      },
      partialize: ( state) => ({
        selectedModel: state.selectedModel,
        reasoningEffort: state.reasoningEffort,
        serviceTier: state.serviceTier,
        executionProfile: state.executionProfile,
        followWrites: state.followWrites,
        showToolCalls: state.showToolCalls,
        showReasoning: state.showReasoning,
        showPlanPanel: state.showPlanPanel,
      }),
    },
  ),
);

const toPersistedLocalDraft = (thread: ChatThread): PersistedLocalDraft => ({
  id: thread.id,
  title: thread.title,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  ...(thread.projectId ? { projectId: thread.projectId } : {}),
  ...(thread.workspaceId ? { workspaceId: thread.workspaceId } : {}),
});

export const resetChatClientSession = () => {
  const session = useClientSessionViewStore.getState();
  const drafts: ChatThread[] = session.localDrafts.map((draft) => ({
    ...draft,
    draft: true,
  }));
  useChatStore.setState({
    resourceId: createClientId('browser-user'),
    threads: drafts,
    runningThreadIds: [],
    completedThreadIds: [],
    deletedThreadIds: [],
    threadPlans: {},
    threadProposals: {},
    pendingProposalImplementationRequests: {},
    submittedProposalImplementations: {},
    guidedTaskExpandedByThread: session.guidedTaskExpandedByThread,
    toolActivityCollapsed: Object.fromEntries(
      Object.entries(session.toolActivityCollapsed).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
      ),
    ),
    hasInitializedThreads: false,
    threadOpenabilityContext: emptyThreadOpenabilityContext,
  });
};

let lastPersistedDrafts = '';
let lastPersistedGuidedTaskState: Record<string, boolean | undefined> | undefined;
let lastPersistedToolActivityState: Record<string, boolean> | undefined;

useChatStore.subscribe((state) => {
  if (!getActiveClientSessionIdentity()) return;
  const drafts = state.threads.filter(isDraftThread).map(toPersistedLocalDraft);
  const serializedDrafts = JSON.stringify(drafts);
  const session = useClientSessionViewStore.getState();
  if (serializedDrafts !== lastPersistedDrafts) {
    lastPersistedDrafts = serializedDrafts;
    session.setLocalDrafts(drafts);
  }
  if (state.guidedTaskExpandedByThread !== lastPersistedGuidedTaskState) {
    lastPersistedGuidedTaskState = state.guidedTaskExpandedByThread;
    for (const [threadId, expanded] of Object.entries(state.guidedTaskExpandedByThread)) {
      if (typeof expanded === 'boolean') {
        session.setGuidedTaskExpanded(threadId, expanded);
      }
    }
  }
  if (state.toolActivityCollapsed !== lastPersistedToolActivityState) {
    lastPersistedToolActivityState = state.toolActivityCollapsed;
    for (const [groupId, collapsed] of Object.entries(state.toolActivityCollapsed)) {
      session.setToolActivityCollapsed(groupId, collapsed);
    }
  }
});
