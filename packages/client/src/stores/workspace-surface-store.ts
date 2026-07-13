import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createClientAppPersistStorage, getClientAppStorageItem, getClientAppStorageKey } from '../lib/client-app';
import {
  claimLegacyClientSessionStorage,
  type ClientSessionIdentity,
  createClientSessionPersistStorage,
  getClientSessionStorageKey,
  readClientSessionStorageValue,
  restoreClientSessionStorageValue,
} from '../lib/client-session';
import { createClientId } from '../lib/client-id';
import { proposalWorkflowEnabled } from '../lib/proposal-workflow';
import { workspaceRefKey } from '../lib/thread-eligibility';

export type ActiveSurface =
  | { kind: 'thread'; threadId: string }
  | { kind: 'workspace'; projectId: string; workspaceId: string };

export type MainPane = 'chat' | 'editor' | 'terminal';
export type TerminalPaneColumn = 'left' | 'right';
export type EditorSlotMode = 'editor' | 'proposal_review';

export type PaneVisibility = {
  chatOpen: boolean;
  editorOpen: boolean;
  terminalOpen: boolean;
};

export type EditorFollowRequest = {
  id: number;
  threadId: string;
  workspaceId: string;
  path: string;
  line: number;
  toolCallId: string;
};

export type ThreadSurfaceContext = {
  id: string;
  workspaceId?: string;
};

type PersistedLegacyChatState = {
  threadId?: unknown;
  activeSurface?: unknown;
  paneVisibility?: unknown;
  maximizedPane?: unknown;
  preMaximizePaneVisibility?: unknown;
};

type PersistedLegacyChatEnvelope = {
  state?: PersistedLegacyChatState;
};

type SurfaceLayout = {
  paneVisibility: PaneVisibility;
  editorSlotMode: EditorSlotMode;
  activeProposalPath?: string;
  activeProposalFilePath?: string;
  maximizedPane: MainPane | null;
  preMaximizePaneVisibility?: PaneVisibility;
};

type WorkspaceSurfaceState = {
  threadId: string;
  activeSurface: ActiveSurface;
  paneVisibility: PaneVisibility;
  editorSlotMode: EditorSlotMode;
  activeProposalPath?: string;
  activeProposalFilePath?: string;
  surfaceLayouts: Record<string, SurfaceLayout | undefined>;
  terminalPaneColumnsByWorkspace: Record<string, TerminalPaneColumn | undefined>;
  editorFollowRequest?: EditorFollowRequest;
  maximizedPane: MainPane | null;
  preMaximizePaneVisibility?: PaneVisibility;
  selectThread: (threadId: string, thread?: ThreadSurfaceContext, options?: { preserveTerminalVisibility?: boolean },) => void;
  selectWorkspace: (projectId: string, workspaceId: string) => void;
  restoreSurface: (
    surface: ActiveSurface,
    thread?: ThreadSurfaceContext,
    options?: { useDefaultLayout?: boolean },) => void;
  syncThreads: (threads: ThreadSurfaceContext[], options?: { selectThreadId?: string; workspaceRefs?: ReadonlySet<string> },
  ) => void;
  reconcilePersistedSurfaces: (threadIds: ReadonlySet<string>, workspaceRefs: ReadonlySet<string>) => void;
  openPane: (pane: MainPane) => void;
  openProposalReview: (proposalPath: string, options?: { filePath?: string }) => void;
  closeProposalReview: () => void;
  closePane: (pane: MainPane) => void;
  togglePane: (pane: MainPane) => void;
  toggleMaximizedPane: (pane: MainPane) => void;
  restoreMaximizedPane: () => void;
  setTerminalPaneColumn: (projectId: string, workspaceId: string, column: TerminalPaneColumn) => void;
  toggleTerminalPaneColumn: (projectId: string, workspaceId: string) => void;
  requestEditorFollow: (request: Omit<EditorFollowRequest, 'id'>) => void;
  restoreSurfaceSnapshot: (snapshot: WorkspaceSurfaceSnapshot) => void;
};

export type WorkspaceSurfaceSnapshot = Pick<
  WorkspaceSurfaceState,
  | 'threadId'
  | 'activeSurface'
  | 'paneVisibility'
  | 'editorSlotMode'
  | 'activeProposalPath'
  | 'activeProposalFilePath'
  | 'surfaceLayouts'
  | 'terminalPaneColumnsByWorkspace'
  | 'maximizedPane'
  | 'preMaximizePaneVisibility'
