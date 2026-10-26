import type { TerminalSummary } from '@/app/app-controller';

/**
 * How a thread shows its worktree's terminals on this device (ADR 0018, ADR 0022). Its tabs are
 * the worktree's terminals, one each, as the Host lists them on every device; this device keeps
 * which is in front, and whether and how the panel shows. The Host keeps no layout.
 */
export type ThreadTerminals = {
  /** The tab in front, by terminal id. */
  active?: string;
  /** The panel beside the thread (iPad), or in the chat's place (iPhone), shows. */
  shown: boolean;
  /** The panel takes the thread's whole width (iPad). */
  wide: boolean;
};

export type TerminalLayout = {
  /** By session key, with when each was last changed, so old threads' layouts are let go. */
  threads: Record<string, ThreadTerminals & { usedAt: number }>;
  /** Points, for every terminal on this device. */
  fontSize: number;
  /** The pane's width beside a thread on the iPad, in CSS pixels: fixed, as the sidebar's is. */
  width: number;
};

export const FONT_SIZE = { initial: 13, min: 9, max: 24, step: 1 } as const;
/** The pane beside a thread; the thread fits what's left, and keeps `thread` of it at least. */
export const PANE_WIDTH = { initial: 440, min: 280, thread: 320 } as const;

/** `width`, in whole pixels, within what the pane takes beside a thread in `available`. */
export const clampPaneWidth = (width: number, available: number) =>
  Math.round(Math.max(PANE_WIDTH.min, Math.min(width, available - PANE_WIDTH.thread)));
/** Threads whose layouts are kept, the most recently changed. */
const KEPT_THREADS = 200;
const STORAGE_KEY = 'weave.terminalLayout';

export const emptyThread = (): ThreadTerminals => ({ shown: false, wide: false });

/** A thread's tabs: its worktree's terminals, one each, oldest first, as on every device. */
export function terminalTabs(terminals: TerminalSummary[]): TerminalSummary[] {
  return [...terminals].sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
}

/**
 * The tab in front: the one last chosen here while its terminal runs, else the newest the thread
 * opened, else the first.
 */
export function activeTab(thread: ThreadTerminals, tabs: TerminalSummary[], sessionId: string): TerminalSummary | undefined {
  return tabs.find(({ id }) => id === thread.active)
    ?? tabs.filter(({ openedFrom }) => openedFrom === sessionId).at(-1)
    ?? tabs[0];
}

/** Brings a tab to the front, and shows the panel. */
export function selectTab(thread: ThreadTerminals, id: string): ThreadTerminals {
  return { ...thread, active: id, shown: true };
}

export const clampFontSize = (size: number) => Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, Math.round(size)));

const isThread = (value: unknown): value is ThreadTerminals & { usedAt: number } => {
  const thread = value as Partial<ThreadTerminals & { usedAt: number }> | null;
  return Boolean(thread) && typeof thread?.shown === 'boolean' && typeof thread?.wide === 'boolean' && typeof thread?.usedAt === 'number'
    && (thread?.active === undefined || typeof thread.active === 'string');
};

/** What's kept of a thread, without what earlier layouts kept besides. */
const kept = ({ active, shown, wide, usedAt }: ThreadTerminals & { usedAt: number }) => ({ ...(active ? { active } : {}), shown, wide, usedAt });

/** The layout this device kept, in the web view's storage. */
export function loadTerminalLayout(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): TerminalLayout {
  try {
    const stored = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null') as Partial<TerminalLayout> | null;
    const threads = Object.fromEntries(Object.entries(stored?.threads ?? {}).flatMap(([key, thread]) => isThread(thread) ? [[key, kept(thread)]] : []));
    const fontSize = typeof stored?.fontSize === 'number' ? clampFontSize(stored.fontSize) : FONT_SIZE.initial;
    const width = typeof stored?.width === 'number' && stored.width >= PANE_WIDTH.min ? Math.round(stored.width) : PANE_WIDTH.initial;
    return { threads, fontSize, width };
  } catch {
    return { threads: {}, fontSize: FONT_SIZE.initial, width: PANE_WIDTH.initial };
  }
}

export function saveTerminalLayout(layout: TerminalLayout, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage) {
  const kept = Object.entries(layout.threads).sort(([, left], [, right]) => right.usedAt - left.usedAt).slice(0, KEPT_THREADS);
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ threads: Object.fromEntries(kept), fontSize: layout.fontSize, width: layout.width }));
  } catch {
    // Full or unavailable: the layout lasts until the app quits.
  }
}

/** What a terminal's tab says: its name, else its title, else its directory's. */
export function terminalName(terminal: TerminalSummary): string {
  const directory = (terminal.pwd ?? terminal.scope).replace(/\/+$/, '');
  return terminal.label || terminal.title || directory.slice(directory.lastIndexOf('/') + 1) || directory || 'Terminal';
}

export type TerminalState =
  | { kind: 'running'; text: string }
  | { kind: 'status'; state: 'working' | 'blocked' | 'error' | 'done'; text: string }
  | { kind: 'exited'; code: number; text: string }
  | { kind: 'idle' };

/**
 * What a tab shows of its terminal's state: the program's own status (OSC 7501) when it reports
 * one, else a command running, else how the last one ended. A terminal whose owner reports none
 * of these is idle.
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
