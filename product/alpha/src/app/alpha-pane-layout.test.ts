import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  alphaPaneIds,
  alphaPaneMinimumWidths,
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
  it('keeps the Thread Pane at a mobile-portrait minimum width', () => {
    expect(alphaPaneMinimumWidths[alphaPaneIds.thread]).toBe(380);
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

  it('keeps versioned serializable layout snapshots independent by Thread without persistence', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
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
      result.current.setProjectVisible(false);
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
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();

    getItem.mockRestore();
    setItem.mockRestore();
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