>;

export const initialSurfaceThreadId = createClientId('thread');

export const defaultPaneVisibility: PaneVisibility = { chatOpen: true, editorOpen: false, terminalOpen: false, };
export const defaultTerminalPaneColumn: TerminalPaneColumn = 'left';

export const getPaneVisibilityForThread = (thread: ThreadSurfaceContext | undefined): PaneVisibility => ({
  chatOpen: true,
  editorOpen: Boolean(thread?.workspaceId),
  terminalOpen: false,
});

export const getEditorOnlyPaneVisibility = (): PaneVisibility => ({ chatOpen: false, editorOpen: true, terminalOpen: false, });

let editorFollowRequestId = 0;

const setPaneOpen = (paneVisibility: PaneVisibility, pane: MainPane, open: boolean): PaneVisibility =>
  pane === 'chat'
    ? { ...paneVisibility, chatOpen: open }
    : pane === 'editor'
      ? { ...paneVisibility, editorOpen: open }
      : { ...paneVisibility, terminalOpen: open };

const isPaneOpen = (paneVisibility: PaneVisibility, pane: MainPane) =>
  pane === 'chat'
    ? paneVisibility.chatOpen
    : pane === 'editor'
      ? paneVisibility.editorOpen
      : paneVisibility.terminalOpen;

const isPersistedTerminalPaneColumn = (value: unknown): value is TerminalPaneColumn => value === 'left' || value === 'right';

const surfaceLayoutKey = (surface: ActiveSurface) =>
  surface.kind === 'thread'
    ? `thread:${surface.threadId}`
    : `workspace:${surface.projectId}:${surface.workspaceId}`;

const captureSurfaceLayout = (state: Pick<WorkspaceSurfaceState,
    | 'paneVisibility' | 'editorSlotMode' | 'activeProposalPath' | 'activeProposalFilePath' | 'maximizedPane' | 'preMaximizePaneVisibility'>,): SurfaceLayout => ({
  paneVisibility: state.paneVisibility,
  editorSlotMode: state.editorSlotMode,
  activeProposalPath: state.activeProposalPath,
  activeProposalFilePath: state.activeProposalFilePath,
  maximizedPane: state.maximizedPane,
  preMaximizePaneVisibility: state.preMaximizePaneVisibility,
});

const saveCurrentSurfaceLayout = (
  state: Pick<WorkspaceSurfaceState,
    | 'activeSurface' | 'paneVisibility' | 'editorSlotMode' | 'activeProposalPath' | 'activeProposalFilePath' | 'surfaceLayouts' | 'maximizedPane' | 'preMaximizePaneVisibility'>,
) => ({
  ...state.surfaceLayouts,
  [surfaceLayoutKey(state.activeSurface)]: captureSurfaceLayout(state),
});

const defaultThreadSurfaceLayout = (thread: ThreadSurfaceContext | undefined): SurfaceLayout => ({
  paneVisibility: getPaneVisibilityForThread(thread),
  editorSlotMode: 'editor',
  activeProposalPath: undefined,
  activeProposalFilePath: undefined,
  maximizedPane: null,
  preMaximizePaneVisibility: undefined,
});

const defaultWorkspaceSurfaceLayout = (): SurfaceLayout => ({
  paneVisibility: getEditorOnlyPaneVisibility(),
  editorSlotMode: 'editor',
  activeProposalPath: undefined,
  activeProposalFilePath: undefined,
  maximizedPane: null,
  preMaximizePaneVisibility: undefined,
});

const restoreSurfaceLayout = (
  surfaceLayouts: Record<string, SurfaceLayout | undefined>,
  surface: ActiveSurface,
  fallback: SurfaceLayout,
) => surfaceLayouts[surfaceLayoutKey(surface)] ?? fallback;

const isPersistedActiveSurface = (value: unknown): value is ActiveSurface => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.kind === 'thread') { return typeof record.threadId === 'string' && Boolean(record.threadId);
  }
  if (record.kind === 'workspace') {
    return ( typeof record.projectId === 'string' && Boolean(record.projectId)
      && typeof record.workspaceId === 'string' && Boolean(record.workspaceId));
  }
  return false;
};

