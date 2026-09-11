import { useEffect, useRef, useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { AlphaController } from '@/app/alpha-controller';
import { activateWorkspace, emptyWorkspacePresentation, workspaceKey } from '@/app/workspace-presentation';
import { createTranscript } from '@/chat/acp-transcript';
import { TerminalFirstShell } from './terminal-first-shell';

vi.mock('@/app/use-alpha-terminals', () => ({ useAlphaTerminals: ({ target }: { target: { terminalId: string } }) => ({
  model: { attachmentId: target.terminalId, attachmentMode: 'shared', tabs: [{ title: target.terminalId }] },
  actions: {},
}) }));
vi.mock('./terminal-view', () => ({ TerminalView: ({ focusRequest }: { focusRequest?: string }) => {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (focusRequest) input.current?.focus(); }, [focusRequest]);
  return <textarea ref={input} aria-label='Terminal input' />;
} }));

it('focuses reselected tiles, reveals hidden panes, and waits for an agent transcript', async () => {
  const user = userEvent.setup();
  const reference = { hostId: 'host', workspaceId: 'workspace' };
  const key = workspaceKey(reference);
  const pane = (id: string) => ({ kind: 'terminal', nodeId: id, paneId: id, terminalId: id, executionContextId: 'context' });
  function App() {
    const [presentation, setPresentation] = useState(() => ({ ...activateWorkspace(emptyWorkspacePresentation(), reference), focusedPanes: { [key]: 'terminal' } }));
    const [selectedThreadId, select] = useState('agent');
    const [loading, setLoading] = useState<string>();
    const transcript = createTranscript(selectedThreadId);
    const controller = { model: {
      platform: 'ios', connection: {}, connections: [{ hostId: 'host', status: 'connected' }],
      executionContexts: [{ id: 'context', executionContextId: 'context', hostId: 'host', canonicalPath: '/code/project' }],
      selectedThreadId, loadingThreadId: loading, transcript, composerFocusRequest: 0,
      threads: ['agent', 'other'].map((id) => ({ id, title: id, hostId: 'host', workspaceId: 'workspace', executionContextId: 'context' })),
      workspaceCompositions: { presentation, compositions: { host: { hostId: 'host', workspaces: [{ workspaceId: 'workspace', name: 'Workspace', layout: pane('terminal') }] } }, terminals: { host: [{ terminalId: 'terminal', title: 'Shell' }] } },
    }, actions: { selectThread: async (id: string) => {
      if (id === selectedThreadId) return;
      select(id); setLoading(id);
      await new Promise((resolve) => setTimeout(resolve, 30));
      setLoading(undefined);
    } }, workspaceActions: {
      activate: () => setPresentation((value) => activateWorkspace(value, reference)),
      focus: (_: unknown, paneId: string) => setPresentation((value) => ({ ...value, focusedPanes: { [key]: paneId } })),
      maximize: (_: unknown, paneId: string) => setPresentation((value) => ({ ...value, maximizedPanes: value.maximizedPanes[key] ? {} : { [key]: paneId } })),
    } } as unknown as AlphaController;
    return <TerminalFirstShell controller={controller} />;
  }
  render(<App />);
  const terminalTile = screen.getByRole('button', { name: 'Terminal Shell' });
  const agentTile = screen.getByRole('button', { name: 'Agent agent' });
  const terminal = screen.getByRole('textbox', { name: 'Terminal input' });
  const composer = () => screen.getByRole('textbox', { name: 'Message agent' });
  await user.click(agentTile);
  expect(composer()).toHaveFocus();
  await user.keyboard('draft');
  expect(composer()).toHaveValue('draft');
  for (let repeat = 0; repeat < 2; repeat++) {
    await user.click(terminalTile);
    expect(terminal).toHaveFocus();
    await user.click(agentTile);
    expect(composer()).toHaveFocus();
    expect(composer()).toHaveValue('draft');
  }
  await user.click(screen.getByRole('button', { name: 'Close agent pane' }));
  await user.click(agentTile);
  expect(composer()).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Maximize agent pane' }));
  await user.click(terminalTile);
  expect(terminal).toBeVisible();
  expect(terminal).toHaveFocus();
  await user.keyboard('input');
  expect(terminal).toHaveValue('input');
  await user.click(screen.getByRole('button', { name: 'Maximize terminal' }));
  await user.click(agentTile);
  expect(composer()).toBeVisible();
  expect(composer()).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Agent other' }));
  await waitFor(() => expect(within(screen.getByRole('region', { name: 'Selected agent conversation' })).getByRole('textbox')).toHaveFocus());
});
