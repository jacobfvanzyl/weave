import { useCallback, useState } from 'react';

export type AlphaDockPosition = 'bottom' | 'right';
export type AlphaDockPanelId = 'terminal' | 'project';

export type AlphaDockSnapshot = {
  schemaVersion: 2;
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

type PersistedAlphaDockState = {
  schemaVersion: 2;
  panelPosition: AlphaDockSnapshot['panelPosition'];
  projectOpen: boolean;
  terminalOpenByScope: Record<string, boolean>;
  rememberedSize: AlphaDockSnapshot['rememberedSize'];
};

type LegacyAlphaDockSnapshot = Omit<AlphaDockSnapshot, 'schemaVersion'> & {
  schemaVersion: 1;
};

const storageKey = 'weave.alpha.docks.v2';
const legacyStorageKey = 'weave.alpha.docks.v1';

const createPersistedState = (): PersistedAlphaDockState => ({
  schemaVersion: 2,
  panelPosition: { terminal: 'bottom', project: 'right' },
  projectOpen: false,
  terminalOpenByScope: {},
  rememberedSize: { bottom: 32, right: 24 },
});

const terminalOpen = (
  state: PersistedAlphaDockState,
  terminalScopeKey: string | undefined,
) => Boolean(terminalScopeKey && state.terminalOpenByScope[terminalScopeKey]);

const snapshotFromState = (
  state: PersistedAlphaDockState,
  terminalScopeKey?: string,
): AlphaDockSnapshot => {
  const terminalIsOpen = terminalOpen(state, terminalScopeKey);
  const terminalAtBottom = state.panelPosition.terminal === 'bottom';
  const rightPanelId = !terminalAtBottom && terminalIsOpen
    ? 'terminal'
    : state.projectOpen
    ? 'project'
    : null;
  return {
    schemaVersion: 2,
    panelPosition: state.panelPosition,
    docks: {
      bottom: {
        open: terminalAtBottom && terminalIsOpen,
        activePanelId: terminalAtBottom && terminalIsOpen ? 'terminal' : null,
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
  return {
    schemaVersion: 2,
    panelPosition: input.panelPosition as AlphaDockSnapshot['panelPosition'],
    projectOpen: input.projectOpen === true,
    terminalOpenByScope,
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
    schemaVersion: 2,
    panelPosition: input.panelPosition as AlphaDockSnapshot['panelPosition'],
    projectOpen: input.docks?.right?.open === true &&
      input.docks.right.activePanelId === 'project',
    terminalOpenByScope: terminalWasOpen && terminalScopeKey
      ? { [terminalScopeKey]: true }
      : {},
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
    { panelId: 'project' as const, position: 'right' as const, order: 2 },
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

  const togglePanel = useCallback((panelId: AlphaDockPanelId) => {
    update((current) => {
      const currentSnapshot = snapshotFromState(current, terminalScopeKey);
      const position = currentSnapshot.panelPosition[panelId];
      const active = currentSnapshot.docks[position].open &&
        currentSnapshot.docks[position].activePanelId === panelId;
      if (panelId === 'terminal') return setTerminalOpen(current, !active);
      const withProject = { ...current, projectOpen: !active };
      return !active && current.panelPosition.terminal === 'right'
        ? setTerminalOpen(withProject, false)
        : withProject;
    });
  }, [setTerminalOpen, terminalScopeKey, update]);

  const setDockOpen = useCallback((position: AlphaDockPosition, open: boolean) => {
    update((current) => {
      const currentSnapshot = snapshotFromState(current, terminalScopeKey);
      const activePanelId = currentSnapshot.docks[position].activePanelId;
      if (!open) {
        return activePanelId === 'terminal'
          ? setTerminalOpen(current, false)
          : activePanelId === 'project'
          ? { ...current, projectOpen: false }
          : current;
      }
      if (position === 'bottom') {
        return current.panelPosition.terminal === 'bottom'
          ? setTerminalOpen(current, true)
          : current;
      }
      return current.panelPosition.terminal === 'right' && terminalScopeKey
        ? setTerminalOpen(current, true)
        : { ...current, projectOpen: true };
    });
  }, [setTerminalOpen, terminalScopeKey, update]);

  const hideTerminalPanel = useCallback(() => {
    update((current) => {
      const next = setTerminalOpen(current, false);
      return current.panelPosition.terminal === 'right' &&
          terminalOpen(current, terminalScopeKey)
        ? { ...next, projectOpen: true }
        : next;
    });
  }, [setTerminalOpen, terminalScopeKey, update]);

  const moveTerminal = useCallback((target: AlphaDockPosition) => {
    update((current) => current.panelPosition.terminal === target
      ? current
      : {
        ...current,
        panelPosition: { ...current.panelPosition, terminal: target },
        projectOpen: current.panelPosition.terminal === 'right' &&
            terminalOpen(current, terminalScopeKey)
          ? true
          : current.projectOpen,
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
    moveTerminal,
    rememberSize,
    isPanelActive,
  };
}
