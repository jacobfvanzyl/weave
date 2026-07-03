import { create } from 'zustand';
import type { EditorMode } from '../lib/editor-types';

export type LiveEditorContextRequest = {
  mode?: EditorMode;
  projectId?: string;
  workspaceId?: string;
};

export type LiveEditorContextTab = {
  active: boolean;
  dirty: boolean;
  loaded: boolean;
  path: string;
  preview: boolean;
};

export type LiveEditorTextRange = {
  from: number;
  to: number;
  fromLine: number;
  toLine: number;
  text: string;
  textTruncated?: boolean;
};

export type LiveEditorCodeMirrorSnapshot = {
  selection?: LiveEditorTextRange;
  visibleRange?: LiveEditorTextRange;
};

export type LiveEditorCoppermindSectionPlacement =
  | { state: 'unplaced' }
  | { state: 'placed'; xywh: [number, number, number, number] };

export type LiveEditorCoppermindSection = {
  childCount: number;
  empty: boolean;
  id: string;
  kind: 'blocks' | 'ink';
  placement: LiveEditorCoppermindSectionPlacement;
  preview?: string;
  previewTruncated?: boolean;
  title: string;
};

export type LiveEditorCoppermindSnapshot = {
  activeSectionId?: string;
  canvasSelection?: {
    editing: boolean;
    selectedIds: string[];
  };
  mode: 'page' | 'edgeless';
  sections: LiveEditorCoppermindSection[];
  viewport?: {
    center?: [number, number];
    zoom?: number;
  };
};

export type LiveEditorActiveBuffer = {
  codeMirror?: LiveEditorCodeMirrorSnapshot;
  contentHash: string;
  coppermind?: LiveEditorCoppermindSnapshot;
  dirty: boolean;
  documentKind?: string;
  mediaType?: string;
  path: string;
  size?: number;
  version?: string;
};

export type LiveEditorContextSnapshot = {
  activePath?: string;
  activeTabId?: string;
  activeBuffer?: LiveEditorActiveBuffer;
  mode: EditorMode;
  openTabs: LiveEditorContextTab[];
  projectId: string;
  projectName: string;
  targetKey: string;
  updatedAt: string;
  workspaceId: string;
  workspaceName: string;
};

export type LiveEditorContextCollector = (request?: LiveEditorContextRequest) => LiveEditorContextSnapshot | undefined;

type LiveEditorContextStoreState = {
  collectors: Record<string, LiveEditorContextCollector | undefined>;
  collect: (request?: LiveEditorContextRequest) => LiveEditorContextSnapshot | undefined;
  registerCollector: (targetKey: string, collector: LiveEditorContextCollector) => () => void;
  unregisterCollector: (targetKey: string, collector?: LiveEditorContextCollector) => void;
};

const matchesRequest = (snapshot: LiveEditorContextSnapshot, request: LiveEditorContextRequest = {}) => (
  (!request.projectId || snapshot.projectId === request.projectId)
  && (!request.workspaceId || snapshot.workspaceId === request.workspaceId)
  && (!request.mode || snapshot.mode === request.mode)
);

export const useLiveEditorContextStore = create<LiveEditorContextStoreState>()((set, get) => ({
  collectors: {},
  collect: request => {
    const snapshots = Object.values(get().collectors)
      .flatMap(collector => collector?.(request) ?? [])
      .filter(snapshot => matchesRequest(snapshot, request));
    return snapshots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  },
  registerCollector: (targetKey, collector) => {
    set(state => ({
      collectors: {
        ...state.collectors,
        [targetKey]: collector,
      },
    }));
    return () => get().unregisterCollector(targetKey, collector);
  },
  unregisterCollector: (targetKey, collector) =>
    set(state => {
      if (!state.collectors[targetKey]) return state;
      if (collector && state.collectors[targetKey] !== collector) return state;
      const next = { ...state.collectors };
      delete next[targetKey];
      return { collectors: next };
    }),
}));

export const collectLiveEditorContext = (request?: LiveEditorContextRequest) =>
  useLiveEditorContextStore.getState().collect(request);
