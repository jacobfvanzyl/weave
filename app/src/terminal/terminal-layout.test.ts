import { describe, expect, it } from 'vitest';
import type { TerminalSummary } from '@/app/app-controller';
import {
  activeTab,
  closeTab,
  emptyThread,
  FONT_SIZE,
  forgetEnded,
  loadTerminalLayout,
  openTab,
  otherTerminals,
  saveTerminalLayout,
  selectTab,
  terminalName,
  terminalState,
  terminalTabs,
} from './terminal-layout';

const WORKTREE = '/Users/jaco/Documents/VeeZee/weave';

const terminal = (id: string, extra: Partial<TerminalSummary> = {}): TerminalSummary => ({
  id,
  scope: WORKTREE,
  size: { cols: 80, rows: 24 },
  startedAt: 1,
  ...extra,
});

/** A worktree's terminals: two this thread opened, one another thread did, and one nobody did, as a Rex block's would be. */
const worktree = [
  terminal('mine-1', { openedFrom: 'this' }),
  terminal('theirs', { openedFrom: 'other' }),
  terminal('mine-2', { openedFrom: 'this' }),
  terminal('nobodys'),
];
const ids = (terminals: TerminalSummary[]) => terminals.map(({ id }) => id);

describe('the terminals a thread shows', () => {
  it('opens the ones it opened, by default', () => {
    expect(ids(terminalTabs(emptyThread(), worktree, 'this'))).toEqual(['mine-1', 'mine-2']);
    expect(ids(otherTerminals(emptyThread(), worktree, 'this'))).toEqual(['theirs', 'nobodys']);
    expect(ids(terminalTabs(emptyThread(), worktree, 'other'))).toEqual(['theirs']);
  });

  it('puts tabs the person opened first, in order, then the defaults', () => {
    let thread = openTab(emptyThread(), 'nobodys');
    thread = openTab(thread, 'theirs');
    expect(ids(terminalTabs(thread, worktree, 'this'))).toEqual(['nobodys', 'theirs', 'mine-1', 'mine-2']);
    expect(activeTab(thread, terminalTabs(thread, worktree, 'this'))?.id).toBe('theirs');
    expect(thread.shown).toBe(true);
    expect(otherTerminals(thread, worktree, 'this')).toEqual([]);
  });

  it("doesn't open a default again once its tab is closed, until the person opens it", () => {
    let thread = { ...emptyThread(), shown: true };
    thread = closeTab(thread, 'mine-1', worktree, 'this');
    expect(ids(terminalTabs(thread, worktree, 'this'))).toEqual(['mine-2']);
    expect(ids(otherTerminals(thread, worktree, 'this'))).toEqual(['mine-1', 'theirs', 'nobodys']);
    expect(thread.shown).toBe(true);
    thread = openTab(thread, 'mine-1');
    expect(ids(terminalTabs(thread, worktree, 'this'))).toEqual(['mine-1', 'mine-2']);
  });

  it('brings the tab beside a closed one to the front, and hides the panel with the last', () => {
    let thread = selectTab({ ...openTab(openTab(emptyThread(), 'nobodys'), 'theirs') }, 'theirs');
    // Tabs: nobodys, theirs, mine-1, mine-2.
    thread = closeTab(thread, 'theirs', worktree, 'this');
    expect(activeTab(thread, terminalTabs(thread, worktree, 'this'))?.id).toBe('mine-1');
    thread = closeTab(thread, 'mine-2', worktree, 'this');
    expect(activeTab(thread, terminalTabs(thread, worktree, 'this'))?.id).toBe('mine-1');
    thread = closeTab(closeTab(thread, 'mine-1', worktree, 'this'), 'nobodys', worktree, 'this');
    expect(terminalTabs(thread, worktree, 'this')).toEqual([]);
    expect(thread.shown).toBe(false);
  });

  it('drops terminals that ended', () => {
    const thread = openTab(closeTab(emptyThread(), 'mine-1', worktree, 'this'), 'theirs');
    const left = forgetEnded(thread, [worktree[2]]);
    expect(left.open).toEqual([]);
    expect(left.hidden).toEqual([]);
    expect(forgetEnded(left, [worktree[2]])).toBe(left);
  });

  it('lists, opens and names a terminal without openedFrom, command or program status', () => {
    const bare = terminal('rex-block', { pwd: '/Users/jaco/Documents/VeeZee/weave/app' });
    const thread = openTab(emptyThread(), bare.id);
    expect(ids(terminalTabs(emptyThread(), [bare], 'this'))).toEqual([]);
    expect(ids(otherTerminals(emptyThread(), [bare], 'this'))).toEqual(['rex-block']);
    expect(ids(terminalTabs(thread, [bare], 'this'))).toEqual(['rex-block']);
    expect(terminalName(bare)).toBe('app');
    expect(terminalState(bare)).toEqual({ kind: 'idle' });
  });
});

