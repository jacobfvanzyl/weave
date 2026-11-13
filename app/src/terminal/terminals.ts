import type { TerminalSummary } from '@/app/app-controller';
import { HOST_PROTOCOL } from '@/host/protocol';

// What the app shows of a terminal (ADR 0022), and the one thing about terminals this device keeps
// for itself: their font size. Where a terminal shows is its Session's layout (ADR 0031): the
// layout each device kept for a thread's terminals went with WVE-203.

/** How a terminal's Block stands with its stream. */
export type SurfaceState =
  | { kind: 'connecting' }
  /** `vt`: restored from the screen alone, without the history from before attaching. */
  | { kind: 'attached'; restore: 'snapshot' | 'vt' }
  | { kind: 'exited'; exitCode?: number }
  | { kind: 'failed'; message: string };

/** What a terminal's program asked the device to show, or the device did for the person in it. */
export type TerminalNotice =
  | { kind: 'notification'; title: string; body: string }
  /** It wrote to the clipboard, or the person's selection went there, which now has it. */
  | { kind: 'clipboard' };

/** The stream's close codes: the Dispatcher's that carries it, and the Host's. */
export const CLOSE = {
  revoked: HOST_PROTOCOL.websocket.closeRevoked,
  unauthenticated: HOST_PROTOCOL.websocket.closeUnauthenticated,
  ticket: HOST_PROTOCOL.terminalStream.closeTicket,
  exited: HOST_PROTOCOL.terminalStream.closeExited,
} as const;

export const FONT_SIZE = { initial: 16, min: 9, max: 24, step: 1 } as const;

const STORAGE_KEY = 'weave.terminalFontSize';

export const clampFontSize = (size: number) => Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, Math.round(size)));

/** The font size this device kept for its terminals, in points. */
export function loadFontSize(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): number {
  try {
    const stored = Number(storage?.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampFontSize(stored) : FONT_SIZE.initial;
  } catch {
    return FONT_SIZE.initial;
  }
}

export function saveFontSize(size: number, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, String(clampFontSize(size)));
  } catch {
    // Full or unavailable: the size lasts until the app quits.
  }
}

const sizeListeners = new Set<() => void>();

/** Sets the font size of every terminal on this device, and keeps it. */
export function setFontSize(size: number) {
  saveFontSize(size);
  for (const listener of sizeListeners) listener();
}

/** Hears when the device's font size changes; the returned function stops it. */
export function onFontSize(listener: () => void) {
  sizeListeners.add(listener);
  return () => { sizeListeners.delete(listener); };
}

/** A directory's terminals, oldest first, as on every device. */
export function terminalsInOrder(terminals: TerminalSummary[]): TerminalSummary[] {
  return [...terminals].sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
}

/**
 * What a terminal is called, which follows what's in it and nothing anyone typed: the title its
 * program set, else the command running in it, else its directory's name. The same terminal reads
 * the same on every device, and a name given it elsewhere (`label`) isn't shown.
 */
export function terminalName(terminal: TerminalSummary): string {
  const directory = (terminal.pwd ?? terminal.scope).replace(/\/+$/, '');
  const running = terminal.command?.running ? terminal.command.command : undefined;
  return terminal.title || running || directory.slice(directory.lastIndexOf('/') + 1) || directory || 'Terminal';
}

export type TerminalState =
  | { kind: 'running'; text: string }
  | { kind: 'status'; state: 'working' | 'blocked' | 'error' | 'done'; text: string }
  | { kind: 'exited'; code: number; text: string }
  | { kind: 'idle' };

/**
 * What a terminal's state reads as: the program's own status (OSC 7501) when it reports one, else
 * a command running, else how the last one ended. A terminal whose owner reports none of these is
 * idle.
 */
export function terminalState(terminal: TerminalSummary): TerminalState {
  const status = terminal.programStatus?.find(({ state }) => state !== 'idle');
  if (status && status.state !== 'idle') {
    const text = [status.app, status.title, status.msg].filter(Boolean).join(': ') || status.state;
    return { kind: 'status', state: status.state, text: status.progress !== undefined && status.progress !== null ? `${text} (${status.progress}%)` : text };
  }
  const command = terminal.command;
  if (command?.running) return { kind: 'running', text: command.command || terminal.process || 'Running' };
  if (command?.exitCode !== undefined && command.exitCode !== null) {
    return { kind: 'exited', code: command.exitCode, text: command.exitCode === 0 ? 'Last command succeeded' : `Last command exited ${command.exitCode}` };
  }
  return { kind: 'idle' };
}

/** Whether ending the terminal would cut something off: a command runs in it. */
export const terminalBusy = (terminal: TerminalSummary) => terminal.command?.running === true;
