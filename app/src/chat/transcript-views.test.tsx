import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PromptImage } from '@/app/app-controller';
import { type AcpTranscriptEvent, createTranscript, reduceAcpEvent, reduceJournalEvent } from './acp-transcript';
import { ChatPane, type ChatPaneActions } from './chat-pane';
import { urlCheck } from './pending-request';
import { scaledSize } from './prompt-images';
import { terminalText } from './terminal-text';

const photo: PromptImage = { mimeType: 'image/jpeg', data: '/9j/AA==', name: 'IMG_0001.jpg' };

vi.mock('./prompt-images', async (original) => ({
  ...await original<typeof import('./prompt-images')>(),
  promptImage: vi.fn(async () => photo),
}));

const actions = (): ChatPaneActions => ({
  send: vi.fn(),
  removeQueued: vi.fn(),
  cancelTurn: vi.fn(),
  respondToPermission: vi.fn(),
  respondToElicitation: vi.fn(),
  setMode: vi.fn(),
  setConfigOption: vi.fn(),
});

const transcript = (...events: AcpTranscriptEvent[]) => events.reduce(reduceAcpEvent, createTranscript('main'));

describe('the transcript', () => {
  it('says where another client\'s prompt came from, and marks steers', () => {
    render(<ChatPane model={transcript(
      { type: 'prompt', prompt: [{ type: 'text', text: 'From the other room' }], origin: "Jaco's iPad" },
      { type: 'prompt', prompt: [{ type: 'text', text: 'And this' }], steer: true, own: true },
    )} actions={actions()} />);
    expect(screen.getByText("From Jaco's iPad")).toBeInTheDocument();
    expect(screen.getByText('Steered into the turn')).toBeInTheDocument();
  });

  it('shows subagents as one-line rows that open their own work', async () => {
    const user = userEvent.setup();
    const openSubagent = vi.fn();
    const model = transcript(
      { type: 'session/update', update: { sessionUpdate: 'subagent_update', sessionId: 'main:robie', title: 'Robie', description: 'Counts files', state: { state: 'running' } } },
      { type: 'session/update', update: { sessionUpdate: 'session_message', messageId: 'm1', senderSessionId: 'main', recipientSessionId: 'main:robie', content: [{ type: 'text', text: 'Count them.' }] } },
      { type: 'session/update', sessionId: 'main:robie', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'There are 12.' } } },
      { type: 'session/update', update: { sessionUpdate: 'subagent_update', sessionId: 'main:robie', state: { state: 'idle', stopReason: 'end_turn' } } },
    );
    render(<ChatPane model={model} actions={actions()} onOpenSubagent={openSubagent} />);
    const rows = screen.getAllByText((_, element) => element?.getAttribute('data-slot') === 'subagent-row');
    // What happened and to whom, without the description, the message or the reply.
    expect(rows.map((row) => row.textContent)).toEqual([
      'SpawnedRobie',
      'Sent input toRobie',
      'CompletedRobie',
    ]);
    await user.click(within(rows[2]).getByRole('button', { name: "Show Robie's work" }));
    expect(openSubagent).toHaveBeenCalledWith('main:robie');
  });

  it('shows a subagent\'s messages from its parent in its own transcript', () => {
    const model = transcript(
      { type: 'session/update', update: { sessionUpdate: 'subagent_update', sessionId: 'main:ada', title: 'Ada' } },
      { type: 'session/update', sessionId: 'main:ada', update: { sessionUpdate: 'session_message', messageId: 'task', senderSessionId: 'main', recipientSessionId: 'main:ada', content: [{ type: 'text', text: 'Review it.' }] } },
    );
    render(<ChatPane model={model.subagents[0].transcript} root={model} readOnly actions={actions()} />);
    expect(screen.getByText('From')).toBeInTheDocument();
    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message agent' })).not.toBeInTheDocument();
  });

  it('shows a command\'s output as text in its tool call once opened, and how it ended, but not its raw data', async () => {
    const user = userEvent.setup();
    render(<ChatPane model={transcript(
      {
        type: 'session/update',
        update: {
          sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run make', kind: 'execute', status: 'failed',
          content: [{ type: 'terminal', terminalId: 'term-1' }], rawInput: { command: 'make' }, rawOutput: { exitCode: 2 },
        },
      },
      { type: 'terminal/output', terminalId: 'term-1', data: '\u001b[31merror\u001b[0m: it broke\r\n' },
      { type: 'terminal/exit', terminalId: 'term-1', status: { exitCode: 2 } },
    )} actions={actions()} />);
    // A lone call is a run of its own; it and the call are closed, even failed, until tapped.
    expect(screen.queryByLabelText('Terminal output')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Worked/ }));
    expect(screen.queryByLabelText('Terminal output')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Run make/ }));
    expect(screen.getByLabelText('Terminal output')).toHaveTextContent(/^error: it broke$/);
    expect(screen.getByText('Exited with code 2')).toBeInTheDocument();
    expect(screen.queryByText('Raw tool data')).not.toBeInTheDocument();
  });

  it('says how a turn ended when it didn\'t finish', () => {
    render(<ChatPane model={transcript({ type: 'turn/ended', stopReason: 'max_tokens' })} actions={actions()} />);
    expect(screen.getByText('Stopped: the agent reached its token limit')).toBeInTheDocument();
  });
});

