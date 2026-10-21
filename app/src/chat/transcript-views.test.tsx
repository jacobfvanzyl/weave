import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PromptImage } from '@/app/app-controller';
import { type AcpTranscriptEvent, createTranscript, reduceAcpEvent } from './acp-transcript';
import { ChatPane, type ChatPaneActions } from './chat-pane';
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

  it('shows subagents as rows that open their own work', async () => {
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
    expect(rows.map((row) => row.textContent)).toEqual([
      '•SpawnedRobieCounts files',
      '•Sent input toRobieCount them.',
      '•CompletedRobieThere are 12.',
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

  it('shows a command\'s output as text in its tool call, and how it ended', () => {
    render(<ChatPane model={transcript(
      { type: 'session/update', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run make', kind: 'execute', status: 'in_progress', content: [{ type: 'terminal', terminalId: 'term-1' }] } },
      { type: 'terminal/output', terminalId: 'term-1', data: '\u001b[31merror\u001b[0m: it broke\r\n' },
      { type: 'terminal/exit', terminalId: 'term-1', status: { exitCode: 2 } },
    )} actions={actions()} />);
    expect(screen.getByLabelText('Terminal output')).toHaveTextContent(/^error: it broke$/);
    expect(screen.getByText('Exited with code 2')).toBeInTheDocument();
  });

  it('says how a turn ended when it didn\'t finish', () => {
    render(<ChatPane model={transcript({ type: 'turn/ended', stopReason: 'max_tokens' })} actions={actions()} />);
    expect(screen.getByText('Stopped: the agent reached its token limit')).toBeInTheDocument();
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
