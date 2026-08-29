import { useCallback, useState } from 'react';

export type AlphaDockPosition = 'bottom' | 'right';
export type AlphaDockPanelId = 'terminal' | 'browser' | 'project';
export type AlphaMovableDockPanelId = Exclude<AlphaDockPanelId, 'project'>;

export type AlphaDockSnapshot = {
  schemaVersion: 3;
  panelPosition: {
    terminal: AlphaDockPosition;
    browser: AlphaDockPosition;
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

type PersistedAlphaDockState = {
  schemaVersion: 3;
  panelPosition: AlphaDockSnapshot['panelPosition'];
  projectOpen: boolean;
  browserOpen: boolean;
  terminalOpenByScope: Record<string, boolean>;
  activePanelByDock: Record<AlphaDockPosition, AlphaDockPanelId | null>;
  rememberedSize: AlphaDockSnapshot['rememberedSize'];
};

type LegacyV2DockState = {
  schemaVersion: 2;
  panelPosition: {
    terminal: AlphaDockPosition;
    project: 'right';
  };
  projectOpen: boolean;
  terminalOpenByScope: Record<string, boolean>;
  rememberedSize: AlphaDockSnapshot['rememberedSize'];
};

type LegacyAlphaDockSnapshot = {
  schemaVersion: 1;
  panelPosition: {
    terminal: AlphaDockPosition;
    project: 'right';
  };
  docks: Record<
    AlphaDockPosition,
    { open: boolean; activePanelId: 'terminal' | 'project' | null }
  >;
  rememberedSize: AlphaDockSnapshot['rememberedSize'];
};

const storageKey = 'weave.alpha.docks.v3';
const legacyV2StorageKey = 'weave.alpha.docks.v2';
const legacyStorageKey = 'weave.alpha.docks.v1';

const createPersistedState = (): PersistedAlphaDockState => ({
  schemaVersion: 3,
  panelPosition: { terminal: 'bottom', browser: 'right', project: 'right' },
  projectOpen: false,
  browserOpen: false,
  terminalOpenByScope: {},
  activePanelByDock: { bottom: null, right: null },
  rememberedSize: { bottom: 32, right: 24 },
});

const terminalOpen = (
  state: PersistedAlphaDockState,
  terminalScopeKey: string | undefined,
) => Boolean(terminalScopeKey && state.terminalOpenByScope[terminalScopeKey]);

const panelOpen = (
  state: PersistedAlphaDockState,
  panelId: AlphaDockPanelId,
  terminalScopeKey: string | undefined,
) => panelId === 'terminal'
  ? terminalOpen(state, terminalScopeKey)
  : panelId === 'browser'
  ? state.browserOpen
  : state.projectOpen;

const panels: AlphaDockPanelId[] = ['terminal', 'browser', 'project'];

const snapshotFromState = (
  state: PersistedAlphaDockState,
  terminalScopeKey?: string,
): AlphaDockSnapshot => {
  const activePanel = (position: AlphaDockPosition) => {
    const candidates = panels.filter((panelId) =>
      state.panelPosition[panelId] === position &&
      panelOpen(state, panelId, terminalScopeKey)
    );
    const preferred = state.activePanelByDock[position];
    if (preferred && candidates.includes(preferred)) return preferred;
    return candidates[0] ?? null;
  };
  const bottomPanelId = activePanel('bottom');
  const rightPanelId = activePanel('right');
  return {
    schemaVersion: 3,
    panelPosition: state.panelPosition,
    docks: {
      bottom: {
        open: bottomPanelId !== null,
        activePanelId: bottomPanelId,
      },
      right: {
        open: rightPanelId !== null,
        activePanelId: rightPanelId,
      },
    },
    rememberedSize: state.rememberedSize,
  };
};

export const createAlphaDockSnapshot = (): AlphaDockSnapshot =>
  snapshotFromState(createPersistedState());

const validPosition = (value: unknown): value is AlphaDockPosition =>
  value === 'bottom' || value === 'right';

const finiteSize = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 100
    ? parsed
    : fallback;
};

const parseState = (value: unknown): PersistedAlphaDockState | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const input = value as Partial<PersistedAlphaDockState>;
  if (
    input.schemaVersion !== 3 ||
    !validPosition(input.panelPosition?.terminal) ||
    !validPosition(input.panelPosition?.browser) ||
    input.panelPosition?.project !== 'right'
  ) return;
  const defaults = createPersistedState();
  const terminalOpenByScope = input.terminalOpenByScope &&
      typeof input.terminalOpenByScope === 'object' &&
      !Array.isArray(input.terminalOpenByScope)
    ? Object.fromEntries(
      Object.entries(input.terminalOpenByScope).filter(
        ([key, open]) => key.length > 0 && typeof open === 'boolean',
      ),
    )
    : {};
  return {
    schemaVersion: 3,
    panelPosition: input.panelPosition as AlphaDockSnapshot['panelPosition'],
    projectOpen: input.projectOpen === true,
    browserOpen: input.browserOpen === true,
    terminalOpenByScope,
    activePanelByDock: {
      bottom: panels.includes(input.activePanelByDock?.bottom as AlphaDockPanelId)
        ? input.activePanelByDock?.bottom as AlphaDockPanelId
        : null,
      right: panels.includes(input.activePanelByDock?.right as AlphaDockPanelId)
        ? input.activePanelByDock?.right as AlphaDockPanelId
        : null,
    },
    rememberedSize: {
      bottom: finiteSize(
        input.rememberedSize?.bottom,
        defaults.rememberedSize.bottom,
      ),
      right: finiteSize(
        input.rememberedSize?.right,
        defaults.rememberedSize.right,
      ),
    },
  };
};

