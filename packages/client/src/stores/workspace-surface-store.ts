import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createClientId } from '../lib/client-id';

export type ActiveSurface =
  | { kind: 'thread'; threadId: string }
  | { kind: 'workspace'; projectId: string; workspaceId: string };

export type MainPane = 'chat' | 'editor' | 'terminal';

export type PaneVisibility = {
  chatOpen: boolean;
  editorOpen: boolean;
  terminalOpen: boolean;
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

type WorkspaceSurfaceState = {
  threadId: string;
  activeSurface: ActiveSurface;
  paneVisibility: PaneVisibility;
  maximizedPane: MainPane | null;
  preMaximizePaneVisibility?: PaneVisibility;
  selectThread: (threadId: string, thread?: ThreadSurfaceContext) => void;
  selectWorkspace: (projectId: string, workspaceId: string) => void;
  syncThreads: (threads: ThreadSurfaceContext[], options?: { selectThreadId?: string }) => void;
  openPane: (pane: MainPane) => void;
  closePane: (pane: MainPane) => void;
  togglePane: (pane: MainPane) => void;
  toggleMaximizedPane: (pane: MainPane) => void;
  restoreMaximizedPane: () => void;
  restoreSurfaceSnapshot: (snapshot: WorkspaceSurfaceSnapshot) => void;
};

export type WorkspaceSurfaceSnapshot = Pick<
  WorkspaceSurfaceState,
  'threadId' | 'activeSurface' | 'paneVisibility' | 'maximizedPane' | 'preMaximizePaneVisibility'
>;

export const initialSurfaceThreadId = createClientId('thread');

export const defaultPaneVisibility: PaneVisibility = { chatOpen: true, editorOpen: false, terminalOpen: false };

export const getPaneVisibilityForThread = (thread: ThreadSurfaceContext | undefined): PaneVisibility => ({
  chatOpen: true,
  editorOpen: Boolean(thread?.workspaceId),
  terminalOpen: false,
});

export const getEditorOnlyPaneVisibility = (): PaneVisibility => ({ chatOpen: false, editorOpen: true, terminalOpen: false });

const setPaneOpen = (paneVisibility: PaneVisibility, pane: MainPane, open: boolean): PaneVisibility => (
  pane === 'chat'
    ? { ...paneVisibility, chatOpen: open }
    : pane === 'editor'
      ? { ...paneVisibility, editorOpen: open }
      : { ...paneVisibility, terminalOpen: open }
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

const normalizePersistedPaneVisibility = (value: unknown): PaneVisibility | undefined => {
  if (!isPersistedPaneVisibility(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    chatOpen: value.chatOpen,
    editorOpen: value.editorOpen,
    terminalOpen: typeof record.terminalOpen === 'boolean' ? record.terminalOpen : false,
  };
};

const isPersistedMainPane = (value: unknown): value is MainPane => value === 'chat' || value === 'editor' || value === 'terminal';

const getClientStorage = () => {
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
    return globalThis.localStorage as Storage | undefined;
  }
  return undefined;
};

const readLegacyChatSurfaceState = () => {
  const storage = getClientStorage();
  if (!storage) return undefined;

  try {
    const raw = storage.getItem('weave-chat');
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
    maximizedPane: isPersistedMainPane(legacyState?.maximizedPane) ? legacyState.maximizedPane : null,
    preMaximizePaneVisibility: normalizePersistedPaneVisibility(legacyState?.preMaximizePaneVisibility),
  };
};

const repairThreadSurface = (activeSurface: ActiveSurface, threads: ThreadSurfaceContext[], fallbackThreadId: string): ActiveSurface => {
  if (activeSurface.kind === 'workspace') return activeSurface;
  return threads.some(thread => thread.id === activeSurface.threadId)
    ? activeSurface
    : { kind: 'thread', threadId: fallbackThreadId };
};

const getThreadById = (threads: ThreadSurfaceContext[], threadId: string) => threads.find(thread => thread.id === threadId);

export const useWorkspaceSurfaceStore = create<WorkspaceSurfaceState>()(
  persist(
    (set, get) => ({
      ...getInitialPersistedSurfaceState(),
      selectThread: (threadId, thread) =>
        set({
          threadId,
          activeSurface: { kind: 'thread', threadId },
          paneVisibility: getPaneVisibilityForThread(thread),
          maximizedPane: null,
          preMaximizePaneVisibility: undefined,
        }),
      selectWorkspace: (projectId, workspaceId) =>
        set({
          activeSurface: { kind: 'workspace', projectId, workspaceId },
          paneVisibility: getEditorOnlyPaneVisibility(),
          maximizedPane: null,
          preMaximizePaneVisibility: undefined,
        }),
      syncThreads: (threads, options) =>
        set(state => {
          if (options?.selectThreadId) {
            const selectedThread = getThreadById(threads, options.selectThreadId);
            return {
              threadId: options.selectThreadId,
              activeSurface: { kind: 'thread' as const, threadId: options.selectThreadId },
              paneVisibility: getPaneVisibilityForThread(selectedThread),
              maximizedPane: null,
              preMaximizePaneVisibility: undefined,
            };
          }

          const nextThreadId = threads.some(thread => thread.id === state.threadId)
            ? state.threadId
            : threads[0]?.id || state.threadId;
          const nextActiveSurface = repairThreadSurface(state.activeSurface, threads, nextThreadId);
          const didRepairThreadSurface = nextActiveSurface !== state.activeSurface;
          const nextSelectedThread = nextActiveSurface.kind === 'thread'
            ? getThreadById(threads, nextActiveSurface.threadId)
            : undefined;

          return {
            threadId: nextThreadId,
            activeSurface: nextActiveSurface,
            paneVisibility: didRepairThreadSurface && nextActiveSurface.kind === 'thread'
              ? getPaneVisibilityForThread(nextSelectedThread)
              : state.paneVisibility,
            maximizedPane: didRepairThreadSurface && nextActiveSurface.kind === 'thread' ? null : state.maximizedPane,
            preMaximizePaneVisibility: didRepairThreadSurface && nextActiveSurface.kind === 'thread'
              ? undefined
              : state.preMaximizePaneVisibility,
          };
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
          const isOpen = pane === 'chat'
            ? state.paneVisibility.chatOpen
            : pane === 'editor'
              ? state.paneVisibility.editorOpen
              : state.paneVisibility.terminalOpen;
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
              terminalOpen: pane === 'terminal',
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
      restoreSurfaceSnapshot: snapshot => set(snapshot),
    }),
    {
      name: 'weave-surface',
      version: 1,
      migrate: persistedState => {
        const state = persistedState as Partial<WorkspaceSurfaceState>;
        const legacyState = getInitialPersistedSurfaceState();
        const threadId = typeof state.threadId === 'string' && state.threadId ? state.threadId : legacyState.threadId;
        return {
          threadId,
          activeSurface: isPersistedActiveSurface(state.activeSurface) ? state.activeSurface : legacyState.activeSurface,
          paneVisibility: normalizePersistedPaneVisibility(state.paneVisibility) ?? legacyState.paneVisibility,
          maximizedPane: isPersistedMainPane(state.maximizedPane) ? state.maximizedPane : legacyState.maximizedPane,
          preMaximizePaneVisibility: normalizePersistedPaneVisibility(state.preMaximizePaneVisibility) ?? legacyState.preMaximizePaneVisibility,
        };
      },
      partialize: state => ({
        threadId: state.threadId,
        activeSurface: state.activeSurface,
        paneVisibility: state.paneVisibility,
        maximizedPane: state.maximizedPane,
        preMaximizePaneVisibility: state.preMaximizePaneVisibility,
      }),
    },
  ),
);

export const getCurrentSurfaceThreadId = () => useWorkspaceSurfaceStore.getState().threadId;
