import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  alphaDockButtons,
  createAlphaDockSnapshot,
  useAlphaDockLayout,
} from './alpha-dock-layout';

describe('useAlphaDockLayout', () => {
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

  it('opens Terminal in Bottom by default and keeps Bottom and Right independent', () => {
    const { result } = renderHook(() => useAlphaDockLayout());

    act(() => result.current.togglePanel('terminal'));
    expect(result.current.snapshot.docks.bottom).toEqual({
      open: true,
      activePanelId: 'terminal',
    });
    act(() => result.current.togglePanel('project'));
    expect(result.current.snapshot.docks.right).toEqual({
      open: true,
      activePanelId: 'project',
    });
    expect(result.current.isPanelActive('terminal')).toBe(true);
    expect(result.current.isPanelActive('project')).toBe(true);
  });

  it('moves visible and hidden Terminal panels without conflating lifecycle state', () => {
    const { result } = renderHook(() => useAlphaDockLayout());

    act(() => result.current.togglePanel('terminal'));
    act(() => result.current.moveTerminal('right'));
    expect(result.current.snapshot.panelPosition.terminal).toBe('right');
    expect(result.current.snapshot.docks.bottom.open).toBe(false);
    expect(result.current.snapshot.docks.right).toEqual({
      open: true,
      activePanelId: 'terminal',
    });

    act(() => result.current.togglePanel('terminal'));
    act(() => result.current.togglePanel('project'));
    act(() => result.current.moveTerminal('bottom'));
    expect(result.current.snapshot.docks.right).toEqual({
      open: true,
      activePanelId: 'project',
    });
    expect(result.current.snapshot.docks.bottom.open).toBe(false);
  });

  it('reveals Project when a visible Right Terminal moves back to Bottom', () => {
    const { result } = renderHook(() => useAlphaDockLayout());

    act(() => result.current.togglePanel('terminal'));
    act(() => result.current.moveTerminal('right'));
    act(() => result.current.moveTerminal('bottom'));

    expect(result.current.snapshot.docks.bottom).toEqual({
      open: true,
      activePanelId: 'terminal',
    });
    expect(result.current.snapshot.docks.right).toEqual({
      open: true,
      activePanelId: 'project',
    });
  });

  it('orders Terminal immediately before Project and separates populated dock groups once', () => {
    const split = alphaDockButtons(createAlphaDockSnapshot());
    expect(split.bottom.map(({ panelId }) => panelId)).toEqual(['terminal']);
    expect(split.right.map(({ panelId }) => panelId)).toEqual(['project']);
    expect(split.showDivider).toBe(true);

    const together = alphaDockButtons({
      ...createAlphaDockSnapshot(),
      panelPosition: { terminal: 'right', project: 'right' },
    });
    expect(together.bottom).toEqual([]);
    expect(together.right.map(({ panelId }) => panelId)).toEqual([
      'terminal',
      'project',
    ]);
    expect(together.showDivider).toBe(false);
  });

  it('persists Terminal placement and independent dock sizes', () => {
    const initial = renderHook(() => useAlphaDockLayout());
    act(() => {
      initial.result.current.moveTerminal('right');
      initial.result.current.rememberSize('bottom', 31);
      initial.result.current.rememberSize('right', 24);
    });
    initial.unmount();

    const restored = renderHook(() => useAlphaDockLayout());
    expect(restored.result.current.snapshot.panelPosition.terminal).toBe(
      'right',
    );
    expect(restored.result.current.snapshot.rememberedSize).toEqual({
      bottom: 31,
      right: 24,
    });
  });
});
