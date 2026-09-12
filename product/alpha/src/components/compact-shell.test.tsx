import { useRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { AlphaController } from '@/app/alpha-controller';
import { activateWorkspace, emptyWorkspacePresentation, workspaceKey } from '@/app/workspace-presentation';
import { createTranscript } from '@/chat/acp-transcript';
import { useComposerPaneFocus } from '@/app/pane-focus';
import { TerminalFirstShell } from './terminal-first-shell';

vi.mock('@/app/use-alpha-terminals', () => ({ useAlphaTerminals: ({ target }: { target: { terminalId: string } }) => ({
  model: { attachmentId: target.terminalId, attachmentMode: 'shared', tabs: [{ title: target.terminalId }] }, actions: { close: vi.fn() },
}) }));
vi.mock('./terminal-view', () => ({ TerminalView: () => {
  const ref = useRef<HTMLTextAreaElement>(null); useComposerPaneFocus(ref);
  return <textarea ref={ref} aria-label='Terminal input' />;
} }));
afterEach(() => { delete document.documentElement.dataset.deviceIdiom; localStorage.clear(); });
it('uses one phone pane, preserves drafts and split state, and leaves the keyboard to deliberate input', async () => {
  document.documentElement.dataset.deviceIdiom = 'phone'; localStorage.clear();
  const user = userEvent.setup();
  const reference = { hostId: 'host', workspaceId: 'workspace' }, key = workspaceKey(reference);
  const focus = vi.fn(), maximize = vi.fn();
  const terminal = (id: string) => ({ kind: 'terminal', nodeId: id, paneId: id, terminalId: id, executionContextId: 'context' });
  function App() {
    const [selectedThreadId, selectThread] = useState('agent');
    const controller = { model: {
      platform: 'ios', connection: {}, connections: [{ hostId: 'host', status: 'connected' }], composerFocusRequest: 0,
      executionContexts: [{ id: 'context', executionContextId: 'context', hostId: 'host', canonicalPath: '/project' }],
      selectedThreadId, transcript: createTranscript(selectedThreadId),
      threads: [{ id: 'agent', title: 'Agent', hostId: 'host', workspaceId: 'workspace', executionContextId: 'context', draft: true }],
      workspaceCompositions: { presentation: { ...activateWorkspace(emptyWorkspacePresentation(), reference), maximizedPanes: { [key]: 'a' } }, compositions: { host: { hostId: 'host', workspaces: [{ workspaceId: 'workspace', name: 'Workspace', layout: { kind: 'split', nodeId: 'split', axis: 'horizontal', ratio: .5, children: [terminal('a'), terminal('b')] } }] } }, terminals: { host: ['a', 'b'].map(id => ({ terminalId: id, title: id })) } },
    }, actions: { selectThread: async (id: string) => selectThread(id) }, workspaceActions: { activate: vi.fn(), focus, maximize } } as unknown as AlphaController;
    return <TerminalFirstShell controller={controller} />;
  }
  const view = render(<App />);
  expect(screen.getAllByRole('textbox', { name: 'Terminal input' })).toHaveLength(1);
  expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Split right' })).not.toBeInTheDocument();
  const open = async () => { await user.click(screen.getByRole('button', { name: 'Toggle threads' })); await screen.findByRole('dialog'); };
  await open();
  await user.click(screen.getByRole('button', { name: 'Terminal b' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const input = screen.getByRole('textbox', { name: 'Terminal input' });
  expect(input).not.toHaveFocus();
  expect(view.container.querySelector('[data-pane-id="b"]')).toBeVisible();
  await open(); await user.click(screen.getByRole('button', { name: 'Agent Agent' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const composer = screen.getByRole('textbox', { name: 'Message agent' });
  expect(composer).not.toHaveFocus();
  expect(screen.queryByRole('textbox', { name: 'Terminal input' })).not.toBeInTheDocument();
  await user.click(composer); await user.keyboard('keep my draft');
  await open(); await user.click(screen.getByRole('button', { name: 'Terminal b' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await open(); await user.click(screen.getByRole('button', { name: 'Agent Agent' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('textbox', { name: 'Message agent' })).toHaveValue('keep my draft');
  expect(screen.getByRole('textbox', { name: 'Message agent' })).not.toHaveFocus();
  expect(focus).not.toHaveBeenCalled(); expect(maximize).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem('weave.alpha.compact-panes.v1')!).panes[key]).toEqual({ kind: 'agent', id: 'agent' });
});
