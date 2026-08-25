import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createAcpShowcaseTranscript } from './acp-showcase';
import { ChatPane, type ChatPaneActions } from './chat-pane';

const actions = (): ChatPaneActions => ({
  sendPrompt: vi.fn(),
  cancelPrompt: vi.fn(),
  respondToPermission: vi.fn(),
  respondToElicitation: vi.fn(),
  setMode: vi.fn(),
  setConfigOption: vi.fn(),
});

describe('ChatPane', () => {
  it('renders every ACP transcript family without flattening rich payloads', () => {
    const { container } = render(
      <ChatPane model={createAcpShowcaseTranscript()} actions={actions()} />,
    );

    expect(screen.getByText('Exercise the complete ACP renderer.')).toBeInTheDocument();
    expect(screen.getByText('Checking every content family.')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="message-header"]')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ACP rich content' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'memory://pixel.png' })).toBeInTheDocument();
    expect(screen.getByLabelText('Audio content')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ACP specification' })).toHaveAttribute(
      'href',
      'https://agentclientprotocol.com',
    );
    expect(screen.getByText('# Embedded README')).toBeInTheDocument();
    expect(screen.getByText('archive.bin')).toBeInTheDocument();

    expect(screen.getByText('Update README')).toBeInTheDocument();
    expect(screen.getAllByText('/workspace/README.md')).toHaveLength(2);
    expect(screen.getByText('# Old')).toBeInTheDocument();
    expect(screen.getByText('# New')).toBeInTheDocument();
    expect(screen.getByText('terminal-showcase')).toBeInTheDocument();

    expect(screen.getByText('Inspect the protocol')).toBeInTheDocument();
    expect(screen.getByText('Render every block')).toBeInTheDocument();
    expect(screen.getByText('Earlier context was compacted safely.')).toBeInTheDocument();
    expect(screen.getByText('Unsupported future interaction')).toBeInTheDocument();
    expect(screen.getByText('Unsupported ACP update — session/update')).toBeInTheDocument();
  });

  it('routes permission, elicitation, and composer actions through the narrow interface', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    render(<ChatPane model={createAcpShowcaseTranscript()} actions={handlers} />);

    await user.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(handlers.respondToPermission).toHaveBeenCalledWith(
      'permission-showcase',
      'once',
    );

    const form = screen.getByRole('form', { name: 'Configure acceptance' });
    await user.clear(within(form).getByLabelText('Name'));
    await user.type(within(form).getByLabelText('Name'), 'Weave');
    await user.click(within(form).getByRole('button', { name: 'Submit' }));
    expect(handlers.respondToElicitation).toHaveBeenCalledWith(
      'form-showcase',
      expect.objectContaining({
        action: 'accept',
        content: expect.objectContaining({ name: 'Weave' }),
      }),
    );

    const composer = screen.getByRole('textbox', { name: 'Message agent' });
    await user.type(composer, 'Run the complete acceptance test');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(handlers.sendPrompt).toHaveBeenCalledWith(
      'Run the complete acceptance test',
    );
  });

  it('grows the composer from two rows to a maximum of eight after multiline input', async () => {
    const user = userEvent.setup();
    render(<ChatPane model={createAcpShowcaseTranscript()} actions={actions()} />);

    const composer = screen.getByRole('textbox', { name: 'Message agent' });
    expect(composer).toHaveAttribute('rows', '2');

    await user.type(composer, 'First line{Shift>}{Enter}{/Shift}Second line');
    expect(composer).toHaveAttribute('rows', '3');

    fireEvent.change(composer, {
      target: { value: Array.from({ length: 12 }, (_, index) => `Line ${index}`).join('\n') },
    });
    expect(composer).toHaveAttribute('rows', '8');
  });

  it('places circular context usage before Send and preserves the empty bottom rail', () => {
    const { container } = render(
      <ChatPane model={createAcpShowcaseTranscript()} actions={actions()} />,
    );

    const context = screen.getByRole('progressbar', { name: 'Context usage' });
    const send = screen.getByRole('button', { name: 'Send message' });
    expect(context).toHaveAttribute('aria-valuenow', '12.5');
    expect(context.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(screen.queryByText('4,096 / 32,768')).not.toBeInTheDocument();
    expect(screen.queryByText('$0.42')).not.toBeInTheDocument();

    expect(container.querySelector('[data-slot="main-bottom-rail"]')).toHaveClass(
      'h-[var(--bottom-rail-height)]',
      'shrink-0',
    );
  });

  it('uses a flat full-width composer with quiet controls', () => {
    const { container } = render(
      <ChatPane model={createAcpShowcaseTranscript()} actions={actions()} />,
    );

    expect(container.querySelector('[data-slot="chat-pane"]'))
      .toHaveClass('bg-chat-background');

    const composer = screen.getByRole('form', { name: 'Message composer' });
    expect(composer).toHaveClass('w-full', 'bg-composer-background');
    expect(composer).not.toHaveClass('max-w-4xl', 'rounded-lg', 'border', 'shadow-sm');

    expect(screen.getByRole('textbox', { name: 'Message agent' }))
      .toHaveAttribute('data-variant', 'frameless');

    expect(screen.getByText('code')).toHaveClass('text-xs/relaxed');
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveClass('text-xs/relaxed');
    expect(screen.getByText('Fast mode').closest('label')).toHaveClass('text-xs/relaxed');

    const controls = container.querySelector('[data-slot="composer-controls"]');
    expect(controls).not.toHaveClass('border-t');
    expect(container.querySelectorAll('[data-slot="select-trigger"][data-variant="ghost"]'))
      .toHaveLength(1);
    expect(screen.queryByText('1 command')).not.toBeInTheDocument();
  });

  it('uses a paper plane with a mauve enabled state for Send', async () => {
    const user = userEvent.setup();
    render(<ChatPane model={createAcpShowcaseTranscript()} actions={actions()} />);

    const send = screen.getByRole('button', { name: 'Send message' });
    expect(send).toBeDisabled();
    expect(send).toHaveClass('text-primary', 'disabled:text-icon-muted');
    expect(send.querySelector('[data-symbol="paper-plane"]')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Message agent' }), 'Hello');
    expect(send).toBeEnabled();
  });
});
