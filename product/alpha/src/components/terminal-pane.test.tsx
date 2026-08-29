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
  scope: {
    hostId: 'host-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
  },
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
    expect(screen.getByRole('tab', { name: /jaco — zsh/ }))
      .not.toHaveClass('border-b');
    expect(screen.getByRole('tab', { name: /logs/ }))
      .toHaveClass('border-b', 'border-border');
    await user.click(screen.getByRole('tab', { name: /logs/ }));
    expect(select).toHaveBeenCalledWith('terminal-2');
    expect(screen.getByRole('button', { name: 'Close logs' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Close jaco — zsh' }));
    expect(close).toHaveBeenCalledWith('terminal-1');
    await user.click(screen.getByRole('button', { name: 'New Terminal' }));
    expect(create).toHaveBeenCalledOnce();
  });

  it('aligns its top rail with the other panes and places maximize after create', async () => {
    const maximize = vi.fn();
    const { container, rerender } = render(
      <TerminalPane
        model={model()}
        disabled={false}
        onToggleMaximized={maximize}
      />,
    );
    const header = container.querySelector('header');
    const actions = container.querySelector('[data-slot="terminal-actions"]');
    const create = screen.getByRole('button', { name: 'New Terminal' });
    const expand = screen.getByRole('button', { name: 'Maximize Terminal' });

    expect(header).toHaveClass('h-11');
    expect(header).not.toHaveClass('border-b');
    expect(actions).toHaveClass('border-l', 'border-b', 'border-border');
    expect(create).toHaveClass('w-11', 'border-0');
    expect(create).not.toHaveClass('border-l');
    expect(expand).toHaveClass('border-0');
    expect(expand).not.toHaveClass('border-l');
    expect(expand.querySelector('[data-symbol="expand-terminal"]'))
      .toBeInTheDocument();
    expect(create.compareDocumentPosition(expand) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(expand).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(expand);
    expect(maximize).toHaveBeenCalledOnce();

    rerender(
      <TerminalPane
        model={model()}
        disabled={false}
        maximized
        onToggleMaximized={maximize}
      />,
    );
    expect(screen.getByRole('button', { name: 'Restore Terminal' }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: 'Restore Terminal' })
        .querySelector('[data-symbol="collapse-terminal"]'),
    ).toBeInTheDocument();
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