const isPersistedPaneVisibility = (value: unknown): value is PaneVisibility => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.chatOpen === 'boolean' && typeof record.editorOpen === 'boolean';
};

const normalizePersistedPaneVisibility = (value: unknown): PaneVisibility | undefined => {
  if (!isPersistedPaneVisibility(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    chatOpen: value.chatOpen,
    editorOpen: value.editorOpen,
    terminalOpen: typeof record.terminalOpen === 'boolean' ? record.terminalOpen : false,
  };
};

const normalizePersistedSurfaceLayout = (value: unknown): SurfaceLayout | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const paneVisibility = normalizePersistedPaneVisibility(record.paneVisibility);
  if (!paneVisibility) return undefined;
  const maximizedPane = isPersistedMainPane(record.maximizedPane) ? record.maximizedPane : null;
  const normalizedPaneVisibility = maximizedPane && !isPaneOpen(paneVisibility, maximizedPane)
    ? setPaneOpen(paneVisibility, maximizedPane, true)
    : paneVisibility;
  const editorSlotMode = proposalWorkflowEnabled && record.editorSlotMode === 'proposal_review' ? 'proposal_review' : 'editor';
  return {
    paneVisibility: normalizedPaneVisibility,
    editorSlotMode,
    activeProposalPath: editorSlotMode === 'proposal_review' && typeof record.activeProposalPath === 'string' ? record.activeProposalPath : undefined,
    activeProposalFilePath: editorSlotMode === 'proposal_review' && typeof record.activeProposalFilePath === 'string' ? record.activeProposalFilePath : undefined,
    maximizedPane,
    preMaximizePaneVisibility: maximizedPane
      ? normalizePersistedPaneVisibility(record.preMaximizePaneVisibility)
      : undefined,
  };
};

const normalizePersistedSurfaceLayouts = (value: unknown): Record<string, SurfaceLayout | undefined> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const layouts: Record<string, SurfaceLayout | undefined> = {};
  for (const [key, layout] of Object.entries(value)) {
    const normalizedLayout = normalizePersistedSurfaceLayout(layout);
    if (normalizedLayout) layouts[key] = normalizedLayout;
  }
  return layouts;
};

const normalizePersistedTerminalPaneColumns = (value: unknown): Record<string, TerminalPaneColumn | undefined> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const columns: Record<string, TerminalPaneColumn | undefined> = {};
  for (const [key, column] of Object.entries(value)) {
    if (key && isPersistedTerminalPaneColumn(column)) columns[key] = column;
  }
  return columns;
};

const isPersistedMainPane = (value: unknown): value is MainPane => value === 'chat' || value === 'editor' || value === 'terminal';

const getClientStorage = () => {
  if (typeof window !== 'undefined' && window.localStorage) { return window.localStorage;
  }
  if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
    return globalThis.localStorage as Storage | undefined;
  }
  return undefined;
};

const readLegacyChatSurfaceState = () => {
  const storage = getClientStorage();
  if (!storage) return undefined;

  try {
    const raw = getClientAppStorageItem('weave-chat');
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as PersistedLegacyChatEnvelope;
    return parsed.state;
  } catch {
    return undefined;
  }
};

const getInitialPersistedSurfaceState = () => {
  const legacyState = readLegacyChatSurfaceState();
  const threadId = typeof legacyState?.threadId === 'string' && legacyState.threadId
    ? legacyState.threadId
    : initialSurfaceThreadId;

  return {
    threadId,
    activeSurface: isPersistedActiveSurface(legacyState?.activeSurface)
      ? legacyState.activeSurface
      : { kind: 'thread' as const, threadId },
    paneVisibility: normalizePersistedPaneVisibility(legacyState?.paneVisibility) ?? defaultPaneVisibility,
    editorSlotMode: 'editor' as const,
    activeProposalPath: undefined,
    activeProposalFilePath: undefined,
    surfaceLayouts: {},
    terminalPaneColumnsByWorkspace: {},
    maximizedPane: isPersistedMainPane(legacyState?.maximizedPane) ? legacyState.maximizedPane : null,
    preMaximizePaneVisibility: normalizePersistedPaneVisibility(legacyState?.preMaximizePaneVisibility),
  };
};

