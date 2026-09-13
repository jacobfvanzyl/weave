import { useRef } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { useComposerPaneFocus } from '@/app/pane-focus';
import { usePaneFixture } from '@/test-fixtures/pane-controller';
import { TerminalFirstShell } from './terminal-first-shell';
vi.mock('@/app/use-alpha-terminals', () => ({ useAlphaTerminals: () => ({ model: { attachmentId: 'shell', attachmentMode: 'shared', tabs: [{ title: 'Shell' }] }, actions: {} }) }));
vi.mock('./terminal-view', () => ({ TerminalView: () => { const ref = useRef<HTMLTextAreaElement>(null); useComposerPaneFocus(ref); return <textarea ref={ref} aria-label='Terminal input' />; } }));
it('routes desktop selection and maximize through the same Pane focus while retaining unsent text', async () => {
  const user = userEvent.setup();
  function App() { const { controller } = usePaneFixture(); return <TerminalFirstShell controller={controller} />; }
  render(<App />);
  const first = within(screen.getByRole('region', { name: 'Agent pane first' }));
  const composer = first.getByRole('textbox', { name: 'Message agent' });
  await user.click(screen.getByRole('button', { name: 'Agent first' }));
  await waitFor(() => expect(composer).toHaveFocus());
  await user.keyboard('keep draft');
  await user.click(first.getByRole('button', { name: 'Maximize agent pane' }));
  expect(screen.queryByRole('textbox', { name: 'Terminal input' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Terminal Shell' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Terminal input' })).toHaveFocus());
  await user.click(screen.getByRole('button', { name: 'Agent first' }));
  await waitFor(() => expect(composer).toHaveFocus());
  expect(composer).toHaveValue('keep draft');
});
