import type { TerminalPaneColumn } from '../../stores/workspace-surface-store';
import type { TerminalPanelTarget } from './TerminalPanel';

export type TerminalHost = 'chat' | 'editor' | 'standalone' | null;

type TerminalLayoutSyncKeyInput = {
  isTerminalEffectivelyMaximized: boolean;
  showChatPane: boolean;
  showEditorPane: boolean;
  showTerminalPane: boolean;
  target?: Pick<
    TerminalPanelTarget,
    'kind' | 'terminalId' | 'projectId' | 'workspaceId' | 'portalId' | 'rootId' | 'workspacePath' | 'cwd'
  >;
  terminalHost: TerminalHost;
  terminalPaneColumn: TerminalPaneColumn;
};

export const createTerminalLayoutSyncKey = ({
  isTerminalEffectivelyMaximized,
  showChatPane,
  showEditorPane,
  showTerminalPane,
  target,
  terminalHost,
  terminalPaneColumn,
}: TerminalLayoutSyncKeyInput) => [
  target?.kind ?? 'none',
  target?.terminalId ?? 'none',
  target?.projectId ?? '',
  target?.workspaceId ?? '',
  target?.portalId ?? '',
  target?.rootId ?? '',
  target?.workspacePath ?? '',
  target?.cwd ?? '',
  terminalHost ?? 'hidden',
  showChatPane ? 'chat:open' : 'chat:closed',
  showEditorPane ? 'editor:open' : 'editor:closed',
  showTerminalPane ? 'terminal:open' : 'terminal:closed',
  `column:${terminalPaneColumn}`,
  isTerminalEffectivelyMaximized ? 'maximized:true' : 'maximized:false',
].join('|');

export const terminalLayoutResizeSyncDelaysMs = [50, 180, 350] as const;

export type TerminalLayoutTimeoutHandle = number | ReturnType<typeof setTimeout>;

export type TerminalLayoutResizeScheduler = {
  cancelAnimationFrame: (handle: number) => void;
  clearTimeout: (handle: TerminalLayoutTimeoutHandle) => void;
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  setTimeout: (callback: () => void, delayMs: number) => TerminalLayoutTimeoutHandle;
};

const browserTerminalLayoutResizeScheduler = (): TerminalLayoutResizeScheduler => ({
  cancelAnimationFrame: handle => window.cancelAnimationFrame(handle),
  clearTimeout: handle => window.clearTimeout(handle as number),
  requestAnimationFrame: callback => window.requestAnimationFrame(callback),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
});

export const scheduleTerminalLayoutResizeSync = (
  sync: () => void,
  scheduler = browserTerminalLayoutResizeScheduler(),
) => {
  const animationFrame = scheduler.requestAnimationFrame(() => sync());
  const timers = terminalLayoutResizeSyncDelaysMs.map(delayMs => scheduler.setTimeout(sync, delayMs));

  return () => {
    scheduler.cancelAnimationFrame(animationFrame);
    timers.forEach(timer => scheduler.clearTimeout(timer));
  };
};
