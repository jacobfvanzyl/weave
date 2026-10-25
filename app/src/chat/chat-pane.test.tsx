import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ElicitationSchema } from '@/host/protocol';
import { Capacitor } from '@capacitor/core';
import { describe, expect, it, vi } from 'vitest';
import { createAcpShowcaseTranscript } from './acp-showcase';
import { createTranscript, formElicitation, reduceAcpEvent } from './acp-transcript';
import { ChatPane, type ChatPaneActions } from './chat-pane';

const actions = (): ChatPaneActions => ({
  send: vi.fn(),
  removeQueued: vi.fn(),
  resumeQueue: vi.fn(),
  cancelTurn: vi.fn(),
  respondToPermission: vi.fn(),
  respondToElicitation: vi.fn(),
  setMode: vi.fn(),
  setConfigOption: vi.fn(),
});

describe('ChatPane', () => {
  it('defers requested focus until the mobile sidebar dialog has closed', async () => {
    const bounds = HTMLElement.prototype.getBoundingClientRect;
    const rectangle = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'dialog' ? new DOMRect(0, 0, 250, 500) : bounds.call(this);
    });
    const model = createTranscript('sidebar-focus');
    const handlers = actions();
    const content = (open: boolean) => <>{open && <div role='dialog'>Sidebar</div>}<ChatPane model={model} actions={handlers} focusRequest={1} /></>;
    try {
      const view = render(content(true));
      const composer = screen.getByRole('textbox', { name: 'Message agent' });
      expect(composer).not.toHaveFocus();
      view.rerender(content(false));
      await waitFor(() => expect(composer).toHaveFocus());
    } finally { rectangle.mockRestore(); }
  });

  it('focuses the composer when a new focus request arrives', () => {
    const model = createTranscript('draft-session');
    const handlers = actions();
    const { rerender } = render(
      <ChatPane model={model} actions={handlers} />,
    );
    const composer = screen.getByRole('textbox', { name: 'Message agent' });
    expect(composer).not.toHaveFocus();

    rerender(
      <ChatPane model={model} actions={handlers} focusRequest={1} />,
    );

    expect(composer).toHaveFocus();
  });

  it('lets user bubbles grow to their responsive cap before wrapping', () => {
    render(<ChatPane model={createAcpShowcaseTranscript()} actions={actions()} />);

    const userBubble = screen.getByText('Exercise the complete ACP renderer.')
      .closest('[data-slot="bubble"]');
    const userBubbleGroup = userBubble?.closest('[data-slot="bubble-group"]');
    const userBubbleContent = userBubble?.querySelector('[data-slot="bubble-content"]');

    expect(userBubbleGroup).toHaveClass('w-full');
    expect(userBubble).toHaveClass('w-max', 'max-w-[90%]');
    expect(userBubble).not.toHaveClass('w-fit');
    expect(userBubbleContent).toHaveClass('w-max', 'max-w-full');
    expect(userBubbleContent).not.toHaveClass('w-fit');
  });

  it('renders every ACP transcript family without flattening rich payloads', () => {
    const { container } = render(
      <ChatPane model={createAcpShowcaseTranscript()} actions={actions()} />,
    );

    expect(screen.getByText('Exercise the complete ACP renderer.')).toBeInTheDocument();
    expect(screen.getByText('Checking every content family.')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="message-header"]')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ACP rich content' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show pixel.png' })).toBeInTheDocument();
    expect(screen.getByLabelText('Audio content')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ACP specification' })).toHaveAttribute(
      'href',
      'https://agentclientprotocol.com',
    );
    expect(screen.getByText('# Embedded README')).toBeInTheDocument();
    expect(screen.getByText('archive.bin')).toBeInTheDocument();

    // Tool calls open when tapped.
    fireEvent.click(screen.getByRole('button', { name: /Update README/ }));
    expect(screen.getAllByText('/workspace/README.md')).toHaveLength(2);
    expect(screen.getByText('# Old')).toBeInTheDocument();
    expect(screen.getByText('# New')).toBeInTheDocument();
    expect(screen.getByLabelText('Terminal output')).toHaveTextContent(/^ok README updated$/);

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
    expect(handlers.send).toHaveBeenCalledWith(
      'Run the complete acceptance test',
    );
  });

  it('opens a URL elicitation\'s page only when the person says so, showing the whole URL and its host', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<ChatPane model={createAcpShowcaseTranscript()} actions={handlers} />);

    const card = screen.getByText('Authorize in your browser').closest('[data-slot="alert"]') as HTMLElement;
    expect(within(card).getByText('example.com')).toBeInTheDocument();
    expect(within(card).getByText('https://example.com/authorize')).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();

    await user.click(within(card).getByRole('button', { name: 'Open in browser' }));
    expect(open).toHaveBeenCalledWith('https://example.com/authorize', '_blank', 'noopener,noreferrer');
    expect(handlers.respondToElicitation).toHaveBeenCalledWith('url-showcase', { action: 'accept' });
    open.mockRestore();
  });

  it('declines a URL elicitation without opening it', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<ChatPane model={createAcpShowcaseTranscript()} actions={handlers} />);
    const card = screen.getByText('Authorize in your browser').closest('[data-slot="alert"]') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Decline' }));
    expect(handlers.respondToElicitation).toHaveBeenCalledWith('url-showcase', { action: 'decline' });
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('does not submit form elicitation values that violate the requested ACP schema', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const model = createAcpShowcaseTranscript();
    const elicitation = model.entries.find((entry) => (
      entry.kind === 'elicitation' && entry.request.mode === 'form'
    ));
    const request = elicitation?.kind === 'elicitation' ? formElicitation(elicitation.request) : undefined;
    if (!request) throw new Error('The showcase form elicitation is missing.');
    const schema = request.requestedSchema as ElicitationSchema;
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
    const request = elicitation?.kind === 'elicitation' ? formElicitation(elicitation.request) : undefined;
    if (!request) throw new Error('The showcase form elicitation is missing.');
    const schema = request.requestedSchema as ElicitationSchema;
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
    const model = { ...createAcpShowcaseTranscript(), sessionId: 'composer-rows' };
    render(<ChatPane model={model} actions={actions()} />);

    const composer = screen.getByRole('textbox', { name: 'Message agent' });
    expect(composer).toHaveAttribute('rows', '2');

    await user.type(composer, 'First line{Shift>}{Enter}{/Shift}Second line');
    expect(composer).toHaveAttribute('rows', '3');

    fireEvent.change(composer, {
      target: { value: Array.from({ length: 12 }, (_, index) => `Line ${index}`).join('\n') },
    });
    expect(composer).toHaveAttribute('rows', '8');
  });

  it('places circular context usage before Send', () => {
    render(
      <ChatPane model={createAcpShowcaseTranscript()} actions={actions()} />,
    );

    const context = screen.getByRole('progressbar', { name: 'Context usage' });
    const send = screen.getByRole('button', { name: 'Send message' });
    expect(context).toHaveAttribute('aria-valuenow', '12.5');
    expect(context.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(screen.queryByText('4,096 / 32,768')).not.toBeInTheDocument();
    expect(screen.queryByText('$0.42')).not.toBeInTheDocument();

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

    const settings = screen.getByRole('button', {
      name: 'Composer settings: GPT · Fast',
    });
    expect(settings).toHaveClass('text-xs/relaxed');
    expect(settings).toHaveTextContent('GPT · Fast');
    expect(screen.queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Fast mode' })).not.toBeInTheDocument();

    const controls = container.querySelector('[data-slot="composer-controls"]');
    expect(controls).not.toHaveClass('border-t');
    expect(container.querySelectorAll('[data-slot="dropdown-menu-trigger"]'))
      .toHaveLength(1);
    expect(screen.queryByText('1 command')).not.toBeInTheDocument();
  });

  it('shows a spinner rather than a thread whose history is still loading', () => {
    const model = createAcpShowcaseTranscript();
    const { rerender } = render(<ChatPane model={model} actions={actions()} loading />);
    expect(screen.getByRole('status', { name: 'Loading the thread' })).toBeVisible();
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeVisible();

    rerender(<ChatPane model={model} actions={actions()} />);
    expect(screen.queryByRole('status', { name: 'Loading the thread' })).not.toBeInTheDocument();
    expect(screen.getByRole('log')).toBeVisible();
  });

  it('makes prompts that arrive while the thread is open scroll anchors, and none it replays', () => {
    const reply = (text: string, replayed?: boolean) => ({
      type: 'session/update' as const,
      update: { sessionUpdate: 'agent_message_chunk' as const, content: { type: 'text' as const, text } },
      replayed,
    });
    const model = [
      { type: 'prompt' as const, prompt: [{ type: 'text' as const, text: 'From the journal' }], replayed: true },
      reply('First answer.', true),
      { type: 'session/update' as const, update: { sessionUpdate: 'user_message_chunk' as const, content: { type: 'text' as const, text: 'Loaded by the agent' } }, replayed: true },
      reply('Second answer.', true),
      { type: 'prompt' as const, prompt: [{ type: 'text' as const, text: 'Sent just now' }] },
    ].reduce(reduceAcpEvent, createTranscript('s1'));

    render(<ChatPane model={model} actions={actions()} />);

    const anchor = (text: string) => screen.getByText(text).closest('[data-slot="message-scroller-item"]')?.getAttribute('data-scroll-anchor');
    expect(anchor('From the journal')).toBe('false');
    expect(anchor('Loaded by the agent')).toBe('false');
    expect(anchor('Sent just now')).toBe('true');
  });

  it('uses the shadcn empty state when a session has no transcript entries', () => {
    const model = createAcpShowcaseTranscript();
    model.entries = [];

    const { container } = render(<ChatPane model={model} actions={actions()} />);

    expect(container.querySelector('[data-slot="empty"]')).toBeInTheDocument();
    expect(screen.getByText('Start a conversation with the agent.')).toBeVisible();
  });

  it('prefers the modern mode config option over the legacy ACP modes surface', async () => {
    const user = userEvent.setup();
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

    await user.click(screen.getByRole('button', { name: /Composer settings/ }));
    expect(screen.getAllByRole('menuitem', { name: /Mode\s+Code/ })).toHaveLength(1);
  });

  it('keeps legacy ACP modes as a fallback when no modern mode option is available', async () => {
    const user = userEvent.setup();
    const model = createAcpShowcaseTranscript();
    model.availableModes = [
      { id: 'code', name: 'Code' },
      { id: 'ask', name: 'Ask' },
    ];

    render(<ChatPane model={model} actions={actions()} />);

    await user.click(screen.getByRole('button', { name: /Composer settings/ }));
    expect(screen.getByRole('menuitem', { name: /Mode\s+Code/ })).toBeInTheDocument();
  });

  it('routes select and boolean composer settings through one popup', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    render(<ChatPane model={createAcpShowcaseTranscript()} actions={handlers} />);

    await user.click(screen.getByRole('button', {
      name: 'Composer settings: GPT · Fast',
    }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Fast mode' }))
      .toBeChecked();

    await user.click(screen.getByRole('menuitem', { name: /Model\s+GPT/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Claude' }));
    expect(handlers.setConfigOption).toHaveBeenCalledWith('model', 'claude');

    await user.click(screen.getByRole('button', { name: /Composer settings/ }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Fast mode' }));
    expect(handlers.setConfigOption).toHaveBeenCalledWith('fast', false);
  });

  it('uses a paper plane with a mauve enabled state for Send', async () => {
    const user = userEvent.setup();
    const model = { ...createAcpShowcaseTranscript(), sessionId: 'composer-send-style' };
    render(<ChatPane model={model} actions={actions()} />);

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
      .toHaveClass('min-w-0', 'max-w-full');
    expect(container.querySelector('[data-slot="config-controls"]'))
      .not.toHaveClass('flex-wrap', 'gap-y-1');
    expect(container.querySelector('[data-slot="composer-controls"]'))
      .toHaveClass('flex', 'items-end', 'gap-2');
    expect(container.querySelector('[data-slot="composer-actions"]'))
      .toHaveClass('flex', 'shrink-0', 'items-center');
    expect(container.querySelector('[data-slot="composer-actions"]'))
      .not.toHaveClass('absolute', 'right-14', 'sm:right-3', 'top-0');
  });

  it('releases the compact iPad composer after sending so the transcript can return to the viewport origin', async () => {
    const user = userEvent.setup();
    const matchMedia = vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
    } as MediaQueryList);
    const model = { ...createAcpShowcaseTranscript(), sessionId: 'composer-mobile' };
    render(<ChatPane model={model} actions={actions()} />);

    const composer = screen.getByRole('textbox', { name: 'Message agent' });
    await user.type(composer, 'Hello from iOS');
    expect(composer).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(composer).not.toHaveFocus();

    matchMedia.mockRestore();
  });

  it('releases the native iPad composer after sending at tablet widths', async () => {
    const user = userEvent.setup();
    const nativePlatform = vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    const matchMedia = vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
    } as MediaQueryList);
    const model = { ...createAcpShowcaseTranscript(), sessionId: 'composer-native-tablet' };
    render(<ChatPane model={model} actions={actions()} />);

    const composer = screen.getByRole('textbox', { name: 'Message agent' });
    await user.type(composer, 'Hello from iPadOS');
    expect(composer).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(composer).not.toHaveFocus();

    nativePlatform.mockRestore();
    matchMedia.mockRestore();
  });

  it('keeps a separate draft for each session when the active transcript changes', async () => {
    const user = userEvent.setup();
    const first = { ...createAcpShowcaseTranscript(), sessionId: 'draft-first' };
    const second = { ...createAcpShowcaseTranscript(), sessionId: 'draft-second' };
    const view = render(<ChatPane model={first} actions={actions()} />);

    const composer = screen.getByRole('textbox', { name: 'Message agent' });
    await user.type(composer, 'First session draft');

    view.rerender(<ChatPane model={second} actions={actions()} />);
    expect(screen.getByRole('textbox', { name: 'Message agent' })).toHaveValue('');
    await user.type(screen.getByRole('textbox', { name: 'Message agent' }), 'Second session draft');

    view.rerender(<ChatPane model={first} actions={actions()} />);
    expect(screen.getByRole('textbox', { name: 'Message agent' })).toHaveValue('First session draft');
  });

  it('does not replace newly typed text when an earlier send fails', async () => {
    const user = userEvent.setup();
    let rejectSend: ((reason?: unknown) => void) | undefined;
    const handlers = actions();
    handlers.send = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectSend = reject;
    }));
    const model = { ...createAcpShowcaseTranscript(), sessionId: 'send-new-text' };
    render(<ChatPane model={model} actions={handlers} />);

    const composer = screen.getByRole('textbox', { name: 'Message agent' });
    await user.type(composer, 'First attempt');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await user.type(composer, 'Keep this retry');
    await act(async () => rejectSend?.(new Error('offline')));

    expect(composer).toHaveValue('Keep this retry');
  });

  it('does not resurrect a failed prompt after replacement text was typed and cleared', async () => {
    const user = userEvent.setup();
    let rejectSend: ((reason?: unknown) => void) | undefined;
    const handlers = actions();
    handlers.send = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectSend = reject;
    }));
    const model = { ...createAcpShowcaseTranscript(), sessionId: 'send-cleared-replacement' };
    render(<ChatPane model={model} actions={handlers} />);

    const composer = screen.getByRole('textbox', { name: 'Message agent' });
    await user.type(composer, 'First attempt');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await user.type(composer, 'Replacement');
    await user.clear(composer);
    await act(async () => rejectSend?.(new Error('offline')));

    expect(composer).toHaveValue('');
  });

  it('restores a failed prompt to its session after the user switches away', async () => {
    const user = userEvent.setup();
    let rejectSend: ((reason?: unknown) => void) | undefined;
    const handlers = actions();
    handlers.send = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectSend = reject;
    }));
    const first = { ...createAcpShowcaseTranscript(), sessionId: 'send-switch-first' };
    const second = { ...createAcpShowcaseTranscript(), sessionId: 'send-switch-second' };
    const view = render(<ChatPane model={first} actions={handlers} />);

    await user.type(screen.getByRole('textbox', { name: 'Message agent' }), 'Restore here');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    view.rerender(<ChatPane model={second} actions={handlers} />);
    view.rerender(<ChatPane model={first} actions={handlers} />);
    const restoredComposer = screen.getByRole('textbox', { name: 'Message agent' });
    expect(restoredComposer).toHaveValue('');
    await act(async () => rejectSend?.(new Error('offline')));

    expect(restoredComposer).toHaveValue('Restore here');
  });

  it('restores a submitted draft when sending rejects before replacement text is entered', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    handlers.send = vi.fn(() => Promise.reject(new Error('offline')));
    const model = { ...createAcpShowcaseTranscript(), sessionId: 'send-rejected' };
    render(<ChatPane model={model} actions={handlers} />);

    const composer = screen.getByRole('textbox', { name: 'Message agent' });
    await user.type(composer, 'Retry this prompt');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(composer).toHaveValue('Retry this prompt'));
  });

  it('offers Stop beside Send while a turn is running', async () => {
    const user = userEvent.setup();
    const model = createAcpShowcaseTranscript();
    model.turn = { status: 'running' };
    const handlers = actions();
    render(<ChatPane model={model} actions={handlers} />);

    await user.click(screen.getByRole('button', { name: 'Stop the turn' }));

    expect(handlers.cancelTurn).toHaveBeenCalledOnce();
    expect(handlers.send).not.toHaveBeenCalled();
  });

  it('steers the running turn when the agent takes steers', async () => {
    const user = userEvent.setup();
    const model = { ...createAcpShowcaseTranscript(), sessionId: 'steer' };
    model.turn = { status: 'running' };
    const handlers = actions();
    render(<ChatPane model={model} actions={handlers} canSteer />);

    await user.type(screen.getByRole('textbox', { name: 'Message agent' }), 'Also check the iPad build');
    await user.click(screen.getByRole('button', { name: 'Steer the running turn' }));

    expect(handlers.send).toHaveBeenCalledWith('Also check the iPad build');
  });

  it('queues while a turn runs when the agent cannot take steers, and lets a queued message go', async () => {
    const user = userEvent.setup();
    const model = { ...createAcpShowcaseTranscript(), sessionId: 'queue' };
    model.turn = { status: 'running' };
    const handlers = actions();
    render(<ChatPane model={model} actions={handlers} queued={[{ id: 'q1', text: 'Then run the tests' }]} />);

    expect(within(screen.getByRole('list', { name: 'Queued messages' })).getByText('Then run the tests')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove queued message: Then run the tests' }));
    expect(handlers.removeQueued).toHaveBeenCalledWith('q1');

    await user.type(screen.getByRole('textbox', { name: 'Message agent' }), 'And update the docs');
    await user.click(screen.getByRole('button', { name: 'Queue message' }));
    expect(handlers.send).toHaveBeenCalledWith('And update the docs');
  });

  it('says who queued a message elsewhere, and when the queue is paused offers to resume it', async () => {
    const user = userEvent.setup();
    const model = { ...createAcpShowcaseTranscript(), sessionId: 'paused' };
    const handlers = actions();
    render(
      <ChatPane
        model={model}
        actions={handlers}
        queued={[{ id: 'q1', text: 'Fix the parser', origin: 'the TUI' }, { id: 'q2', text: 'Then the docs' }]}
        queuePaused
      />,
    );

    const list = within(screen.getByRole('list', { name: 'Queued messages' }));
    expect(list.getByText('from the TUI')).toBeInTheDocument();
    expect(list.getByText('The queue is paused. Sending a message starts it again.')).toBeInTheDocument();
    await user.click(list.getByRole('button', { name: 'Resume' }));
    expect(handlers.resumeQueue).toHaveBeenCalled();
  });

  it('preserves a manual scroll position while the last response streams', () => {
    const model = createAcpShowcaseTranscript();
    model.turn = { status: 'running' };
    const view = render(<ChatPane model={model} actions={actions()} />);
    const viewport = screen.getByRole('region', { name: 'Messages' });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    viewport.scrollTop = 300;
    fireEvent.wheel(viewport, { deltaY: -100 });

    const updated = structuredClone(model);
    const lastMessage = [...updated.entries].reverse().find((entry) => entry.kind === 'message');
    if (!lastMessage || lastMessage.kind !== 'message') {
      throw new Error('The showcase assistant message is missing.');
    }
    lastMessage.chunks.at(-1)?.content.push({ type: 'text', text: 'Streaming continuation' });
    view.rerender(<ChatPane model={updated} actions={actions()} />);

    expect(viewport.scrollTop).toBe(300);
  });
});
