import { useCallback, useState } from 'react';

export type AlphaDockPosition = 'bottom' | 'right';
export type AlphaDockPanelId = 'terminal' | 'project';

export type AlphaDockSnapshot = {
  schemaVersion: 1;
  panelPosition: {
    terminal: AlphaDockPosition;
    project: 'right';
  };
  docks: Record<
    AlphaDockPosition,
    { open: boolean; activePanelId: AlphaDockPanelId | null }
  >;
  rememberedSize: {
    bottom: number;
    right: number;
  };
};

const storageKey = 'weave.alpha.docks.v1';

export const createAlphaDockSnapshot = (): AlphaDockSnapshot => ({
  schemaVersion: 1,
  panelPosition: { terminal: 'bottom', project: 'right' },
  docks: {
    bottom: { open: false, activePanelId: null },
    right: { open: false, activePanelId: null },
  },
  rememberedSize: { bottom: 32, right: 24 },
});

const panelPosition = (
  snapshot: AlphaDockSnapshot,
  panelId: AlphaDockPanelId,
) => snapshot.panelPosition[panelId];

const parseSnapshot = (value: unknown): AlphaDockSnapshot | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const input = value as Partial<AlphaDockSnapshot>;
  if (
    input.schemaVersion !== 1 ||
    (input.panelPosition?.terminal !== 'bottom' &&
      input.panelPosition?.terminal !== 'right') ||
    input.panelPosition?.project !== 'right'
  ) return;
  const defaults = createAlphaDockSnapshot();
  const bottomSize = Number(input.rememberedSize?.bottom);
  const rightSize = Number(input.rememberedSize?.right);
  const dock = (position: AlphaDockPosition) => {
    const candidate = input.docks?.[position];
    const activePanelId = candidate?.activePanelId;
    const validActive = activePanelId === 'terminal' ||
      activePanelId === 'project'
      ? activePanelId
      : null;
    return {
      open: candidate?.open === true && validActive !== null,
      activePanelId: validActive,
    };
  };
  return {
    schemaVersion: 1,
    panelPosition: input.panelPosition as AlphaDockSnapshot['panelPosition'],
    docks: { bottom: dock('bottom'), right: dock('right') },
    rememberedSize: {
      bottom: Number.isFinite(bottomSize) ? bottomSize : defaults.rememberedSize.bottom,
      right: Number.isFinite(rightSize) ? rightSize : defaults.rememberedSize.right,
    },
  };
};

const loadSnapshot = () => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return createAlphaDockSnapshot();
  }
  try {
    return parseSnapshot(JSON.parse(window.localStorage.getItem(storageKey) ?? 'null')) ??
      createAlphaDockSnapshot();
  } catch {
    return createAlphaDockSnapshot();
  }
};

const saveSnapshot = (snapshot: AlphaDockSnapshot) => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(storageKey, JSON.stringify(snapshot));
};

export const alphaDockButtons = (snapshot: AlphaDockSnapshot) => {
  const buttons = [
    { panelId: 'terminal' as const, position: snapshot.panelPosition.terminal, order: 1 },
    { panelId: 'project' as const, position: 'right' as const, order: 2 },
  ];
  const bottom = buttons.filter(({ position }) => position === 'bottom')
    .sort((left, right) => left.order - right.order);
  const right = buttons.filter(({ position }) => position === 'right')
    .sort((left, right) => left.order - right.order);
  return { bottom, right, showDivider: bottom.length > 0 && right.length > 0 };
};

export function useAlphaDockLayout() {
  const [snapshot, setSnapshotState] = useState(loadSnapshot);
  const update = useCallback(
    (change: (current: AlphaDockSnapshot) => AlphaDockSnapshot) => {
      setSnapshotState((current) => {
        const next = change(current);
        saveSnapshot(next);
        return next;
      });
    },
    [],
  );

  const togglePanel = useCallback((panelId: AlphaDockPanelId) => {
    update((current) => {
      const position = panelPosition(current, panelId);
      const dock = current.docks[position];
      const active = dock.open && dock.activePanelId === panelId;
      return {
        ...current,
        docks: {
          ...current.docks,
          [position]: active
            ? { open: false, activePanelId: dock.activePanelId }
            : { open: true, activePanelId: panelId },
        },
      };
    });
  }, [update]);

  const setDockOpen = useCallback((position: AlphaDockPosition, open: boolean) => {
    update((current) => {
      const dock = current.docks[position];
      const fallbackPanel = position === 'bottom'
        ? current.panelPosition.terminal === 'bottom' ? 'terminal' : null
        : dock.activePanelId ?? 'project';
      return {
        ...current,
        docks: {
          ...current.docks,
          [position]: {
            open: open && fallbackPanel !== null,
            activePanelId: dock.activePanelId ?? fallbackPanel,
          },
        },
      };
    });
  }, [update]);

  const moveTerminal = useCallback((target: AlphaDockPosition) => {
    update((current) => {
      const source = current.panelPosition.terminal;
      if (source === target) return current;
      const sourceDock = current.docks[source];
      const terminalVisible = sourceDock.open && sourceDock.activePanelId === 'terminal';
      const nextSource = sourceDock.activePanelId === 'terminal'
        ? source === 'right'
          ? { open: true, activePanelId: 'project' as const }
          : { open: false, activePanelId: null }
        : sourceDock;
      return {
        ...current,
        panelPosition: { ...current.panelPosition, terminal: target },
        docks: {
          ...current.docks,
          [source]: nextSource,
          [target]: terminalVisible
            ? { open: true, activePanelId: 'terminal' }
            : current.docks[target],
        },
      };
    });
  }, [update]);

  const rememberSize = useCallback((position: AlphaDockPosition, size: number) => {
    if (!Number.isFinite(size) || size <= 0 || size >= 100) return;
    update((current) => ({
      ...current,
      rememberedSize: { ...current.rememberedSize, [position]: size },
    }));
  }, [update]);

  const isPanelActive = useCallback((panelId: AlphaDockPanelId) => {
    const position = panelPosition(snapshot, panelId);
    const dock = snapshot.docks[position];
    return dock.open && dock.activePanelId === panelId;
  }, [snapshot]);

  return {
    snapshot,
    buttons: alphaDockButtons(snapshot),
    togglePanel,
    setDockOpen,
    moveTerminal,
    rememberSize,
    isPanelActive,
  };
}
