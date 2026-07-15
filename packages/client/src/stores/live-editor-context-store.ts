import { create } from "zustand";
import type {
  LiveEditorContextRequest,
  LiveEditorContextSnapshot,
} from "@weave/protocol";

export type {
  LiveEditorActiveBuffer,
  LiveEditorCodeMirrorSnapshot,
  LiveEditorContextRequest,
  LiveEditorContextSnapshot,
  LiveEditorContextTab,
  LiveEditorCoppermindSection,
  LiveEditorCoppermindSectionPlacement,
  LiveEditorCoppermindSnapshot,
  LiveEditorTextRange,
} from "@weave/protocol";

export type LiveEditorContextCollector = (
  request?: LiveEditorContextRequest,
) => LiveEditorContextSnapshot | undefined;

type LiveEditorContextStoreState = {
  collectors: Record<string, LiveEditorContextCollector | undefined>;
  collect: (
    request?: LiveEditorContextRequest,
  ) => LiveEditorContextSnapshot | undefined;
  registerCollector: (
    targetKey: string,
    collector: LiveEditorContextCollector,
  ) => () => void;
  unregisterCollector: (
    targetKey: string,
    collector?: LiveEditorContextCollector,
  ) => void;
};

const matchesRequest = (
  snapshot: LiveEditorContextSnapshot,
  request: LiveEditorContextRequest = {},
) => (
  (!request.projectId || snapshot.projectId === request.projectId) &&
  (!request.workspaceId || snapshot.workspaceId === request.workspaceId) &&
  (!request.mode || snapshot.mode === request.mode)
);

export const useLiveEditorContextStore = create<LiveEditorContextStoreState>()((
  set,
  get,
) => ({
  collectors: {},
  collect: (request) => {
    const snapshots = Object.values(get().collectors)
      .flatMap((collector) => collector?.(request) ?? [])
      .filter((snapshot) => matchesRequest(snapshot, request));
    return snapshots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  },
  registerCollector: (targetKey, collector) => {
    set((state) => ({
      collectors: {
        ...state.collectors,
        [targetKey]: collector,
      },
    }));
    return () => get().unregisterCollector(targetKey, collector);
  },
  unregisterCollector: (targetKey, collector) =>
    set((state) => {
      if (!state.collectors[targetKey]) return state;
      if (collector && state.collectors[targetKey] !== collector) return state;
      const next = { ...state.collectors };
      delete next[targetKey];
      return { collectors: next };
    }),
}));

export const collectLiveEditorContext = (request?: LiveEditorContextRequest) =>
  useLiveEditorContextStore.getState().collect(request);
