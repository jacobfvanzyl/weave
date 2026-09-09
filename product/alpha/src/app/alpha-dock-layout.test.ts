import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  alphaDockButtons,
  createAlphaDockSnapshot,
  useAlphaDockLayout,
} from './alpha-dock-layout';

describe('useAlphaDockLayout', () => {
  const scopeA = '["host-1","project-1",null]';
  const scopeB = '["host-2","project-1",null]';
  const scopeC = '["host-1","project-2",null]';

  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        get length() {
          return values.size;
        },
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        key: (index: number) => [...values.keys()][index] ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      } satisfies Storage,
    });
  });

  it('opens Terminal while ignoring a deferred Browser request', () => {
    const { result } = renderHook(() => useAlphaDockLayout(scopeA));

    act(() => result.current.togglePanel('terminal'));
    expect(result.current.snapshot.docks.bottom).toEqual({
      open: true,
      activePanelId: 'terminal',
    });
    act(() => result.current.togglePanel('browser'));
    expect(result.current.snapshot.docks.right).toEqual({
      open: false,
      activePanelId: null,
    });
    expect(result.current.isPanelActive('terminal')).toBe(true);
    expect(result.current.isPanelActive('browser')).toBe(false);
  });

  it('moves visible and hidden Terminal panels without conflating lifecycle state', () => {
    const { result } = renderHook(() => useAlphaDockLayout(scopeA));

    act(() => result.current.togglePanel('terminal'));
    act(() => result.current.movePanel('terminal', 'right'));
    expect(result.current.snapshot.panelPosition.terminal).toBe('right');
    expect(result.current.snapshot.docks.bottom.open).toBe(false);
    expect(result.current.snapshot.docks.right).toEqual({
      open: true,
      activePanelId: 'terminal',
    });

    act(() => result.current.togglePanel('terminal'));
    act(() => result.current.togglePanel('project'));
    act(() => result.current.movePanel('terminal', 'bottom'));
    expect(result.current.snapshot.docks.right).toEqual({
      open: false,
      activePanelId: null,
    });
    expect(result.current.snapshot.docks.bottom.open).toBe(false);
  });

  it('leaves Right closed when Terminal moves back to Bottom', () => {
    const { result } = renderHook(() => useAlphaDockLayout(scopeA));

    act(() => result.current.togglePanel('terminal'));
    act(() => result.current.movePanel('terminal', 'right'));
    act(() => result.current.movePanel('terminal', 'bottom'));

    expect(result.current.snapshot.docks.bottom).toEqual({
      open: true,
      activePanelId: 'terminal',
    });
    expect(result.current.snapshot.docks.right).toEqual({
      open: false,
      activePanelId: null,
    });
  });

  it('hides the final Terminal without restoring deferred Project', () => {
    const { result } = renderHook(() => useAlphaDockLayout(scopeA));

    act(() => result.current.togglePanel('terminal'));
    act(() => result.current.hideTerminalPanel());
    expect(result.current.snapshot.docks.bottom).toEqual({
      open: false,
      activePanelId: null,
    });

    act(() => result.current.togglePanel('terminal'));
    act(() => result.current.movePanel('terminal', 'right'));
    act(() => result.current.hideTerminalPanel());
    expect(result.current.snapshot.docks.right).toEqual({
      open: false,
      activePanelId: null,
    });
  });

  it('shows only the Terminal button at its chosen dock', () => {
    const split = alphaDockButtons(createAlphaDockSnapshot());
    expect(split.bottom.map(({ panelId }) => panelId)).toEqual(['terminal']);
    expect(split.right.map(({ panelId }) => panelId)).toEqual([]);
    expect(split.showDivider).toBe(false);

    const together = alphaDockButtons({
      ...createAlphaDockSnapshot(),
      panelPosition: { terminal: 'right', browser: 'right', project: 'right' },
    });
    expect(together.bottom).toEqual([]);
    expect(together.right.map(({ panelId }) => panelId)).toEqual(['terminal']);
    expect(together.showDivider).toBe(false);
  });

  it('persists Terminal placement and independent dock sizes', () => {
    const initial = renderHook(() => useAlphaDockLayout(scopeA));
    act(() => {
      initial.result.current.movePanel('terminal', 'right');
      initial.result.current.movePanel('browser', 'bottom');
      initial.result.current.togglePanel('browser');
      initial.result.current.rememberSize('bottom', 31);
      initial.result.current.rememberSize('right', 24);
    });
    initial.unmount();

    const restored = renderHook(() => useAlphaDockLayout(scopeA));
    expect(restored.result.current.snapshot.panelPosition.terminal).toBe(
      'right',
    );
    expect(restored.result.current.snapshot.panelPosition.browser).toBe(
      'bottom',
    );
    expect(restored.result.current.isPanelActive('browser')).toBe(false);
    expect(restored.result.current.snapshot.rememberedSize).toEqual({
      bottom: 31,
      right: 24,
    });
  });

  it('migrates the v2 Terminal and Project state while adding Browser closed on Right', () => {
    window.localStorage.setItem('weave.alpha.docks.v2', JSON.stringify({
      schemaVersion: 2,
      panelPosition: { terminal: 'bottom', project: 'right' },
      projectOpen: true,
      terminalOpenByScope: { [scopeA]: true },
      rememberedSize: { bottom: 30, right: 25 },
    }));

    const { result } = renderHook(() => useAlphaDockLayout(scopeA));
    expect(result.current.snapshot.schemaVersion).toBe(3);
    expect(result.current.snapshot.panelPosition.browser).toBe('right');
    expect(result.current.snapshot.docks.bottom.activePanelId).toBe('terminal');
    expect(result.current.snapshot.docks.right.activePanelId).toBe(null);
    expect(result.current.isPanelActive('browser')).toBe(false);
  });

  it('ignores deferred Browser state in both docks', () => {
    const { result } = renderHook(() => useAlphaDockLayout(scopeA));

    act(() => result.current.togglePanel('project'));
    act(() => result.current.togglePanel('browser'));
    expect(result.current.snapshot.docks.right.activePanelId).toBe(null);

    act(() => result.current.movePanel('browser', 'bottom'));
    expect(result.current.snapshot.docks.bottom.activePanelId).toBe(null);
    expect(result.current.snapshot.docks.right.activePanelId).toBe(null);

    act(() => result.current.hideBrowserPanel());
    expect(result.current.snapshot.docks.bottom).toEqual({
      open: false,
      activePanelId: null,
    });
  });

  it('restores Terminal openness independently for each Host and Project scope', () => {
    const { result, rerender } = renderHook(
      ({ scope }) => useAlphaDockLayout(scope),
      { initialProps: { scope: scopeA } },
    );

    act(() => result.current.togglePanel('terminal'));
    expect(result.current.isPanelActive('terminal')).toBe(true);

    rerender({ scope: scopeB });
    expect(result.current.isPanelActive('terminal')).toBe(false);

    act(() => result.current.togglePanel('terminal'));
    expect(result.current.isPanelActive('terminal')).toBe(true);

    rerender({ scope: scopeC });
    expect(result.current.isPanelActive('terminal')).toBe(false);

    rerender({ scope: scopeA });
    expect(result.current.isPanelActive('terminal')).toBe(true);

    rerender({ scope: scopeB });
    expect(result.current.isPanelActive('terminal')).toBe(true);
  });
});
