import { describe, expect, it } from 'vitest';
import type { TerminalSummary } from '@/app/app-controller';
import {
  activeTab,
  clampPaneWidth,
  emptyThread,
  FONT_SIZE,
  loadTerminalLayout,
  PANE_WIDTH,
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
  terminal('theirs', { openedFrom: 'other', startedAt: 2 }),
  terminal('mine-1', { openedFrom: 'this', startedAt: 1 }),
  terminal('nobodys', { startedAt: 4 }),
  terminal('mine-2', { openedFrom: 'this', startedAt: 3 }),
];
const ids = (terminals: TerminalSummary[]) => terminals.map(({ id }) => id);

describe('the terminals a thread shows', () => {
  it('has a tab for each of its worktree\'s terminals, oldest first, on every thread alike', () => {
    expect(ids(terminalTabs(worktree))).toEqual(['mine-1', 'theirs', 'mine-2', 'nobodys']);
    expect(ids(terminalTabs([...worktree].reverse()))).toEqual(['mine-1', 'theirs', 'mine-2', 'nobodys']);
  });

  it('puts the newest it opened in front, until the person picks another', () => {
    const tabs = terminalTabs(worktree);
    expect(activeTab(emptyThread(), tabs, 'this')?.id).toBe('mine-2');
    expect(activeTab(emptyThread(), tabs, 'other')?.id).toBe('theirs');
    expect(activeTab(emptyThread(), tabs, 'neither')?.id).toBe('mine-1');
    const picked = selectTab(emptyThread(), 'nobodys');
    expect(picked).toEqual({ active: 'nobodys', shown: true, wide: false });
    expect(activeTab(picked, tabs, 'this')?.id).toBe('nobodys');
    // Once the picked one ends, the default comes back.
    expect(activeTab(picked, tabs.filter(({ id }) => id !== 'nobodys'), 'this')?.id).toBe('mine-2');
    expect(activeTab(picked, [], 'this')).toBeUndefined();
  });

  it('shows, names and tabs a terminal without openedFrom, command or program status', () => {
    const bare = terminal('rex-block', { pwd: '/Users/jaco/Documents/VeeZee/weave/app' });
    expect(ids(terminalTabs([bare]))).toEqual(['rex-block']);
    expect(activeTab(emptyThread(), [bare], 'this')?.id).toBe('rex-block');
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
  const storage = () => {
    const store = new Map<string, string>();
    return { store, getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  };

  it('keeps each thread and the font size', () => {
    const kept = storage();
    const blank = { threads: {}, fontSize: FONT_SIZE.initial, width: PANE_WIDTH.initial };
    expect(loadTerminalLayout(kept)).toEqual(blank);
    const thread = { ...selectTab(emptyThread(), 'mine-1'), wide: true, usedAt: 5 };
    saveTerminalLayout({ threads: { 'host/this': thread }, fontSize: 16, width: 520 }, kept);
    expect(loadTerminalLayout(kept)).toEqual({ threads: { 'host/this': thread }, fontSize: 16, width: 520 });
  });

  it("keeps the pane no narrower than its least, and leaves the thread its own", () => {
    expect(clampPaneWidth(500.4, 1180)).toBe(500);
    expect(clampPaneWidth(100, 1180)).toBe(PANE_WIDTH.min);
    expect(clampPaneWidth(1000, 1180)).toBe(1180 - PANE_WIDTH.thread);
    // A window too narrow for both keeps the pane's least.
    expect(clampPaneWidth(500, 500)).toBe(PANE_WIDTH.min);
  });

  it('lets old threads go, keeps what it needs of an earlier layout, and ignores what it can’t read', () => {
    const kept = storage();
    const threads = Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`host/${index}`, { ...emptyThread(), usedAt: index }]));
    saveTerminalLayout({ threads, fontSize: 40, width: 100 }, kept);
    const loaded = loadTerminalLayout(kept);
    expect(Object.keys(loaded.threads)).toHaveLength(200);
    expect(loaded.threads['host/249']).toBeDefined();
    expect(loaded.threads['host/0']).toBeUndefined();
    expect(loaded.fontSize).toBe(FONT_SIZE.max);
    expect(loaded.width).toBe(PANE_WIDTH.initial);
    kept.store.set('weave.terminalLayout', '{"threads":{"host/x":{"open":["t-1"],"hidden":[],"active":"t-1","shown":true,"wide":false,"usedAt":1}},"fontSize":14}');
    expect(loadTerminalLayout(kept)).toEqual({ threads: { 'host/x': { active: 't-1', shown: true, wide: false, usedAt: 1 } }, fontSize: 14, width: PANE_WIDTH.initial });
    kept.store.set('weave.terminalLayout', '{"threads":{"host/x":{"shown":"yes"}},"fontSize":"big"}');
    expect(loadTerminalLayout(kept)).toEqual({ threads: {}, fontSize: FONT_SIZE.initial, width: PANE_WIDTH.initial });
    kept.store.set('weave.terminalLayout', 'not json');
    expect(loadTerminalLayout(kept)).toEqual({ threads: {}, fontSize: FONT_SIZE.initial, width: PANE_WIDTH.initial });
  });
});
