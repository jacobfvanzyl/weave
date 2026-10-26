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

const props = (extra: Partial<TerminalPanelProps> = {}): TerminalPanelProps => ({
  tabs: [tests, editor],
  active: tests,
  fontSize: 13,
  placement: 'beside',
  onSelect: vi.fn(),
  onNew: vi.fn(),
  onClose: vi.fn(async () => {}),
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
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(given.onNew).toHaveBeenCalled();
    // Outside the iOS app, nothing draws it.
    expect(screen.getByText('Terminals draw in the iOS app.')).toBeInTheDocument();
  });

  it('ends the terminal when its tab closes, once confirmed', async () => {
    const user = userEvent.setup();
    const given = props();
    render(<TerminalPanel {...given} />);
    await user.click(screen.getByRole('button', { name: 'Close tests' }));
    expect(await screen.findByRole('alertdialog', { name: 'Close tests?' })).toHaveTextContent('its tab closes on every device');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(given.onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Close tests' }));
    await user.click(await screen.findByRole('button', { name: 'Close terminal' }));
    expect(given.onClose).toHaveBeenCalledWith('t-tests');

    // And from the menu.
    await user.click(screen.getByRole('button', { name: 'Terminal actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Close terminal…' }));
    await user.click(await screen.findByRole('button', { name: 'Close terminal' }));
    expect(given.onClose).toHaveBeenCalledTimes(2);
  });

  it('renames a terminal', async () => {
    const user = userEvent.setup();
    const given = props();
    render(<TerminalPanel {...given} />);
    await user.click(screen.getByRole('button', { name: 'Terminal actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Close tab' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: 'Rename terminal…' }));
    const name = await screen.findByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('tests');
    await user.clear(name);
    await user.type(name, 'server{Enter}');
    expect(given.onRename).toHaveBeenCalledWith('t-tests', 'server');
  });

  it('says why when the Host refuses', async () => {
    const user = userEvent.setup();
    render(<TerminalPanel {...props({ onRename: async () => { throw new Error("Couldn't rename the terminal: no such terminal"); } })} />);
    await user.click(screen.getByRole('button', { name: 'Terminal actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename terminal…' }));
    await user.click(await screen.findByRole('button', { name: 'Rename' }));
    expect(await screen.findByText("Couldn't rename the terminal: no such terminal")).toBeInTheDocument();
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

  it("goes on with the thread's top rail on the iPad, and carries the rail's controls over its width", () => {
    const { rerender } = render(<TerminalPanel {...props()} />);
    expect(document.querySelector('[data-slot="terminal-rail"]')).toContainElement(screen.getByRole('tablist', { name: 'Terminals' }));
    rerender(<TerminalPanel {...props({ placement: 'wide', leading: <button type='button'>Show threads</button>, trailing: <button type='button'>Hide terminals</button> })} />);
    const rail = document.querySelector('[data-slot="terminal-rail"]') as HTMLElement;
    expect(within(rail).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent))
      .toEqual(['Show threads', 'Close tests', 'New terminal', 'Terminal actions', 'Hide terminals']);
  });

  it("picks its terminal in its own rail under the thread's header on the iPhone", async () => {
    const user = userEvent.setup();
    const given = props({ placement: 'pane' });
    render(<TerminalPanel {...given} />);
    expect(document.querySelector('[data-slot="terminal-bar"]')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Terminals, showing tests' }));
    expect((await screen.findAllByRole('menuitemradio')).map((item) => [item.textContent, item.getAttribute('aria-checked')]))
      .toEqual([['cargo testtests', 'true'], ['Last command exited 1nvim main.rs', 'false']]);
    await user.click(screen.getByRole('menuitemradio', { name: /nvim main\.rs/ }));
    expect(given.onSelect).toHaveBeenCalledWith('t-editor');

    // The thread's header toggles the pane.
    await user.click(screen.getByRole('button', { name: 'Terminal actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Close terminal…' })).toBeInTheDocument();
    for (const item of ['Full width', 'Hide terminals']) {
      expect(screen.queryByRole('menuitem', { name: item })).not.toBeInTheDocument();
    }
  });

  it('shows a terminal starting, and why one didn\'t, rather than an empty pane', async () => {
    const user = userEvent.setup();
    const given = props({ tabs: [], active: undefined, placement: 'pane', starting: true });
    const { rerender } = render(<TerminalPanel {...given} />);
    expect(screen.getByText('Starting a terminal…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Terminals' })).toHaveTextContent('No terminals');
    rerender(<TerminalPanel {...given} starting={false} startError="Couldn't start a terminal: no shell" />);
    expect(screen.getByText("Couldn't start a terminal: no shell")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(given.onNew).toHaveBeenCalled();
  });
});
