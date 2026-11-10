import { describe, expect, it } from 'vitest';
import type { TerminalSummary } from '@/app/app-controller';
import { FONT_SIZE, loadFontSize, saveFontSize, terminalBusy, terminalName, terminalState, terminalsInOrder } from './terminals';

const WORKTREE = '/Users/jaco/Documents/VeeZee/weave';

const terminal = (id: string, extra: Partial<TerminalSummary> = {}): TerminalSummary => ({
  id,
  scope: WORKTREE,
  size: { cols: 80, rows: 24 },
  startedAt: 1,
  ...extra,
});

describe('a directory’s terminals', () => {
  it('are in order of starting, on every device alike', () => {
    const listed = [terminal('c', { startedAt: 3 }), terminal('b', { startedAt: 1 }), terminal('a', { startedAt: 1 })];
    expect(terminalsInOrder(listed).map(({ id }) => id)).toEqual(['a', 'b', 'c']);
  });

  it('show without openedFrom, command or program status, as a Rex block’s would', () => {
    const bare = terminal('rex-block', { pwd: `${WORKTREE}/app` });
    expect(terminalName(bare)).toBe('app');
    expect(terminalState(bare)).toEqual({ kind: 'idle' });
    expect(terminalBusy(bare)).toBe(false);
  });
});

describe('a terminal', () => {
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

  it('is busy while a command runs in it, which closing it would cut off', () => {
    expect(terminalBusy(terminal('a', { command: { running: true } }))).toBe(true);
    expect(terminalBusy(terminal('a', { command: { running: false, exitCode: 0 } }))).toBe(false);
  });
});

describe('the font size this device keeps', () => {
  const storage = () => {
    const kept = new Map<string, string>();
    return { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); } };
  };

  it('is kept, within what a terminal can be read at', () => {
    const store = storage();
    expect(loadFontSize(store)).toBe(FONT_SIZE.initial);
    saveFontSize(16, store);
    expect(loadFontSize(store)).toBe(16);
    saveFontSize(400, store);
    expect(loadFontSize(store)).toBe(FONT_SIZE.max);
  });

  it('is the first size when storage can’t be read', () => {
    expect(loadFontSize({ getItem: () => 'nonsense' })).toBe(FONT_SIZE.initial);
    expect(loadFontSize({ getItem: () => { throw new Error('blocked'); } })).toBe(FONT_SIZE.initial);
  });
});
