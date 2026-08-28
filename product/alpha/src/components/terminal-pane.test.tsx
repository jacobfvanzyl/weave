import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AlphaTerminalsModel } from '@/app/use-alpha-terminals';
import { TerminalPane } from './terminal-pane';

vi.mock('./xterm-terminal-view', () => ({
  XtermTerminalView: ({ data, readOnly }: { data: string; readOnly: boolean }) => (
    <div data-slot='mock-xterm' data-read-only={readOnly}>{data}</div>
  ),
}));

const model = (change: Partial<AlphaTerminalsModel> = {}): AlphaTerminalsModel => ({
  hostId: 'host-1',
  workspaceId: 'workspace-1',
  supported: true,
  tabs: [{
    terminalId: 'terminal-1',
    workspaceId: 'workspace-1',
    title: 'jaco — zsh',
    status: 'running',
    cols: 100,
    rows: 30,
  }],
  activeTerminalId: 'terminal-1',
  attachmentId: 'attachment-1',
  attachmentMode: 'control',
  data: '$ ',
  dataEpoch: 1,
  dataOffset: 0,
  loading: false,
  ...change,
});

describe('TerminalPane', () => {
  it('renders terminal tabs and delegates create, select, and close actions', async () => {
    const user = userEvent.setup();
    const create = vi.fn();
    const select = vi.fn();
    const close = vi.fn();
    render(
      <TerminalPane
        model={model({
          tabs: [
            model().tabs[0],
            { ...model().tabs[0], terminalId: 'terminal-2', title: 'logs' },
          ],
        })}
        disabled={false}
        onCreate={create}
        onSelect={select}
        onClose={close}
      />,
    );

    expect(screen.getByRole('tab', { name: /jaco — zsh/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.click(screen.getByRole('tab', { name: /logs/ }));
    expect(select).toHaveBeenCalledWith('terminal-2');
    expect(screen.getByRole('button', { name: 'Close logs' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Close jaco — zsh' }));
    expect(close).toHaveBeenCalledWith('terminal-1');
    await user.click(screen.getByRole('button', { name: 'New Terminal' }));
    expect(create).toHaveBeenCalledOnce();
  });

  it('renders observer mode read-only and offers to request control', async () => {
    const retry = vi.fn();
    render(
      <TerminalPane
        model={model({
          attachmentMode: 'observe',
          readOnlyReason: 'Controlled elsewhere.',
        })}
        disabled={false}
        onRetryControl={retry}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Controlled elsewhere.');
    expect(document.querySelector('[data-slot="mock-xterm"]')).toHaveAttribute(
      'data-read-only',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Request Control' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
