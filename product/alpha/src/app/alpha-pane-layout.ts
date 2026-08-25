import { useCallback, useMemo, useState } from 'react';
import type { Layout } from 'react-resizable-panels';

export const alphaPaneIds = {
  threads: 'threads',
  thread: 'thread',
  editor: 'editor',
  project: 'project',
} as const;

export type AlphaPaneId = typeof alphaPaneIds[keyof typeof alphaPaneIds];

export const alphaPaneMinimumWidths = {
  [alphaPaneIds.threads]: '11rem',
  [alphaPaneIds.thread]: 380,
  [alphaPaneIds.editor]: '15rem',
  [alphaPaneIds.project]: '12rem',
} as const satisfies Record<AlphaPaneId, number | string>;

const layoutChangeTolerance = 0.001;

export const layoutChangesOnlyPanePair = (
  previous: Layout,
  next: Layout,
  panePair: readonly [AlphaPaneId, AlphaPaneId],
) => {
  const paneIds = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...paneIds].every((paneId) =>
    panePair.includes(paneId as AlphaPaneId)
    || Math.abs((previous[paneId] ?? 0) - (next[paneId] ?? 0)) <= layoutChangeTolerance
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

const threadKey = (threadId: string | undefined) => threadId ?? '__no-active-thread__';

export const paneSetKey = (paneIds: readonly AlphaPaneId[]) => paneIds.join(':');

export const createAlphaThreadPaneLayout = (
  threadId: string | undefined,
): AlphaThreadPaneLayout => ({
  schemaVersion: 1,
  threadId: threadId ?? null,
  visible: {
    threads: true,
    project: true,
  },
  rowLayouts: {},
});

export const layoutForPaneSet = (
  snapshot: AlphaThreadPaneLayout,
  paneIds: readonly AlphaPaneId[],
) => snapshot.rowLayouts[paneSetKey(paneIds)]?.ratios;

export function useAlphaPaneLayouts(activeThreadId: string | undefined) {
  const activeKey = threadKey(activeThreadId);
  const [snapshots, setSnapshots] = useState<Record<string, AlphaThreadPaneLayout>>({});
  const snapshot = useMemo(
    () => snapshots[activeKey] ?? createAlphaThreadPaneLayout(activeThreadId),
    [activeKey, activeThreadId, snapshots],
  );

  const updateSnapshot = useCallback((
    update: (current: AlphaThreadPaneLayout) => AlphaThreadPaneLayout,
  ) => {
    setSnapshots((current) => {
      const existing = current[activeKey] ?? createAlphaThreadPaneLayout(activeThreadId);
      return { ...current, [activeKey]: update(existing) };
    });
  }, [activeKey, activeThreadId]);

  const setThreadsVisible = useCallback((visible: boolean) => {
    updateSnapshot((current) => ({
      ...current,
      visible: { ...current.visible, threads: visible },
    }));
  }, [updateSnapshot]);

  const setProjectVisible = useCallback((visible: boolean) => {
    updateSnapshot((current) => ({
      ...current,
      visible: { ...current.visible, project: visible },
    }));
  }, [updateSnapshot]);

  const rememberRowLayout = useCallback((
    paneIds: readonly AlphaPaneId[],
    layout: Layout,
  ) => {
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
  }, [updateSnapshot]);

  return {
    snapshot,
    setThreadsVisible,
    setProjectVisible,
    rememberRowLayout,
  };
}