const repairActiveSurface = (
  activeSurface: ActiveSurface,
  threads: ThreadSurfaceContext[],
  fallbackThreadId: string,
  workspaceRefs: ReadonlySet<string> | undefined,
): ActiveSurface => {
  if (activeSurface.kind === 'workspace') {
    return !workspaceRefs || workspaceRefs.has(workspaceRefKey(activeSurface.projectId, activeSurface.workspaceId))
      ? activeSurface
      : { kind: 'thread', threadId: fallbackThreadId };
  }
  return threads.some((thread) => thread.id === activeSurface.threadId)
    ? activeSurface
    : { kind: 'thread', threadId: fallbackThreadId };
};

const getThreadById = (threads: ThreadSurfaceContext[], threadId: string) => threads.find((thread) => thread.id === threadId);

const normalizePersistedSurfaceState = (
  persistedState: unknown,
  fallback: Pick<WorkspaceSurfaceState,
    | 'threadId' | 'activeSurface' | 'paneVisibility' | 'editorSlotMode' | 'activeProposalPath' | 'activeProposalFilePath' | 'surfaceLayouts' | 'terminalPaneColumnsByWorkspace' | 'maximizedPane' | 'preMaximizePaneVisibility'>,
) => {
  const state = persistedState && typeof persistedState === 'object'
    ? ( persistedState as Partial<WorkspaceSurfaceState>)
    : {};
  const threadId = typeof state.threadId === 'string' && state.threadId ? state.threadId : fallback.threadId;
  const paneVisibility = normalizePersistedPaneVisibility(state.paneVisibility) ?? fallback.paneVisibility;
  const maximizedPane = isPersistedMainPane(state.maximizedPane) ? state.maximizedPane : fallback.maximizedPane;
  const normalizedPaneVisibility = maximizedPane && !isPaneOpen(paneVisibility, maximizedPane)
    ? setPaneOpen(paneVisibility, maximizedPane, true)
    : paneVisibility;
  const editorSlotMode = proposalWorkflowEnabled && state.editorSlotMode === 'proposal_review'
    ? 'proposal_review'
    : proposalWorkflowEnabled
    ? fallback.editorSlotMode
    : 'editor';
  return {
    threadId,
    activeSurface: isPersistedActiveSurface(state.activeSurface) ? state.activeSurface : fallback.activeSurface,
    paneVisibility: normalizedPaneVisibility,
    editorSlotMode,
    activeProposalPath: editorSlotMode === 'proposal_review' && typeof state.activeProposalPath === 'string' ? state.activeProposalPath : undefined,
    activeProposalFilePath: editorSlotMode === 'proposal_review' && typeof state.activeProposalFilePath === 'string' ? state.activeProposalFilePath : undefined,
    surfaceLayouts: normalizePersistedSurfaceLayouts(state.surfaceLayouts ?? fallback.surfaceLayouts),
    terminalPaneColumnsByWorkspace: normalizePersistedTerminalPaneColumns(
      state.terminalPaneColumnsByWorkspace ?? fallback.terminalPaneColumnsByWorkspace,
    ),
    maximizedPane,
    preMaximizePaneVisibility: maximizedPane
      ? ( normalizePersistedPaneVisibility(state.preMaximizePaneVisibility) ?? fallback.preMaximizePaneVisibility)
      : undefined,
  };
};

