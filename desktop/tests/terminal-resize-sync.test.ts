import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalPanelTarget } from '../../packages/client/src/components/terminal/TerminalPanel';
import {
  createTerminalLayoutSyncKey,
  scheduleTerminalLayoutResizeSync,
  terminalLayoutResizeSyncDelaysMs,
  type TerminalLayoutResizeScheduler,
} from '../../packages/client/src/components/terminal/terminal-resize-sync';

const workspaceTarget: TerminalPanelTarget = {
  kind: 'workspace',
  terminalId: 'workspace-1',
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  portalId: 'portal-1',
  rootId: 'default',
  workspacePath: '/repo/workspace',
  title: 'Smoke / main',
};

const baseLayoutInput = {
  isTerminalEffectivelyMaximized: false,
  showChatPane: false,
  showEditorPane: true,
  showTerminalPane: true,
  target: workspaceTarget,
  terminalHost: 'editor' as const,
  terminalPaneColumn: 'left' as const,
};

const createScheduler = () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;

  const scheduler: TerminalLayoutResizeScheduler = {
    cancelAnimationFrame: vi.fn(handle => {
      frames.delete(handle);
    }),
    clearTimeout: vi.fn(handle => {
      clearTimeout(handle);
    }),
    requestAnimationFrame: vi.fn(callback => {
      const handle = nextFrame;
      nextFrame += 1;
      frames.set(handle, callback);
      return handle;
    }),
    setTimeout: vi.fn((callback, delayMs) => setTimeout(callback, delayMs)),
  };

  return {
    frames,
    runFrame: (handle: number) => {
      const callback = frames.get(handle);
      frames.delete(handle);
      callback?.(0);
    },
    scheduler,
  };
};

describe('terminal resize sync', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('changes the layout sync key when chat opens beside editor and terminal', () => {
    const editorTerminalKey = createTerminalLayoutSyncKey(baseLayoutInput);
    const chatEditorTerminalKey = createTerminalLayoutSyncKey({
      ...baseLayoutInput,
      showChatPane: true,
      terminalHost: 'chat',
    });

    expect(chatEditorTerminalKey === editorTerminalKey).toBe(false);
  });

  it('changes the layout sync key when the terminal column changes', () => {
    const leftColumnKey = createTerminalLayoutSyncKey({
      ...baseLayoutInput,
      showChatPane: true,
      terminalHost: 'chat',
      terminalPaneColumn: 'left',
    });
    const rightColumnKey = createTerminalLayoutSyncKey({
      ...baseLayoutInput,
      showChatPane: true,
      terminalHost: 'editor',
      terminalPaneColumn: 'right',
    });

    expect(rightColumnKey === leftColumnKey).toBe(false);
  });

  it('changes the layout sync key when terminal maximization changes', () => {
    const normalKey = createTerminalLayoutSyncKey(baseLayoutInput);
    const maximizedKey = createTerminalLayoutSyncKey({
      ...baseLayoutInput,
      isTerminalEffectivelyMaximized: true,
      showChatPane: false,
      showEditorPane: false,
      terminalHost: 'standalone',
    });

    expect(maximizedKey === normalKey).toBe(false);
  });

  it('keeps the layout sync key stable for identical layout inputs', () => {
    expect(createTerminalLayoutSyncKey(baseLayoutInput)).toBe(createTerminalLayoutSyncKey({
      ...baseLayoutInput,
    }));
  });

  it('schedules one animation-frame sync plus delayed retries', () => {
    vi.useFakeTimers();
    const sync = vi.fn();
    const { runFrame, scheduler } = createScheduler();

    const cleanup = scheduleTerminalLayoutResizeSync(sync, scheduler);

    expect(scheduler.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduler.setTimeout).mock.calls.map(([, delayMs]) => delayMs))
      .toEqual([...terminalLayoutResizeSyncDelaysMs]);

    runFrame(1);
    expect(sync).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(50);
    expect(sync).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(130);
    expect(sync).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(170);
    expect(sync).toHaveBeenCalledTimes(4);

    cleanup();
  });

  it('cancels scheduled layout resize callbacks on cleanup', () => {
    vi.useFakeTimers();
    const sync = vi.fn();
    const { frames, runFrame, scheduler } = createScheduler();

    const cleanup = scheduleTerminalLayoutResizeSync(sync, scheduler);
    cleanup();

    expect(scheduler.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(scheduler.clearTimeout).toHaveBeenCalledTimes(terminalLayoutResizeSyncDelaysMs.length);
    expect(frames.has(1)).toBe(false);

    runFrame(1);
    vi.advanceTimersByTime(350);

    expect(sync).toHaveBeenCalledTimes(0);
  });
});
