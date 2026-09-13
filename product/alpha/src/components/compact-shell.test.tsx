import { useRef } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { useComposerPaneFocus } from '@/app/pane-focus';
import { usePaneFixture } from '@/test-fixtures/pane-controller';
import { TerminalFirstShell } from './terminal-first-shell';
vi.mock('@/app/use-alpha-terminals', () => ({ useAlphaTerminals: () => ({ model: { attachmentId: 'shell', attachmentMode: 'shared', tabs: [{ title: 'Shell' }] }, actions: {} }) }));
vi.mock('./terminal-view', () => ({ TerminalView: () => { const ref = useRef<HTMLTextAreaElement>(null); useComposerPaneFocus(ref); return <textarea ref={ref} aria-label='Terminal input' />; } }));
afterEach(() => { delete document.documentElement.dataset.deviceIdiom; });
it('shows one composition Pane on phone without changing splits or opening the software keyboard', async () => {
  document.documentElement.dataset.deviceIdiom = 'phone';
  const user = userEvent.setup(); let fixture!: ReturnType<typeof usePaneFixture>;
  function App() { fixture = usePaneFixture('ios'); return <TerminalFirstShell controller={fixture.controller} />; }
  const view = render(<App />);
  const layout = fixture.controller.model.workspaceCompositions!.compositions.host!.workspaces[0]!.layout;
  expect(screen.getAllByRole('textbox')).toHaveLength(1);
  expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  const select = async (name: string) => {
    await user.click(screen.getByRole('button', { name: 'Toggle threads' }));
    await screen.findByRole('dialog'); await user.click(screen.getByRole('button', { name }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  };
  await select('Agent first');
  const composer = screen.getByRole('textbox', { name: 'Message agent' });
  expect(composer).not.toHaveFocus();
  await user.click(composer); await user.keyboard('keep my draft');
  await select('Terminal Shell');
  expect(screen.getByRole('textbox', { name: 'Terminal input' })).not.toHaveFocus();
  await select('Agent first');
  expect(screen.getByRole('textbox', { name: 'Message agent' })).toHaveValue('keep my draft');
  expect(composer).not.toHaveFocus();
  expect(fixture.controller.model.workspaceCompositions!.compositions.host!.workspaces[0]!.layout).toEqual(layout);
  expect(view.container.querySelector('[data-pane-id="first"]')).toBeVisible();
});