describe("a terminal's tab", () => {
  it('is named by its label, then its title, then its directory', () => {
    expect(terminalName(terminal('a', { label: 'server', title: 'zsh' }))).toBe('server');
    expect(terminalName(terminal('a', { title: 'vim main.rs' }))).toBe('vim main.rs');
    expect(terminalName(terminal('a'))).toBe('weave');
  });

  it("shows the program's status first, then a running command, then the last exit code", () => {
    const status = terminal('a', {
      command: { running: true, command: 'cargo test' },
      programStatus: [{ state: 'idle' }, { id: 'build', state: 'working', app: 'cargo', title: 'Building', progress: 40 }],
    });
    expect(terminalState(status)).toEqual({ kind: 'status', state: 'working', text: 'cargo: Building (40%)' });
    expect(terminalState(terminal('a', { command: { running: true, command: 'cargo test' } }))).toEqual({ kind: 'running', text: 'cargo test' });
    expect(terminalState(terminal('a', { command: { running: true }, process: 'nvim' }))).toEqual({ kind: 'running', text: 'nvim' });
    expect(terminalState(terminal('a', { command: { running: false, exitCode: 2 } }))).toEqual({ kind: 'exited', code: 2, text: 'Last command exited 2' });
    expect(terminalState(terminal('a', { command: { running: false, exitCode: 0 } }))).toMatchObject({ kind: 'exited', code: 0 });
  });
});

describe('the layout on this device', () => {
  it('keeps each thread and the font size', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    expect(loadTerminalLayout(storage)).toEqual({ threads: {}, fontSize: FONT_SIZE.initial });
    const thread = { ...openTab(emptyThread(), 'mine-1'), wide: true, usedAt: 5 };
    saveTerminalLayout({ threads: { 'host/this': thread }, fontSize: 16 }, storage);
    expect(loadTerminalLayout(storage)).toEqual({ threads: { 'host/this': thread }, fontSize: 16 });
  });

  it('lets old threads go, and ignores what it can’t read', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    const threads = Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`host/${index}`, { ...emptyThread(), usedAt: index }]));
    saveTerminalLayout({ threads, fontSize: 40 }, storage);
    const loaded = loadTerminalLayout(storage);
    expect(Object.keys(loaded.threads)).toHaveLength(200);
    expect(loaded.threads['host/249']).toBeDefined();
    expect(loaded.threads['host/0']).toBeUndefined();
    expect(loaded.fontSize).toBe(FONT_SIZE.max);
    store.set('weave.terminalLayout', '{"threads":{"host/x":{"open":"nope"}},"fontSize":"big"}');
    expect(loadTerminalLayout(storage)).toEqual({ threads: {}, fontSize: FONT_SIZE.initial });
    store.set('weave.terminalLayout', 'not json');
    expect(loadTerminalLayout(storage)).toEqual({ threads: {}, fontSize: FONT_SIZE.initial });
  });
});