export const useWorkspaceSurfaceStore = create<WorkspaceSurfaceState>()(
  persist(
    (set, get) => ({
      ...getInitialPersistedSurfaceState(),
      editorFollowRequest: undefined,
      selectThread: (threadId, thread, options) =>
        set((state) => {
          const nextActiveSurface: ActiveSurface = { kind: 'thread', threadId };
          const surfaceLayouts = saveCurrentSurfaceLayout(state);
          const fallbackLayout = defaultThreadSurfaceLayout(thread);
          if (options?.preserveTerminalVisibility) {
            fallbackLayout.paneVisibility = {
              ...fallbackLayout.paneVisibility,
              terminalOpen: state.paneVisibility.terminalOpen,
            };
          }
          const layout = restoreSurfaceLayout(surfaceLayouts, nextActiveSurface, fallbackLayout);
          const maximizedPane = layout.maximizedPane === 'chat' ? layout.maximizedPane : null;
          return {
            threadId,
            activeSurface: nextActiveSurface,
            surfaceLayouts,
            paneVisibility: {
              ...layout.paneVisibility,
              chatOpen: true,
              ...(options?.preserveTerminalVisibility ? { terminalOpen: state.paneVisibility.terminalOpen } : {}),
            },
            editorSlotMode: layout.editorSlotMode,
            activeProposalPath: layout.activeProposalPath,
            activeProposalFilePath: layout.activeProposalFilePath,
            maximizedPane,
            preMaximizePaneVisibility: maximizedPane ? layout.preMaximizePaneVisibility : undefined,
          };
        }),
      selectWorkspace: (projectId, workspaceId) =>
        set((state) => {
          const nextActiveSurface: ActiveSurface = { kind: 'workspace', projectId, workspaceId, };
          const surfaceLayouts = saveCurrentSurfaceLayout(state);
          const layout = restoreSurfaceLayout(surfaceLayouts, nextActiveSurface, defaultWorkspaceSurfaceLayout());
          return {
            activeSurface: nextActiveSurface,
            surfaceLayouts,
            paneVisibility: layout.paneVisibility,
            editorSlotMode: layout.editorSlotMode,
            activeProposalPath: layout.activeProposalPath,
            activeProposalFilePath: layout.activeProposalFilePath,
            maximizedPane: layout.maximizedPane,
            preMaximizePaneVisibility: layout.preMaximizePaneVisibility,
          };
        }),
      restoreSurface: (surface, thread, options) =>
        set((state) => {
          const nextThreadId = surface.kind === 'thread' ? surface.threadId : state.threadId;
          if (surfaceLayoutKey(surface) === surfaceLayoutKey(state.activeSurface)) {
            return {
              threadId: nextThreadId,
              activeSurface: surface,
              surfaceLayouts: {
                ...state.surfaceLayouts,
                [surfaceLayoutKey(surface)]: captureSurfaceLayout(state),
              },
            };
          }

          const surfaceLayouts = saveCurrentSurfaceLayout(state);
          const fallback =
            surface.kind === 'thread' ? defaultThreadSurfaceLayout(thread) : defaultWorkspaceSurfaceLayout();
          const layout = options?.useDefaultLayout ? fallback : restoreSurfaceLayout(surfaceLayouts, surface, fallback);
          return {
            threadId: nextThreadId,
            activeSurface: surface,
            surfaceLayouts,
            paneVisibility: layout.paneVisibility,
            editorSlotMode: layout.editorSlotMode,
            activeProposalPath: layout.activeProposalPath,
            activeProposalFilePath: layout.activeProposalFilePath,
            maximizedPane: layout.maximizedPane,
            preMaximizePaneVisibility: layout.preMaximizePaneVisibility,
          };
        }),
      syncThreads: (threads, options) =>
        set((state) => {
          if (options?.selectThreadId && getThreadById(threads, options.selectThreadId)) {
            const selectedThread = getThreadById(threads, options.selectThreadId);
            const nextActiveSurface: ActiveSurface = { kind: 'thread' as const, threadId: options.selectThreadId, };
            const surfaceLayouts = saveCurrentSurfaceLayout(state);
            const layout = restoreSurfaceLayout(surfaceLayouts, nextActiveSurface, defaultThreadSurfaceLayout(selectedThread),);
            return {
              threadId: options.selectThreadId,
              activeSurface: nextActiveSurface,
              surfaceLayouts,
              paneVisibility: layout.paneVisibility,
              editorSlotMode: layout.editorSlotMode,
              activeProposalPath: layout.activeProposalPath,
              activeProposalFilePath: layout.activeProposalFilePath,
              maximizedPane: layout.maximizedPane,
              preMaximizePaneVisibility: layout.preMaximizePaneVisibility,
            };
          }

          const nextThreadId = threads.some((thread) => thread.id === state.threadId)
            ? state.threadId
            : threads[0]?.id || state.threadId;
          const nextActiveSurface = repairActiveSurface(state.activeSurface, threads, nextThreadId, options?.workspaceRefs,);
          const didRepairThreadSurface = nextActiveSurface !== state.activeSurface;
          const nextSelectedThread = nextActiveSurface.kind === 'thread'
            ? getThreadById(threads, nextActiveSurface.threadId)
            : undefined;

          const surfaceLayouts = didRepairThreadSurface ? saveCurrentSurfaceLayout(state) : state.surfaceLayouts;
          const repairedLayout = didRepairThreadSurface && nextActiveSurface.kind === 'thread'
            ? restoreSurfaceLayout(surfaceLayouts, nextActiveSurface, defaultThreadSurfaceLayout(nextSelectedThread))
            : undefined;

          return {
            threadId: nextThreadId,
            activeSurface: nextActiveSurface,
            surfaceLayouts,
            paneVisibility: repairedLayout?.paneVisibility ?? state.paneVisibility,
            editorSlotMode: repairedLayout?.editorSlotMode ?? state.editorSlotMode,
            activeProposalPath: repairedLayout?.activeProposalPath ?? state.activeProposalPath,
            activeProposalFilePath: repairedLayout?.activeProposalFilePath ?? state.activeProposalFilePath,
            maximizedPane: repairedLayout ? repairedLayout.maximizedPane : state.maximizedPane,
            preMaximizePaneVisibility: repairedLayout
              ? repairedLayout.preMaximizePaneVisibility
              : state.preMaximizePaneVisibility,
          };
        }),
      reconcilePersistedSurfaces: (threadIds, workspaceRefs) =>
        set((state) => ({
          surfaceLayouts: Object.fromEntries(
            Object.entries(saveCurrentSurfaceLayout(state)).filter(([key]) => {
              if (key.startsWith('thread:')) {
                return threadIds.has(key.slice('thread:'.length));
              }
              if (!key.startsWith('workspace:')) return false;
              return workspaceRefs.has(key.slice('workspace:'.length));
            }),
          ),
          terminalPaneColumnsByWorkspace: Object.fromEntries(
            Object.entries(state.terminalPaneColumnsByWorkspace).filter(([key]) => workspaceRefs.has(key)),
          ),
        })),
      openPane: (pane) =>
        set((state) => isPaneOpen(state.paneVisibility, pane)
          ? state
          : {
              paneVisibility: setPaneOpen(state.paneVisibility, pane, true),
              maximizedPane: null,
              preMaximizePaneVisibility: undefined,
            },),
      openProposalReview: (proposalPath, options) =>
        set((state) => proposalWorkflowEnabled ?{
          activeProposalPath: proposalPath,
          activeProposalFilePath: options?.filePath ?? state.activeProposalFilePath,
          editorSlotMode: 'proposal_review',
          paneVisibility: setPaneOpen(
            state.maximizedPane && state.preMaximizePaneVisibility
              ? state.preMaximizePaneVisibility
              : state.paneVisibility,
            'editor',
            true,
          ),
          maximizedPane: null,
          preMaximizePaneVisibility: undefined,
        } : state,),
      closeProposalReview: () =>
        set((state) => ({
          editorSlotMode: 'editor',
          activeProposalPath: undefined,
          activeProposalFilePath: undefined,
          paneVisibility: setPaneOpen(state.paneVisibility, 'editor', true),
          maximizedPane: state.maximizedPane === 'editor' ? null : state.maximizedPane,
          preMaximizePaneVisibility: state.maximizedPane === 'editor' ? undefined : state.preMaximizePaneVisibility,
        })),
      closePane: ( pane) =>
        set((state) => {
          const restoredVisibility = state.maximizedPane === pane && state.preMaximizePaneVisibility
            ? state.preMaximizePaneVisibility
            : state.paneVisibility;
          return {
            paneVisibility: setPaneOpen(restoredVisibility, pane, false),
            maximizedPane: null,
            preMaximizePaneVisibility: undefined,
          };
        }),
      togglePane: ( pane) =>
        set((state) => {
          const isOpen = isPaneOpen(state.paneVisibility, pane);
          const restoredVisibility = state.maximizedPane && state.preMaximizePaneVisibility
            ? state.preMaximizePaneVisibility
            : state.paneVisibility;
          return {
            paneVisibility: setPaneOpen(restoredVisibility, pane, !isOpen),
            maximizedPane: null,
            preMaximizePaneVisibility: undefined,
          };
        }),
      toggleMaximizedPane: ( pane) =>
        set((state) => {
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
              terminalOpen: pane === 'terminal',
            },
            maximizedPane: pane,
            preMaximizePaneVisibility: previousPaneVisibility,
          };
        }),
      restoreMaximizedPane: () =>
        set((state) => state.maximizedPane
          ? {
              paneVisibility: state.preMaximizePaneVisibility ?? state.paneVisibility,
              maximizedPane: null,
              preMaximizePaneVisibility: undefined,
            }
          : state,),
      setTerminalPaneColumn: (projectId, workspaceId, column) =>
        set((state) => {
          const key = workspaceRefKey(projectId, workspaceId);
          if (state.terminalPaneColumnsByWorkspace[key] === column) { return state;
          }
          return {
            terminalPaneColumnsByWorkspace: {
              ...state.terminalPaneColumnsByWorkspace,
              [key]: column,
            },
          };
        }),
      toggleTerminalPaneColumn: (projectId, workspaceId) =>
        set((state) => {
          const key = workspaceRefKey(projectId, workspaceId);
          const currentColumn = state.terminalPaneColumnsByWorkspace[key] ?? defaultTerminalPaneColumn;
          return {
            terminalPaneColumnsByWorkspace: {
              ...state.terminalPaneColumnsByWorkspace,
              [key]: currentColumn === 'left' ? 'right' : 'left',
            },
          };
        }),
      requestEditorFollow: ( request) =>
        set((state) => ({
          editorFollowRequest: {
            ...request,
            id: ( editorFollowRequestId += 1),
          },
          editorSlotMode: 'editor',
          activeProposalPath: proposalWorkflowEnabled && state.editorSlotMode === 'proposal_review' ? state.activeProposalPath : undefined,
          activeProposalFilePath: proposalWorkflowEnabled && state.editorSlotMode === 'proposal_review' ? request.path : state.activeProposalFilePath,
          paneVisibility: setPaneOpen(
            state.maximizedPane && state.preMaximizePaneVisibility
              ? state.preMaximizePaneVisibility
              : state.paneVisibility,
            'editor',
            true,
          ),
          maximizedPane: null,
          preMaximizePaneVisibility: undefined,
        })),
      restoreSurfaceSnapshot: ( snapshot) => set(snapshot),
    }),
    {
      name: getClientAppStorageKey('weave-surface'),
      version: 1,
      skipHydration: true,
      storage: createClientAppPersistStorage('weave-surface'),
      migrate: ( persistedState) => {
        const legacyState = getInitialPersistedSurfaceState();
        return normalizePersistedSurfaceState(persistedState, legacyState);
      },
      merge: (persistedState, currentState) => {
        const normalizedState = normalizePersistedSurfaceState(persistedState, currentState);
        return { ...currentState, ...normalizedState };
      },
      partialize: ( state) => ({
        threadId: state.threadId,
        activeSurface: state.activeSurface,
        paneVisibility: state.paneVisibility,
        editorSlotMode: state.editorSlotMode,
        activeProposalPath: state.activeProposalPath,
        activeProposalFilePath: state.activeProposalFilePath,
        surfaceLayouts: saveCurrentSurfaceLayout( state),
        terminalPaneColumnsByWorkspace: state.terminalPaneColumnsByWorkspace,
        maximizedPane: state.maximizedPane,
        preMaximizePaneVisibility: state.preMaximizePaneVisibility,
      }),
    },
  ),
);

export const activateWorkspaceSurfaceSession = async (identity: ClientSessionIdentity) => {
  const name = getClientSessionStorageKey('weave-surface', identity);
  claimLegacyClientSessionStorage(name, [
    getClientAppStorageKey('weave-surface'),
    'weave-surface',
    'weave-surface.coppermind',
    'weave-surface.flare',
  ]);
  const persistedState = readClientSessionStorageValue(name);
  useWorkspaceSurfaceStore.persist.setOptions({
    name,
    storage: createClientSessionPersistStorage(),
  });
  useWorkspaceSurfaceStore.setState({
    ...getInitialPersistedSurfaceState(),
    editorFollowRequest: undefined,
  });
  restoreClientSessionStorageValue(name, persistedState);
  await useWorkspaceSurfaceStore.persist.rehydrate();
};

export const getCurrentSurfaceThreadId = () => useWorkspaceSurfaceStore.getState().threadId;
