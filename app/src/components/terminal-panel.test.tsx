import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalSummary } from '@/app/app-controller';
import { TerminalPanel, type TerminalPanelProps } from './terminal-panel';

const terminal = (id: string, extra: Partial<TerminalSummary> = {}): TerminalSummary => ({
  id,
  scope: '/work/project',
  size: { cols: 80, rows: 24 },
  startedAt: 1,
  ...extra,
});

const tests = terminal('t-tests', { label: 'tests', command: { running: true, command: 'cargo test' } });
const editor = terminal('t-editor', { title: 'nvim main.rs', command: { running: false, exitCode: 1 } });
const block = terminal('t-block', { pwd: '/work/project/app' });

const props = (extra: Partial<TerminalPanelProps> = {}): TerminalPanelProps => ({
  tabs: [tests, editor],
  others: [block],
  active: tests,
  fontSize: 13,
  wide: false,
  onSelect: vi.fn(),
  onOpen: vi.fn(),
  onCloseTab: vi.fn(),
  onNew: vi.fn(async () => {}),
  onEnd: vi.fn(async () => {}),
  onRename: vi.fn(async () => {}),
  onWide: vi.fn(),
  onFontSize: vi.fn(),
  onDone: vi.fn(),
  attach: vi.fn(async () => ({ url: 'wss://mac', ticket: 'k' })),
  ...extra,
});

describe('TerminalPanel', () => {
  it("shows a tab per terminal, with what it's doing", async () => {
    const user = userEvent.setup();
    const given = props();
    render(<TerminalPanel {...given} />);
    const tabs = within(screen.getByRole('tablist', { name: 'Terminals' })).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['cargo testtests', 'Last command exited 1nvim main.rs']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    await user.click(tabs[1]);
    expect(given.onSelect).toHaveBeenCalledWith('t-editor');
    await user.click(screen.getByRole('button', { name: 'Close the tab of tests' }));
    expect(given.onCloseTab).toHaveBeenCalledWith('t-tests');
    // Outside the iOS app, nothing draws it.
    expect(screen.getByText('Terminals draw in the iOS app.')).toBeInTheDocument();
  });

  it('starts a terminal, and opens another of the worktree', async () => {
    const user = userEvent.setup();
    const given = props();
    render(<TerminalPanel {...given} />);
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(given.onNew).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Terminal actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Open app' }));
    expect(given.onOpen).toHaveBeenCalledWith('t-block');
  });

  it('renames a terminal, and ends it once confirmed', async () => {
    const user = userEvent.setup();
    const given = props();
    render(<TerminalPanel {...given} />);
    await user.click(screen.getByRole('button', { name: 'Terminal actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename terminal…' }));
    const name = await screen.findByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('tests');
    await user.clear(name);
    await user.type(name, 'server{Enter}');
    expect(given.onRename).toHaveBeenCalledWith('t-tests', 'server');

    await user.click(screen.getByRole('button', { name: 'Terminal actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'End terminal…' }));
    expect(given.onEnd).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'End' }));
    expect(given.onEnd).toHaveBeenCalledWith('t-tests');
  });

  it('says why when the Host refuses', async () => {
    const user = userEvent.setup();
    render(<TerminalPanel {...props({ onNew: async () => { throw new Error("Couldn't start a terminal: no shell"); } })} />);
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(await screen.findByText("Couldn't start a terminal: no shell")).toBeInTheDocument();
  });

  it('takes the full width, sizes its text, and hides', async () => {
    const user = userEvent.setup();
    const given = props();
    render(<TerminalPanel {...given} />);
    const menu = async (item: string) => {
      await user.click(screen.getByRole('button', { name: 'Terminal actions' }));
      await user.click(await screen.findByRole('menuitem', { name: item }));
    };
    await menu('Full width');
    expect(given.onWide).toHaveBeenCalledWith(true);
    await menu('Larger text');
    expect(given.onFontSize).toHaveBeenCalledWith(14);
    await menu('Smaller text');
    expect(given.onFontSize).toHaveBeenCalledWith(12);
    await menu('Hide terminals');
    expect(given.onDone).toHaveBeenCalled();
  });

  it("is a sheet with Done on the iPhone, and says when the thread has none open", async () => {
    const user = userEvent.setup();
    const given = props({ tabs: [], active: undefined, wide: undefined });
    render(<TerminalPanel {...given} />);
    expect(screen.getByText('No terminal is open beside this thread.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(given.onDone).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Terminal actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Open app' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Full width' })).not.toBeInTheDocument();
  });
});
