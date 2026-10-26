import type { TerminalSummary } from '@/app/app-controller';

/**
 * How a thread shows its worktree's terminals on this device (ADR 0018, ADR 0022): which are open
 * as tabs, which is in front, and whether the panel shows. The Host keeps no layout.
 */
export type ThreadTerminals = {
  /** Tabs the person opened, in order, by terminal id. */
  open: string[];
  /** Terminals this thread opened whose tabs the person closed, which don't open again by themselves. */
  hidden: string[];
  active?: string;
  /** The panel beside the thread (iPad) or the sheet over it (iPhone) shows. */
  shown: boolean;
  /** The panel takes the thread's whole width (iPad). */
  wide: boolean;
};

export type TerminalLayout = {
  /** By session key, with when each was last changed, so old threads' layouts are let go. */
  threads: Record<string, ThreadTerminals & { usedAt: number }>;
  /** Points, for every terminal on this device. */
  fontSize: number;
};

export const FONT_SIZE = { initial: 13, min: 9, max: 24, step: 1 } as const;
/** Threads whose layouts are kept, the most recently changed. */
const KEPT_THREADS = 200;
const STORAGE_KEY = 'weave.terminalLayout';

export const emptyThread = (): ThreadTerminals => ({ open: [], hidden: [], shown: false, wide: false });

/**
 * The tabs a thread shows: those the person opened that still run, then those the thread opened
 * that the person hasn't closed the tabs of, oldest first. A terminal without `openedFrom` opens
 * only when the person opens it.
 */
export function terminalTabs(thread: ThreadTerminals, terminals: TerminalSummary[], sessionId: string): TerminalSummary[] {
  const byId = new Map(terminals.map((terminal) => [terminal.id, terminal]));
  const opened = thread.open.flatMap((id) => byId.get(id) ?? []);
  const defaults = terminals.filter(({ id, openedFrom }) =>
    openedFrom === sessionId && !thread.open.includes(id) && !thread.hidden.includes(id));
  return [...opened, ...defaults];
}

/** The worktree's other terminals, which the person may open beside this thread too. */
export function otherTerminals(thread: ThreadTerminals, terminals: TerminalSummary[], sessionId: string): TerminalSummary[] {
  const tabs = new Set(terminalTabs(thread, terminals, sessionId).map(({ id }) => id));
  return terminals.filter(({ id }) => !tabs.has(id));
}

/** The tab in front: the one last chosen while it's still a tab, else the first. */
export function activeTab(thread: ThreadTerminals, tabs: TerminalSummary[]): TerminalSummary | undefined {
  return tabs.find(({ id }) => id === thread.active) ?? tabs[0];
}

/** Opens a terminal's tab in front, and shows the panel. */
export function openTab(thread: ThreadTerminals, id: string): ThreadTerminals {
  return {
    ...thread,
    open: thread.open.includes(id) ? thread.open : [...thread.open, id],
    hidden: thread.hidden.filter((hidden) => hidden !== id),
    active: id,
    shown: true,
  };
}

export function selectTab(thread: ThreadTerminals, id: string): ThreadTerminals {
  return { ...thread, active: id };
}

/**
 * Closes a terminal's tab, leaving the terminal running. The tab beside it comes to the front, and
 * the panel hides with its last tab.
 */
export function closeTab(thread: ThreadTerminals, id: string, terminals: TerminalSummary[], sessionId: string): ThreadTerminals {
  const tabs = terminalTabs(thread, terminals, sessionId);
  const index = tabs.findIndex((tab) => tab.id === id);
  const rest = tabs.filter((tab) => tab.id !== id);
  const front = activeTab(thread, tabs)?.id === id ? rest[Math.min(Math.max(index, 0), rest.length - 1)]?.id : thread.active;
  const opened = terminals.find((terminal) => terminal.id === id)?.openedFrom === sessionId;
  return {
    ...thread,
    open: thread.open.filter((open) => open !== id),
    hidden: opened && !thread.hidden.includes(id) ? [...thread.hidden, id] : thread.hidden,
    active: front,
    shown: thread.shown && rest.length > 0,
  };
}

/** Lets go of terminals that ended, so the layout keeps only those still running. */
export function forgetEnded(thread: ThreadTerminals, terminals: TerminalSummary[]): ThreadTerminals {
  const running = new Set(terminals.map(({ id }) => id));
  const open = thread.open.filter((id) => running.has(id));
  const hidden = thread.hidden.filter((id) => running.has(id));
  if (open.length === thread.open.length && hidden.length === thread.hidden.length) return thread;
  return { ...thread, open, hidden };
}

export const clampFontSize = (size: number) => Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, Math.round(size)));

const isThread = (value: unknown): value is ThreadTerminals & { usedAt: number } => {
  const thread = value as Partial<ThreadTerminals & { usedAt: number }> | null;
  return Boolean(thread) && Array.isArray(thread?.open) && Array.isArray(thread?.hidden)
    && typeof thread?.shown === 'boolean' && typeof thread?.wide === 'boolean' && typeof thread?.usedAt === 'number';
};

/** The layout this device kept, in the web view's storage. */
export function loadTerminalLayout(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): TerminalLayout {
  try {
    const stored = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null') as Partial<TerminalLayout> | null;
    const threads = Object.fromEntries(Object.entries(stored?.threads ?? {}).filter(([, thread]) => isThread(thread)));
    const fontSize = typeof stored?.fontSize === 'number' ? clampFontSize(stored.fontSize) : FONT_SIZE.initial;
    return { threads, fontSize };
  } catch {
    return { threads: {}, fontSize: FONT_SIZE.initial };
  }
}

export function saveTerminalLayout(layout: TerminalLayout, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage) {
  const kept = Object.entries(layout.threads).sort(([, left], [, right]) => right.usedAt - left.usedAt).slice(0, KEPT_THREADS);
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ threads: Object.fromEntries(kept), fontSize: layout.fontSize }));
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
