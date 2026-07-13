import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getClientAppStorageKey } from '../lib/client-app';
import {
  claimLegacyClientSessionStorage,
  type ClientSessionIdentity,
  createClientSessionPersistStorage,
  getClientSessionStorageKey,
  readClientSessionStorageValue,
  restoreClientSessionStorageValue,
} from '../lib/client-session';

export type PersistedLocalDraft = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  projectId?: string;
  workspaceId?: string;
};

export type ChatViewportAnchor = {
  messageId?: string;
  topOffset: number;
  followBottom: boolean;
};

type ClientSessionViewState = {
  localDrafts: PersistedLocalDraft[];
  composerDrafts: Record<string, string | undefined>;
  chatViewportByThread: Record<string, ChatViewportAnchor | undefined>;
  guidedTaskExpandedByThread: Record<string, boolean | undefined>;
  expandedAssistantTurnIdsByThread: Record<string, string[] | undefined>;
  toolActivityCollapsed: Record<string, boolean | undefined>;
  collapsedProjectIdsByScope: Record<string, string[] | undefined>;
  setLocalDrafts: (drafts: PersistedLocalDraft[]) => void;
  setComposerDraft: (threadId: string, text: string) => void;
  clearComposerDraft: (threadId: string) => void;
  setChatViewport: (threadId: string, anchor: ChatViewportAnchor) => void;
  setGuidedTaskExpanded: (threadId: string, expanded: boolean) => void;
  setExpandedAssistantTurnIds: (threadId: string, messageIds: string[]) => void;
  setToolActivityCollapsed: (groupId: string, collapsed: boolean) => void;
  setCollapsedProjectIds: (scope: string, projectIds: string[]) => void;
  discardThreadView: (threadId: string) => void;
  reconcileThreadViews: (threadIds: ReadonlySet<string>) => void;
  reconcileProjects: (projectIds: ReadonlySet<string>) => void;
};

const initialClientSessionViewState = () => ({
  localDrafts: [],
  composerDrafts: {},
  chatViewportByThread: {},
  guidedTaskExpandedByThread: {},
  expandedAssistantTurnIdsByThread: {},
  toolActivityCollapsed: {},
  collapsedProjectIdsByScope: {},
});

const normalizeRecord = <T>(
  value: unknown,
  predicate: (entry: unknown) => entry is T,
): Record<string, T | undefined> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => predicate(entry)));
};

const normalizePersistedState = (value: unknown) => {
  const state = value && typeof value === 'object' ? (value as Partial<ClientSessionViewState>) : {};
  const localDrafts = Array.isArray(state.localDrafts)
    ? state.localDrafts.filter((draft): draft is PersistedLocalDraft =>
        Boolean(
          draft &&
          typeof draft === 'object' &&
          typeof draft.id === 'string' &&
          draft.id &&
          typeof draft.title === 'string' &&
          typeof draft.createdAt === 'string' &&
          typeof draft.updatedAt === 'string',
        ),
      )
    : [];
  return {
    localDrafts,
    composerDrafts: normalizeRecord(
      state.composerDrafts,
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    ),
    chatViewportByThread: normalizeRecord(state.chatViewportByThread, (entry): entry is ChatViewportAnchor => {
      if (!entry || typeof entry !== 'object') return false;
      const record = entry as Record<string, unknown>;
      return (
        typeof record.topOffset === 'number' &&
        typeof record.followBottom === 'boolean' &&
        (record.messageId === undefined || typeof record.messageId === 'string')
      );
    }),
    guidedTaskExpandedByThread: normalizeRecord(
      state.guidedTaskExpandedByThread,
      (entry): entry is boolean => typeof entry === 'boolean',
    ),
    expandedAssistantTurnIdsByThread: normalizeRecord(
      state.expandedAssistantTurnIdsByThread,
      (entry): entry is string[] => Array.isArray(entry) && entry.every((id) => typeof id === 'string'),
    ),
    toolActivityCollapsed: normalizeRecord(
      state.toolActivityCollapsed,
      (entry): entry is boolean => typeof entry === 'boolean',
    ),
    collapsedProjectIdsByScope: normalizeRecord(
      state.collapsedProjectIdsByScope,
      (entry): entry is string[] => Array.isArray(entry) && entry.every((item) => typeof item === 'string'),
    ),
  };
};