const permission = (toolCallId: string) => ({
  sessionId: 'main',
  toolCall: { toolCallId, title: `Write ${toolCallId}.txt` },
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' as const },
  ],
});

const form = { mode: 'form' as const, sessionId: 'main', message: 'Who are you?', requestedSchema: { type: 'object' as const, required: ['name'], properties: { name: { type: 'string' as const, title: 'Name' } } } };

describe('runs of work', () => {
  const call = (toolCallId: string, kind: 'execute' | 'edit' = 'execute', status: 'completed' | 'failed' | 'in_progress' = 'completed'): AcpTranscriptEvent =>
    ({ type: 'session/update', update: { sessionUpdate: 'tool_call', toolCallId, title: `Step ${toolCallId}`, kind, status } });
  const said = (text: string): AcpTranscriptEvent =>
    ({ type: 'session/update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });

  it('folds tool calls in a row into one row, which opens to them', async () => {
    const user = userEvent.setup();
    render(<ChatPane model={transcript(call('a'), call('b', 'execute', 'failed'), call('c', 'edit'), said('All done.'))} actions={actions()} />);
    const run = screen.getByRole('button', { name: /^Worked/ });
    expect(run).toHaveTextContent('Worked2 commands, 1 edit1 failed');
    expect(screen.queryByText('Step a')).not.toBeInTheDocument();
    expect(screen.getByText('All done.')).toBeInTheDocument();
    await user.click(run);
    expect(screen.getAllByText(/^Step [abc]$/).map((step) => step.textContent)).toEqual(['Step a', 'Step b', 'Step c']);
  });

  it('says how long the work took, from the journal\'s times', () => {
    const journal: [AcpTranscriptEvent, number][] = [
      [{ type: 'prompt', prompt: [{ type: 'text', text: 'Go' }] }, 1_000],
      [call('a'), 4_000],
      [call('b'), 90_000],
      [{ type: 'session/update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'completed' } }, 138_000],
      [said('Done.'), 139_000],
    ];
    const model = journal.reduce((transcript, [event, at]) => reduceJournalEvent(transcript, event, at), createTranscript('main'));
    render(<ChatPane model={model} actions={actions()} />);
    expect(screen.getByRole('button', { name: /^Worked/ })).toHaveTextContent('Worked for 2m 17s2 commands');
  });

  it('counts how long it has been working', () => {
    const model = reduceJournalEvent(
      reduceJournalEvent(createTranscript('main'), { type: 'prompt', prompt: [{ type: 'text', text: 'Go' }] }, Date.now() - 65_000),
      { type: 'turn/started' },
      Date.now() - 65_000,
    );
    render(<ChatPane model={model} actions={actions()} />);
    expect(screen.getByRole('button', { name: /^Working/ })).toHaveTextContent('Working1m 5s');
  });

  it('is the running turn\'s activity, with the step it\'s on, and never hides a request', async () => {
    const handlers = actions();
    const user = userEvent.setup();
    const { rerender } = render(<ChatPane model={transcript({ type: 'prompt', prompt: [{ type: 'text', text: 'Go' }], own: true }, { type: 'turn/started' })} actions={handlers} />);
    expect(screen.getByRole('button', { name: /^Working/ })).toBeDisabled();

    rerender(<ChatPane model={transcript(
      { type: 'prompt', prompt: [{ type: 'text', text: 'Go' }], own: true },
      { type: 'turn/started' },
      call('a'),
      call('b', 'execute', 'in_progress'),
      { type: 'permission/requested', requestId: 'p-1', request: permission('b') },
    )} actions={handlers} />);
    expect(screen.getByRole('button', { name: /^Working/ })).toHaveTextContent('WorkingWrite b.txt');
    expect(screen.queryByText('Step a')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(handlers.respondToPermission).toHaveBeenCalledWith('p-1', 'allow');
  });
});

describe('pending requests', () => {
  it('says how each permission request ended', async () => {
    const user = userEvent.setup();
    render(<ChatPane model={transcript(
      { type: 'permission/requested', requestId: 'p-1', request: permission('a') },
      { type: 'permission/resolved', requestId: 'p-1', optionId: 'allow' },
      { type: 'permission/requested', requestId: 'p-2', request: permission('b') },
      { type: 'request/resolved', requestId: 'p-2', status: 'elsewhere' },
      { type: 'permission/requested', requestId: 'p-3', request: permission('c') },
      { type: 'request/resolved', requestId: 'p-3', status: 'withdrawn' },
      { type: 'permission/requested', requestId: 'p-4', request: permission('d') },
      { type: 'request/resolved', requestId: 'p-4', status: 'cancelled' },
    )} actions={actions()} />);
    // Four tool calls in a row are one run of work.
    await user.click(screen.getByRole('button', { name: /^Worked/ }));
    expect(screen.getByText('You chose Allow')).toBeInTheDocument();
    expect(screen.getByText('Answered on another client')).toBeInTheDocument();
    expect(screen.getByText('The agent withdrew its request')).toBeInTheDocument();
    expect(screen.getByText('The turn ended before it was answered')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });

  it('declines or cancels a form, and keeps it read-only once answered', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const { rerender } = render(<ChatPane model={transcript({ type: 'elicitation/requested', requestId: 'e-1', request: form })} actions={handlers} />);
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(handlers.respondToElicitation).toHaveBeenCalledWith('e-1', { action: 'decline' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(handlers.respondToElicitation).toHaveBeenCalledWith('e-1', { action: 'cancel' });

    rerender(<ChatPane model={transcript(
      { type: 'elicitation/requested', requestId: 'e-1', request: form },
      { type: 'elicitation/resolved', requestId: 'e-1', response: { action: 'accept', content: { name: 'Ada' } } },
    )} actions={handlers} />);
    expect(screen.getByText('You sent your answers')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
  });

  it('warns about a URL elicitation\'s page, and opens only web pages', () => {
    expect(urlCheck('https://example.com/a')).toEqual({ host: 'example.com', warnings: [] });
    expect(urlCheck('http://user:pw@10.0.0.1/a').warnings).toEqual([
      'Not encrypted: uses http.',
      'The host is a bare IP address.',
      'The URL embeds credentials before the host.',
    ]);
    expect(urlCheck('https://exаmple.com/').warnings).toEqual(['The host uses Punycode; it may imitate another site.']);
    expect(urlCheck('javascript:alert(1)')).toEqual({ warnings: ['Only web pages open from here; this uses javascript.'] });
    expect(urlCheck('not a url')).toEqual({ warnings: ['This is not a valid URL.'] });

    render(<ChatPane model={transcript({
      type: 'elicitation/requested',
      requestId: 'e-1',
      request: { mode: 'url', sessionId: 'main', elicitationId: 'x', url: 'weave://pair?code=1', message: 'Pair' },
    })} actions={actions()} />);
    expect(screen.getByText('weave://pair?code=1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in browser' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
  });

  it('shows a client tool call another client runs, with nothing to answer', () => {
    const { rerender } = render(<ChatPane model={transcript(
      { type: 'clientTool/requested', requestId: 'c-1', tool: 'clipboard_write', runner: 'the TUI' },
    )} actions={actions()} />);
    const row = screen.getByText('Waiting for the TUI to run clipboard_write').parentElement!;
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
    rerender(<ChatPane model={transcript(
      { type: 'clientTool/requested', requestId: 'c-1', tool: 'clipboard_write', runner: 'the TUI' },
      { type: 'request/resolved', requestId: 'c-1', status: 'elsewhere' },
    )} actions={actions()} />);
    expect(screen.getByText('The TUI ran clipboard_write')).toBeInTheDocument();
  });
});

describe('the composer', () => {
  it('offers the agent\'s commands for a draft starting with /', async () => {
    const user = userEvent.setup();
    render(<ChatPane model={transcript({ type: 'session/update', update: { sessionUpdate: 'available_commands_update', availableCommands: [
      { name: 'plan', description: 'Make a plan' },
      { name: 'review', description: 'Review the change' },
    ] } })} actions={actions()} />);
    const composer = screen.getByRole('textbox', { name: 'Message agent' });
    await user.type(composer, '/pl');
    const commands = screen.getByRole('list', { name: 'Agent commands' });
    expect(within(commands).getAllByRole('button').map((button) => button.textContent)).toEqual(['/planMake a plan']);
    await user.click(within(commands).getByRole('button', { name: /\/plan/ }));
    expect(composer).toHaveValue('/plan ');
    expect(screen.queryByRole('list', { name: 'Agent commands' })).not.toBeInTheDocument();
  });

  it('attaches photos only for an agent that takes images, and sends them with the message', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const { rerender } = render(<ChatPane model={createTranscript('s')} actions={handlers} />);
    expect(screen.queryByRole('button', { name: 'Attach photos' })).not.toBeInTheDocument();
    rerender(<ChatPane model={createTranscript('s')} actions={handlers} canAttachImages />);
    await user.upload(screen.getByLabelText('Photos to attach'), new File(['x'], 'IMG_0001.HEIC', { type: 'image/heic' }));
    expect(within(screen.getByRole('list', { name: 'Attached photos' })).getByRole('img', { name: 'IMG_0001.jpg' })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Message agent' }), 'What is this?');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(handlers.send).toHaveBeenCalledWith('What is this?', [photo]);
    expect(screen.queryByRole('list', { name: 'Attached photos' })).not.toBeInTheDocument();
  });

  it('shows a steer on its way, which can\'t be removed', () => {
    render(<ChatPane model={createTranscript('s')} actions={actions()} queued={[
      { id: 'a', text: 'Steer this', steering: true },
      { id: 'b', text: 'Then this' },
    ]} />);
    const queued = screen.getByRole('list', { name: 'Queued messages' });
    expect(within(queued).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['SteeringSteer this', 'QueuedThen this']);
    expect(within(queued).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Remove queued message: Then this']);
  });
});

describe('terminal text', () => {
  it('drops escape sequences and keeps what carriage returns leave', () => {
    expect(terminalText('\u001b]0;title\u0007\u001b[1;32mok\u001b[0m\n10%\r55%\r100%\nab\rX\n')).toBe('ok\n100%\nXb\n');
  });
});

describe('photos for a prompt', () => {
  it('scale down to fit, and never up', () => {
    expect(scaledSize(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(scaledSize(800, 600)).toEqual({ width: 800, height: 600 });
  });
});
