import { useRef } from 'react';
import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { useComposerPaneFocus, usePaneFocus, type PaneFocusOwner } from '@/app/pane-focus';
import { usePaneFixture } from '@/test-fixtures/pane-controller';
import { TerminalFirstShell } from './terminal-first-shell';

vi.mock('@/app/use-alpha-terminals', () => ({ useAlphaTerminals: () => ({ model: { attachmentId: 'shell', attachmentMode: 'shared', tabs: [{ title: 'Shell' }] }, actions: {} }) }));
let focusOwner: PaneFocusOwner;
vi.mock('./terminal-view', () => ({ TerminalView: () => { const ref = useRef<HTMLTextAreaElement>(null); useComposerPaneFocus(ref); focusOwner = usePaneFocus()!; return <textarea ref={ref} aria-label='Terminal input' />; } }));

it('keeps the clicked terminal selected when an older native-to-composer handoff refocuses the web view', async () => {
  const user = userEvent.setup();
  function App() { const fixture = usePaneFixture(); return <TerminalFirstShell controller={fixture.controller} />; }
  render(<App />);
  const composer = within(screen.getByRole('region', { name: 'Agent pane first' })).getByRole('textbox') as HTMLTextAreaElement;
  const terminal = screen.getByRole('textbox', { name: 'Terminal input' });
  await user.click(composer);
  const agentId = composer.closest<HTMLElement>('[data-pane-focus-id]')!.dataset.paneFocusId!;
  const terminalId = terminal.closest<HTMLElement>('[data-pane-focus-id]')!.dataset.paneFocusId!;
  let finish!: () => void;
  const unregister = focusOwner.register(agentId, { element: composer, available: () => true, focus: async isCurrent => {
    await new Promise<void>(resolve => { finish = resolve; });
    // Electron restores the previously active DOM input when focusWeb completes.
    composer.blur(); composer.focus(); return isCurrent();
  } });
  try {
    act(() => focusOwner.restoreTarget());
    await waitFor(() => expect(finish).toBeDefined());
    act(() => { focusOwner.request(terminalId); fireEvent.focusIn(terminal); });
    await act(async () => finish());
    await waitFor(() => expect(terminal).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Terminal Shell' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Agent first' })).toHaveAttribute('aria-pressed', 'false');
  } finally { unregister(); }
});

it('renders independent conversations in one Workspace with shared rails, borders and one focused Pane', async () => {
  const user = userEvent.setup();
  let fixture!: ReturnType<typeof usePaneFixture>;
  function App() { fixture = usePaneFixture(); return <TerminalFirstShell controller={fixture.controller} />; }
  const view = render(<App />);
  expect(view.container.querySelectorAll('[data-slot="pane-top-rail"]')).toHaveLength(3);
  expect(view.container.querySelectorAll('[data-slot="pane-focus-border"]')).toHaveLength(3);
  expect(view.container.querySelector('#agent-conversation')).not.toBeInTheDocument();
  expect(view.container.querySelector('[data-slot="thread-top-rail"]')).not.toBeInTheDocument();
  const first = within(screen.getByRole('region', { name: 'Agent pane first' }));
  const second = within(screen.getByRole('region', { name: 'Agent pane second' }));
  await user.click(first.getByRole('textbox', { name: 'Message agent' })); await user.keyboard('first message');
  await user.click(second.getByRole('textbox', { name: 'Message agent' })); await user.keyboard('second message');
  expect(first.getByRole('textbox')).toHaveValue('first message');
  expect(second.getByRole('textbox')).toHaveValue('second message');
  await user.click(first.getByRole('button', { name: 'Send message' }));
  expect(fixture.send).toHaveBeenCalledWith('first', 'first message');
  await user.click(second.getByRole('button', { name: 'Send message' }));
  expect(fixture.send).toHaveBeenCalledWith('second', 'second message');
  expect(view.container.querySelectorAll('[data-slot="pane-focus-border"].border-terminal-focus')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Agent second' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Terminal Shell' })).toHaveAttribute('aria-pressed', 'false');
  await user.click(screen.getByRole('button', { name: 'Workspace Other' }));
  expect(screen.queryByRole('region', { name: 'Agent pane first' })).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Agent pane third' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Agent second' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: 'Agent third' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByText('Last visible agent. Activate to reopen.')).not.toBeInTheDocument();
});

it('archives a completed Agent Pane without confirmation and preserves its neighbors', async () => {
  const user = userEvent.setup(); let fixture!: ReturnType<typeof usePaneFixture>;
  function App() { fixture = usePaneFixture(); fixture.controller.model.threads![0]!.attention = { state: 'completed', observedAt: new Date().toISOString() }; return <TerminalFirstShell controller={fixture.controller} />; }
  render(<App />);
  const terminal = screen.getByRole('textbox', { name: 'Terminal input' });
  const first = within(screen.getByRole('region', { name: 'Agent pane first' }));
  await user.click(first.getByRole('button', { name: 'Archive agent pane' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Agent pane first' })).not.toBeInTheDocument());
  expect(fixture.archive).toHaveBeenCalledWith('first', false);
  expect(screen.getByRole('textbox', { name: 'Terminal input' })).toBe(terminal);
  expect(screen.getByRole('region', { name: 'Agent pane second' })).toBeInTheDocument();
});