const migrateV2State = (value: unknown): PersistedAlphaDockState | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const input = value as Partial<LegacyV2DockState>;
  if (
    input.schemaVersion !== 2 ||
    !validPosition(input.panelPosition?.terminal) ||
    input.panelPosition?.project !== 'right'
  ) return;
  const defaults = createPersistedState();
  const terminalOpenByScope = input.terminalOpenByScope &&
      typeof input.terminalOpenByScope === 'object' &&
      !Array.isArray(input.terminalOpenByScope)
    ? Object.fromEntries(
      Object.entries(input.terminalOpenByScope).filter(
        ([key, open]) => key.length > 0 && typeof open === 'boolean',
      ),
    )
    : {};
  const anyTerminalOpen = Object.values(terminalOpenByScope).some(Boolean);
  const terminalPosition = input.panelPosition.terminal;
  return {
    ...defaults,
    panelPosition: {
      terminal: terminalPosition,
      browser: 'right',
      project: 'right',
    },
    projectOpen: input.projectOpen === true,
    terminalOpenByScope,
    activePanelByDock: {
      bottom: anyTerminalOpen && terminalPosition === 'bottom' ? 'terminal' : null,
      right: anyTerminalOpen && terminalPosition === 'right'
        ? 'terminal'
        : input.projectOpen === true
        ? 'project'
        : null,
    },
    rememberedSize: {
      bottom: finiteSize(input.rememberedSize?.bottom, defaults.rememberedSize.bottom),
      right: finiteSize(input.rememberedSize?.right, defaults.rememberedSize.right),
    },
  };
};

const migrateLegacyState = (
  value: unknown,
  terminalScopeKey: string | undefined,
): PersistedAlphaDockState | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const input = value as Partial<LegacyAlphaDockSnapshot>;
  if (
    input.schemaVersion !== 1 ||
    !validPosition(input.panelPosition?.terminal) ||
    input.panelPosition?.project !== 'right'
  ) return;
  const defaults = createPersistedState();
  const terminalPosition = input.panelPosition.terminal;
  const terminalWasOpen = input.docks?.[terminalPosition]?.open === true &&
    input.docks?.[terminalPosition]?.activePanelId === 'terminal';
  return {
    schemaVersion: 3,
    panelPosition: {
      terminal: terminalPosition,
      browser: 'right',
      project: 'right',
    },
    projectOpen: input.docks?.right?.open === true &&
      input.docks.right.activePanelId === 'project',
    browserOpen: false,
    terminalOpenByScope: terminalWasOpen && terminalScopeKey
      ? { [terminalScopeKey]: true }
      : {},
    activePanelByDock: {
      bottom: terminalWasOpen && terminalPosition === 'bottom' ? 'terminal' : null,
      right: terminalWasOpen && terminalPosition === 'right'
        ? 'terminal'
        : input.docks?.right?.activePanelId === 'project'
        ? 'project'
        : null,
    },
    rememberedSize: {
      bottom: finiteSize(
        input.rememberedSize?.bottom,
        defaults.rememberedSize.bottom,
      ),
      right: finiteSize(
        input.rememberedSize?.right,
        defaults.rememberedSize.right,
      ),
    },
  };
};

const loadState = (terminalScopeKey: string | undefined) => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return createPersistedState();
  }
  try {
    const current = parseState(
      JSON.parse(window.localStorage.getItem(storageKey) ?? 'null'),
    );
    if (current) return current;
    const migratedV2 = migrateV2State(
      JSON.parse(window.localStorage.getItem(legacyV2StorageKey) ?? 'null'),
    );
    if (migratedV2) return migratedV2;
    return migrateLegacyState(
      JSON.parse(window.localStorage.getItem(legacyStorageKey) ?? 'null'),
      terminalScopeKey,
    ) ?? createPersistedState();
  } catch {
    return createPersistedState();
  }
};

const saveState = (state: PersistedAlphaDockState) => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(storageKey, JSON.stringify(state));
};

export const alphaDockButtons = (snapshot: AlphaDockSnapshot) => {
  const buttons = [
    { panelId: 'terminal' as const, position: snapshot.panelPosition.terminal, order: 1 },
    { panelId: 'browser' as const, position: snapshot.panelPosition.browser, order: 2 },
    { panelId: 'project' as const, position: 'right' as const, order: 3 },
  ];
  const bottom = buttons.filter(({ position }) => position === 'bottom')
    .sort((left, right) => left.order - right.order);
  const right = buttons.filter(({ position }) => position === 'right')
    .sort((left, right) => left.order - right.order);
  return { bottom, right, showDivider: bottom.length > 0 && right.length > 0 };
};