export const useClientSessionViewStore = create<ClientSessionViewState>()(
  persist(
    (set) => ({
      ...initialClientSessionViewState(),
      setLocalDrafts: (localDrafts) => set({ localDrafts }),
      setComposerDraft: (threadId, text) =>
        set((state) => {
          const composerDrafts = { ...state.composerDrafts };
          if (text) composerDrafts[threadId] = text;
          else delete composerDrafts[threadId];
          return { composerDrafts };
        }),
      clearComposerDraft: (threadId) =>
        set((state) => {
          const composerDrafts = { ...state.composerDrafts };
          delete composerDrafts[threadId];
          return { composerDrafts };
        }),
      setChatViewport: (threadId, anchor) =>
        set((state) => ({
          chatViewportByThread: {
            ...state.chatViewportByThread,
            [threadId]: anchor,
          },
        })),
      setGuidedTaskExpanded: (threadId, expanded) =>
        set((state) => ({
          guidedTaskExpandedByThread: {
            ...state.guidedTaskExpandedByThread,
            [threadId]: expanded,
          },
        })),
      setExpandedAssistantTurnIds: (threadId, messageIds) =>
        set((state) => {
          const current = state.expandedAssistantTurnIdsByThread[threadId] ?? [];
          if (current.length === messageIds.length && current.every((id, index) => id === messageIds[index])) {
            return state;
          }
          return {
            expandedAssistantTurnIdsByThread: {
              ...state.expandedAssistantTurnIdsByThread,
              [threadId]: messageIds,
            },
          };
        }),
      setToolActivityCollapsed: (groupId, collapsed) =>
        set((state) => ({
          toolActivityCollapsed: {
            ...state.toolActivityCollapsed,
            [groupId]: collapsed,
          },
        })),
      setCollapsedProjectIds: (scope, projectIds) =>
        set((state) => {
          const current = state.collapsedProjectIdsByScope[scope] ?? [];
          if (current.length === projectIds.length && current.every((id, index) => id === projectIds[index]))
            return state;
          return {
            collapsedProjectIdsByScope: {
              ...state.collapsedProjectIdsByScope,
              [scope]: projectIds,
            },
          };
        }),
      discardThreadView: (threadId) =>
        set((state) => {
          const composerDrafts = { ...state.composerDrafts };
          const chatViewportByThread = { ...state.chatViewportByThread };
          const guidedTaskExpandedByThread = {
            ...state.guidedTaskExpandedByThread,
          };
          const expandedAssistantTurnIdsByThread = {
            ...state.expandedAssistantTurnIdsByThread,
          };
          delete composerDrafts[threadId];
          delete chatViewportByThread[threadId];
          delete guidedTaskExpandedByThread[threadId];
          delete expandedAssistantTurnIdsByThread[threadId];
          return {
            composerDrafts,
            chatViewportByThread,
            guidedTaskExpandedByThread,
            expandedAssistantTurnIdsByThread,
          };
        }),
      reconcileThreadViews: (threadIds) =>
        set((state) => {
          const records = [
            state.composerDrafts,
            state.chatViewportByThread,
            state.guidedTaskExpandedByThread,
            state.expandedAssistantTurnIdsByThread,
          ];
          if (records.every((record) => Object.keys(record).every((threadId) => threadIds.has(threadId)))) {
            return state;
          }
          const keep = <T>(record: Record<string, T | undefined>) =>
            Object.fromEntries(Object.entries(record).filter(([threadId]) => threadIds.has(threadId)));
          return {
            composerDrafts: keep(state.composerDrafts),
            chatViewportByThread: keep(state.chatViewportByThread),
            guidedTaskExpandedByThread: keep(state.guidedTaskExpandedByThread),
            expandedAssistantTurnIdsByThread: keep(state.expandedAssistantTurnIdsByThread),
          };
        }),
      reconcileProjects: (projectIds) =>
        set((state) => {
          let didChange = false;
          const collapsedProjectIdsByScope = Object.fromEntries(
            Object.entries(state.collapsedProjectIdsByScope).map(([scope, ids]) => {
              const currentIds = ids ?? [];
              const filteredIds = currentIds.filter((id) => projectIds.has(id));
              if (filteredIds.length === currentIds.length) return [scope, ids];
              didChange = true;
              return [scope, filteredIds];
            }),
          );
          return didChange ? { collapsedProjectIdsByScope } : state;
        }),
    }),
    {
      name: getClientAppStorageKey('weave-session-view'),
      version: 1,
      skipHydration: true,
      storage: createClientSessionPersistStorage(),
      migrate: normalizePersistedState,
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...normalizePersistedState(persistedState),
      }),
      partialize: (state) => ({
        localDrafts: state.localDrafts,
        composerDrafts: state.composerDrafts,
        chatViewportByThread: state.chatViewportByThread,
        guidedTaskExpandedByThread: state.guidedTaskExpandedByThread,
        expandedAssistantTurnIdsByThread: state.expandedAssistantTurnIdsByThread,
        toolActivityCollapsed: state.toolActivityCollapsed,
        collapsedProjectIdsByScope: state.collapsedProjectIdsByScope,
      }),
    },
  ),
);

export const activateClientSessionViewStore = async (identity: ClientSessionIdentity) => {
  const name = getClientSessionStorageKey('weave-session-view', identity);
  claimLegacyClientSessionStorage(name, [getClientAppStorageKey('weave-session-view')]);
  const persistedState = readClientSessionStorageValue(name);
  useClientSessionViewStore.persist.setOptions({
    name,
    storage: createClientSessionPersistStorage(),
  });
  useClientSessionViewStore.setState(initialClientSessionViewState());
  restoreClientSessionStorageValue(name, persistedState);
  await useClientSessionViewStore.persist.rehydrate();
};
