import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ElicitationSchema } from '@agentclientprotocol/sdk';
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

  it('resolves URL elicitation when the user consents to open the external flow', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    render(<ChatPane model={createAcpShowcaseTranscript()} actions={handlers} />);

    const open = screen.getByRole('button', { name: /Open/ });
    open.addEventListener('click', (event) => event.preventDefault());
    await user.click(open);

    expect(handlers.respondToElicitation).toHaveBeenCalledWith(
      'url-showcase',
      { action: 'accept' },
    );
  });

  it('does not submit form elicitation values that violate the requested ACP schema', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const model = createAcpShowcaseTranscript();
    const elicitation = model.entries.find((entry) => (
      entry.kind === 'elicitation' && entry.request.mode === 'form'
    ));
    if (!elicitation || elicitation.kind !== 'elicitation' || elicitation.request.mode !== 'form') {
      throw new Error('The showcase form elicitation is missing.');
    }
    const schema = elicitation.request.requestedSchema as ElicitationSchema;
    schema.properties = {
      ...schema.properties,
      name: { type: 'string', title: 'Name', minLength: 3 },
      retries: { type: 'integer', title: 'Retries', minimum: 1, maximum: 3, default: 2 },
      tags: {
        type: 'array',
        title: 'Tags',
        minItems: 2,
        items: { type: 'string', enum: ['ui', 'protocol'] },
        default: ['ui'],
      },
    };

    render(<ChatPane model={model} actions={handlers} />);
    const form = screen.getByRole('form', { name: 'Configure acceptance' });
    await user.clear(within(form).getByLabelText('Name'));
    await user.type(within(form).getByLabelText('Name'), 'x');
    await user.clear(within(form).getByLabelText('Retries'));
    await user.type(within(form).getByLabelText('Retries'), '9');
    fireEvent.submit(form);

    expect(handlers.respondToElicitation).not.toHaveBeenCalledWith(
      'form-showcase',
      expect.objectContaining({ action: 'accept' }),
    );
    expect(screen.getByText('Name must be at least 3 characters.')).toBeVisible();
    expect(screen.getByText('Retries must be at most 3.')).toBeVisible();
    expect(screen.getByText('Select at least 2 Tags options.')).toBeVisible();
  });

  it('omits optional ACP form properties that have no declared value or default', () => {
    const handlers = actions();
    const model = createAcpShowcaseTranscript();
    const elicitation = model.entries.find((entry) => (
      entry.kind === 'elicitation' && entry.request.mode === 'form'
    ));
    if (!elicitation || elicitation.kind !== 'elicitation' || elicitation.request.mode !== 'form') {
      throw new Error('The showcase form elicitation is missing.');
    }
    const schema = elicitation.request.requestedSchema as ElicitationSchema;
    schema.properties = {
      ...schema.properties,
      optionalRetries: {
        type: 'integer',
        title: 'Optional retries',
        minimum: 1,
      },
    };

    render(<ChatPane model={model} actions={handlers} />);
    fireEvent.submit(screen.getByRole('form', { name: 'Configure acceptance' }));

    expect(Array.from(document.querySelectorAll('[data-slot="field-error"]'))
      .map((element) => element.textContent)).toEqual([]);
    expect(handlers.respondToElicitation).toHaveBeenCalledWith(
      'form-showcase',
      expect.objectContaining({
        action: 'accept',
        content: expect.not.objectContaining({ optionalRetries: expect.anything() }),
      }),
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
    expect(container.querySelector('[data-slot="main-bottom-rail"]'))
      .not.toHaveClass('hidden', 'sm:block');
  });

  it('uses a flat full-width composer with quiet controls', () => {
    const { container } = render(
      <ChatPane model={createAcpShowcaseTranscript()} actions={actions()} />,
    );

    expect(container.querySelector('[data-slot="chat-pane"]'))
      .toHaveClass('bg-chat-background');

    const composer = screen.getByRole('form', { name: 'Message composer' });
    expect(composer).toHaveClass(
      'w-full',
      'bg-composer-background',
    );
    expect(composer).not.toHaveClass(
      'max-w-4xl',
      'rounded-lg',
      'border',
      'shadow-sm',
      'pb-[env(safe-area-inset-bottom)]',
      'focus-within:pb-0',
      'sm:pb-0',
    );

    expect(screen.getByRole('textbox', { name: 'Message agent' }))
      .toHaveAttribute('data-variant', 'frameless');
    expect(composer.querySelector(':scope > [data-slot="field-group"]')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message agent' })
      .closest('[data-slot="field"]')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message agent' }))
      .toHaveClass('text-xs/relaxed');
    expect(screen.getByRole('textbox', { name: 'Message agent' }))
      .not.toHaveClass('text-base');

    expect(screen.getByText('code')).toHaveClass('text-xs/relaxed');
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveClass('text-xs/relaxed');
    expect(screen.getByText('Fast mode').closest('label')).toHaveClass('text-xs/relaxed');

    const controls = container.querySelector('[data-slot="composer-controls"]');
    expect(controls).not.toHaveClass('border-t');
    expect(container.querySelectorAll('[data-slot="select-trigger"][data-variant="ghost"]'))
      .toHaveLength(1);
    expect(screen.queryByText('1 command')).not.toBeInTheDocument();
  });

  it('uses the shadcn empty state when a Thread has no transcript entries', () => {
    const model = createAcpShowcaseTranscript();
    model.entries = [];

    const { container } = render(<ChatPane model={model} actions={actions()} />);

    expect(container.querySelector('[data-slot="empty"]')).toBeInTheDocument();
    expect(screen.getByText('Start a conversation with the agent.')).toBeVisible();
  });

  it('prefers the modern mode config option over the legacy ACP modes surface', () => {
    const model = createAcpShowcaseTranscript();
    model.configOptions = [
      {
        type: 'select',
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        currentValue: 'code',
        options: [
          { value: 'code', name: 'Code' },
          { value: 'ask', name: 'Ask' },
        ],
      },
      ...model.configOptions,
    ];

    render(<ChatPane model={model} actions={actions()} />);

    expect(screen.queryByRole('combobox', { name: 'Agent mode' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
  });

  it('keeps legacy ACP modes as a fallback when no modern mode option is available', () => {
    const model = createAcpShowcaseTranscript();
    model.availableModes = [
      { id: 'code', name: 'Code' },
      { id: 'ask', name: 'Ask' },
    ];

    render(<ChatPane model={model} actions={actions()} />);

    expect(screen.getByRole('combobox', { name: 'Agent mode' })).toBeInTheDocument();
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

  it('announces an active Agent response without adding visible chat chrome', () => {
    const model = createAcpShowcaseTranscript();
    model.turn = { status: 'running' };

    const { container } = render(<ChatPane model={model} actions={actions()} />);

    expect(container.querySelector('[data-slot="chat-pane"]')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Agent response in progress.');
    expect(screen.getByRole('status')).toHaveClass('sr-only');
  });

  it('wraps config controls while keeping Send aligned in normal flow', () => {
    const { container } = render(
      <ChatPane model={createAcpShowcaseTranscript()} actions={actions()} />,
    );

    expect(container.querySelector('[data-slot="config-controls-scroller"]'))
      .not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="config-controls"]'))
      .toHaveClass('min-w-0', 'flex-1', 'flex-wrap', 'gap-y-1');
    expect(container.querySelector('[data-slot="composer-controls"]'))
      .toHaveClass('flex', 'items-end', 'gap-2');
    expect(container.querySelector('[data-slot="composer-actions"]'))
      .toHaveClass('flex', 'shrink-0', 'items-center');
    expect(container.querySelector('[data-slot="composer-actions"]'))
      .not.toHaveClass('absolute', 'right-14', 'sm:right-3', 'top-0');
  });

  it('releases the iPhone composer after sending so the transcript can return to the viewport origin', async () => {
    const user = userEvent.setup();
    const matchMedia = vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
    } as MediaQueryList);
    render(<ChatPane model={createAcpShowcaseTranscript()} actions={actions()} />);

    const composer = screen.getByRole('textbox', { name: 'Message agent' });
    await user.type(composer, 'Hello from iOS');
    expect(composer).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(composer).not.toHaveFocus();

    matchMedia.mockRestore();
  });
});
