import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alphaPaneIds,
  alphaPaneMinimumWidths,
  alphaSidebarDefaultWidth,
  alphaSidebarWidthStorageKey,
  layoutChangesOnlyPanePair,
  layoutForPaneSet,
  useAlphaPaneLayouts,
  type AlphaPaneId,
} from './alpha-pane-layout';

const allPanes: AlphaPaneId[] = [
  alphaPaneIds.threads,
  alphaPaneIds.thread,
  alphaPaneIds.editor,
  alphaPaneIds.project,
];

describe('useAlphaPaneLayouts', () => {
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

  it('keeps the Thread Pane at a mobile-portrait minimum width', () => {
    expect(alphaPaneMinimumWidths[alphaPaneIds.thread]).toBe(380);
    expect(alphaSidebarDefaultWidth).toBe('20rem');
  });

  it('distinguishes adjacent resizing from delta propagated into another Pane', () => {
    const previous = { threads: 20, thread: 30, editor: 30, project: 20 };
    const panePair = [alphaPaneIds.threads, alphaPaneIds.thread] as const;

    expect(
      layoutChangesOnlyPanePair(
        previous,
        {
          threads: 25,
          thread: 25,
          editor: 30,
          project: 20,
        },
        panePair,
      ),
    ).toBe(true);
    expect(
      layoutChangesOnlyPanePair(
        previous,
        {
          threads: 25,
          thread: 30,
          editor: 25,
          project: 20,
        },
        panePair,
      ),
    ).toBe(false);
  });

  it('keeps versioned serializable Thread layouts independent without persisting them', () => {
    const getItem = vi.spyOn(window.localStorage, 'getItem');
    const setItem = vi.spyOn(window.localStorage, 'setItem');
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId?: string }) => useAlphaPaneLayouts(threadId),
      { initialProps: { threadId: 'thread-one' } },
    );

    act(() => {
      result.current.rememberRowLayout(allPanes, {
        threads: 18,
        thread: 32,
        editor: 30,
        project: 20,
      });
      result.current.setExecutionContextVisible(false);
    });

    const firstThreadSnapshot = result.current.snapshot;
    expect(firstThreadSnapshot.schemaVersion).toBe(1);
    expect(firstThreadSnapshot.threadId).toBe('thread-one');
    expect(firstThreadSnapshot.visible.project).toBe(false);
    expect(JSON.parse(JSON.stringify(firstThreadSnapshot))).toEqual(
      firstThreadSnapshot,
    );

    rerender({ threadId: 'thread-two' });
    expect(result.current.snapshot.threadId).toBe('thread-two');
    expect(result.current.snapshot.visible.project).toBe(false);
    expect(layoutForPaneSet(result.current.snapshot, allPanes)).toBeUndefined();

    act(() => result.current.setThreadsVisible(false));
    rerender({ threadId: 'thread-one' });
    expect(result.current.snapshot).toEqual(firstThreadSnapshot);
    expect(layoutForPaneSet(result.current.snapshot, allPanes)).toEqual({
      threads: 18,
      thread: 32,
      editor: 30,
      project: 20,
    });
    expect(getItem).toHaveBeenCalledWith(alphaSidebarWidthStorageKey);
    expect(setItem).not.toHaveBeenCalled();

    getItem.mockRestore();
    setItem.mockRestore();
  });

  it('persists one sidebar width across Threads and hook remounts', () => {
    const first = renderHook(
      ({ threadId }: { threadId: string }) => useAlphaPaneLayouts(threadId),
      { initialProps: { threadId: 'thread-one' } },
    );

    expect(first.result.current.sidebarWidth).toBeUndefined();
    act(() => first.result.current.rememberSidebarWidth(24.5));
    expect(first.result.current.sidebarWidth).toBe(24.5);
    expect(JSON.parse(window.localStorage.getItem(alphaSidebarWidthStorageKey)!))
      .toEqual({ schemaVersion: 1, size: 24.5 });

    first.rerender({ threadId: 'thread-two' });
    expect(first.result.current.sidebarWidth).toBe(24.5);
    first.unmount();

    const restored = renderHook(() => useAlphaPaneLayouts('thread-three'));
    expect(restored.result.current.sidebarWidth).toBe(24.5);
  });

  it('remembers a different ratio set for each rendered pane combination', () => {
    const { result } = renderHook(() => useAlphaPaneLayouts('thread-one'));
    const withoutEditor = [
      alphaPaneIds.threads,
      alphaPaneIds.thread,
      alphaPaneIds.project,
    ] as const;

    act(() => {
      result.current.rememberRowLayout(withoutEditor, {
        threads: 20,
        thread: 55,
        project: 25,
      });
      result.current.rememberRowLayout(allPanes, {
        threads: 18,
        thread: 31,
        editor: 31,
        project: 20,
      });
    });

    expect(layoutForPaneSet(result.current.snapshot, withoutEditor)).toEqual({
      threads: 20,
      thread: 55,
      project: 25,
    });
    expect(layoutForPaneSet(result.current.snapshot, allPanes)).toEqual({
      threads: 18,
      thread: 31,
      editor: 31,
      project: 20,
    });
  });
});