export function useAlphaDockLayout(terminalScopeKey?: string) {
  const [state, setState] = useState(() => loadState(terminalScopeKey));
  const snapshot = snapshotFromState(state, terminalScopeKey);
  const update = useCallback(
    (change: (current: PersistedAlphaDockState) => PersistedAlphaDockState) => {
      setState((current) => {
        const next = change(current);
        saveState(next);
        return next;
      });
    },
    [],
  );

  const setTerminalOpen = useCallback((
    current: PersistedAlphaDockState,
    open: boolean,
  ) => {
    if (!terminalScopeKey) return current;
    return {
      ...current,
      terminalOpenByScope: {
        ...current.terminalOpenByScope,
        [terminalScopeKey]: open,
      },
    };
  }, [terminalScopeKey]);

  const setPanelOpen = useCallback((
    current: PersistedAlphaDockState,
    panelId: AlphaDockPanelId,
    open: boolean,
  ) => {
    if (panelId === 'terminal') return setTerminalOpen(current, open);
    if (panelId === 'browser') return { ...current, browserOpen: open };
    return { ...current, projectOpen: open };
  }, [setTerminalOpen]);

  const togglePanel = useCallback((panelId: AlphaDockPanelId) => {
    update((current) => {
      const currentSnapshot = snapshotFromState(current, terminalScopeKey);
      const position = currentSnapshot.panelPosition[panelId];
      const active = currentSnapshot.docks[position].open &&
        currentSnapshot.docks[position].activePanelId === panelId;
      const next = setPanelOpen(current, panelId, !active);
      return active
        ? next
        : {
          ...next,
          activePanelByDock: {
            ...next.activePanelByDock,
            [position]: panelId,
          },
        };
    });
  }, [setPanelOpen, terminalScopeKey, update]);

  const setDockOpen = useCallback((position: AlphaDockPosition, open: boolean) => {
    update((current) => {
      const currentSnapshot = snapshotFromState(current, terminalScopeKey);
      const activePanelId = currentSnapshot.docks[position].activePanelId;
      if (!open) return activePanelId
        ? setPanelOpen(current, activePanelId, false)
        : current;
      const preferred = current.activePanelByDock[position];
      const panelId = preferred && current.panelPosition[preferred] === position
        ? preferred
        : panels.find((candidate) => current.panelPosition[candidate] === position);
      if (!panelId || panelId === 'terminal' && !terminalScopeKey) return current;
      const next = setPanelOpen(current, panelId, true);
      return {
        ...next,
        activePanelByDock: { ...next.activePanelByDock, [position]: panelId },
      };
    });
  }, [setPanelOpen, terminalScopeKey, update]);

  const hideTerminalPanel = useCallback(() => {
    update((current) => {
      const next = setTerminalOpen(current, false);
      return current.panelPosition.terminal === 'right' &&
          terminalOpen(current, terminalScopeKey)
        ? { ...next, projectOpen: true }
        : next;
    });
  }, [setTerminalOpen, terminalScopeKey, update]);

  const hideBrowserPanel = useCallback(() => {
    update((current) => setPanelOpen(current, 'browser', false));
  }, [setPanelOpen, update]);

  const movePanel = useCallback((
    panelId: AlphaMovableDockPanelId,
    target: AlphaDockPosition,
  ) => {
    update((current) => {
      if (current.panelPosition[panelId] === target) return current;
      const currentSnapshot = snapshotFromState(current, terminalScopeKey);
      const source = current.panelPosition[panelId];
      const active = currentSnapshot.docks[source].activePanelId === panelId;
      const next = {
        ...current,
        panelPosition: { ...current.panelPosition, [panelId]: target },
        projectOpen: active && source === 'right' && target === 'bottom'
          ? true
          : current.projectOpen,
      };
      return active
        ? {
          ...next,
          activePanelByDock: {
            ...next.activePanelByDock,
            [target]: panelId,
          },
        }
        : next;
    });
  }, [terminalScopeKey, update]);

  const rememberSize = useCallback((position: AlphaDockPosition, size: number) => {
    if (!Number.isFinite(size) || size <= 0 || size >= 100) return;
    update((current) => ({
      ...current,
      rememberedSize: { ...current.rememberedSize, [position]: size },
    }));
  }, [update]);

  const isPanelActive = useCallback((panelId: AlphaDockPanelId) => {
    const position = snapshot.panelPosition[panelId];
    const dock = snapshot.docks[position];
    return dock.open && dock.activePanelId === panelId;
  }, [snapshot]);

  return {
    snapshot,
    buttons: alphaDockButtons(snapshot),
    togglePanel,
    setDockOpen,
    hideTerminalPanel,
    hideBrowserPanel,
    movePanel,
    rememberSize,
    isPanelActive,
  };
}
