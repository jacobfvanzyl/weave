import { useCallback, useMemo, useState } from 'react';
import type { Layout } from 'react-resizable-panels';

export const alphaPaneIds = {
  threads: 'threads',
  thread: 'thread',
  editor: 'editor',
  project: 'project',
} as const;

export type AlphaPaneId = (typeof alphaPaneIds)[keyof typeof alphaPaneIds];

export const alphaPaneMinimumWidths = {
  [alphaPaneIds.threads]: '11rem',
  [alphaPaneIds.thread]: 380,
  [alphaPaneIds.editor]: '15rem',
  [alphaPaneIds.project]: '12rem',
} as const satisfies Record<AlphaPaneId, number | string>;

export const alphaSidebarDefaultWidth = '20rem';
export const alphaPaneMinimumWidth = 375;
export const alphaSidebarMinimumWidth = 250;
export const alphaSidebarWidthStorageKey = 'weave.alpha.sidebar-width.v1';

type PersistedAlphaSidebarWidth = {
  schemaVersion: 1;
  size: number;
};

const parseSidebarWidth = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const input = value as Partial<PersistedAlphaSidebarWidth>;
  if (
    input.schemaVersion !== 1 ||
    typeof input.size !== 'number' ||
    !Number.isFinite(input.size) ||
    input.size <= 0 ||
    input.size >= 100
  ) return;
  return input.size;
};

const loadSidebarWidth = () => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    return parseSidebarWidth(
      JSON.parse(window.localStorage.getItem(alphaSidebarWidthStorageKey) ?? 'null'),
    );
  } catch {
    return undefined;
  }
};

const saveSidebarWidth = (size: number) => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(
    alphaSidebarWidthStorageKey,
    JSON.stringify({ schemaVersion: 1, size } satisfies PersistedAlphaSidebarWidth),
  );
};

const layoutChangeTolerance = 0.001;

export const layoutChangesOnlyPanePair = (
  previous: Layout,
  next: Layout,
  panePair: readonly [AlphaPaneId, AlphaPaneId],
) => {
  const paneIds = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...paneIds].every(
    (paneId) =>
      panePair.includes(paneId as AlphaPaneId) ||
      Math.abs((previous[paneId] ?? 0) - (next[paneId] ?? 0)) <=
        layoutChangeTolerance,
  );
};

export type AlphaPaneRowLayout = {
  kind: 'row';
  layoutId: 'alpha-pane-row';
  paneIds: AlphaPaneId[];
  ratios: Layout;
};

export type AlphaThreadPaneLayout = {
  schemaVersion: 1;
  threadId: string | null;
  visible: {
    threads: boolean;
    project: boolean;
  };
  rowLayouts: Record<string, AlphaPaneRowLayout>;
};

export const projectPaneStateCookieName = 'project_pane_state';

const projectPaneVisibleFromCookie = () => {
  if (typeof document === 'undefined') return false;
  const prefix = `${projectPaneStateCookieName}=`;
  const value = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
  return value === 'true';
};

const threadKey = (threadId: string | undefined) =>
  threadId ?? '__no-active-thread__';

export const paneSetKey = (paneIds: readonly AlphaPaneId[]) =>
  paneIds.join(':');

export const createAlphaThreadPaneLayout = (
  threadId: string | undefined,
  projectVisible = false,
): AlphaThreadPaneLayout => ({
  schemaVersion: 1,
  threadId: threadId ?? null,
  visible: {
    threads: true,
    project: projectVisible,
  },
  rowLayouts: {},
});

export const layoutForPaneSet = (
  snapshot: AlphaThreadPaneLayout,
  paneIds: readonly AlphaPaneId[],
) => snapshot.rowLayouts[paneSetKey(paneIds)]?.ratios;

export function useAlphaPaneLayouts(activeThreadId: string | undefined) {
  const activeKey = threadKey(activeThreadId);
  const defaultExecutionContextVisible = projectPaneVisibleFromCookie();
  const [snapshots, setSnapshots] = useState<
    Record<string, AlphaThreadPaneLayout>
  >({});
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const snapshot = useMemo(
    () =>
      snapshots[activeKey] ??
      createAlphaThreadPaneLayout(activeThreadId, defaultExecutionContextVisible),
    [activeKey, activeThreadId, defaultExecutionContextVisible, snapshots],
  );

  const updateSnapshot = useCallback(
    (update: (current: AlphaThreadPaneLayout) => AlphaThreadPaneLayout) => {
      setSnapshots((current) => {
        const existing =
          current[activeKey] ??
          createAlphaThreadPaneLayout(activeThreadId, defaultExecutionContextVisible);
        return { ...current, [activeKey]: update(existing) };
      });
    },
    [activeKey, activeThreadId, defaultExecutionContextVisible],
  );

  const setThreadsVisible = useCallback(
    (visible: boolean) => {
      updateSnapshot((current) => ({
        ...current,
        visible: { ...current.visible, threads: visible },
      }));
    },
    [updateSnapshot],
  );

  const setExecutionContextVisible = useCallback(
    (visible: boolean) => {
      updateSnapshot((current) => ({
        ...current,
        visible: { ...current.visible, project: visible },
      }));
    },
    [updateSnapshot],
  );

  const rememberRowLayout = useCallback(
    (paneIds: readonly AlphaPaneId[], layout: Layout) => {
      const key = paneSetKey(paneIds);
      updateSnapshot((current) => ({
        ...current,
        rowLayouts: {
          ...current.rowLayouts,
          [key]: {
            kind: 'row',
            layoutId: 'alpha-pane-row',
            paneIds: [...paneIds],
            ratios: { ...layout },
          },
        },
      }));
    },
    [updateSnapshot],
  );

  const rememberSidebarWidth = useCallback((size: number) => {
    const parsed = parseSidebarWidth({ schemaVersion: 1, size });
    if (parsed === undefined) return;
    setSidebarWidth(parsed);
    saveSidebarWidth(parsed);
  }, []);

  return {
    snapshot,
    sidebarWidth,
    setThreadsVisible,
    setExecutionContextVisible,
    rememberRowLayout,
    rememberSidebarWidth,
  };
}
