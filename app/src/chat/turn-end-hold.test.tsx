// As a turn ends and folds, its prompt comes back to the top of the view (WVE-235). The scroller's
// own tests hold it there; these check the pane asks for it when it should.
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AcpTranscriptEvent, createTranscript, reduceAcpEvent } from './acp-transcript';
import { ChatPane, type ChatPaneActions } from './chat-pane';

const anchorMessage = vi.fn((_messageId: string) => true);

vi.mock('@/lib/message-scroller', async (original) => {
  const actual = await original<typeof import('@/lib/message-scroller')>();
  return {
    ...actual,
    useMessageScroller: () => ({ ...actual.useMessageScroller(), anchorMessage }),
  };
});

const actions = (): ChatPaneActions => ({
  send: vi.fn(),
  removeQueued: vi.fn(),
  cancelTurn: vi.fn(),
  respondToPermission: vi.fn(),
  respondToElicitation: vi.fn(),
  setMode: vi.fn(),
  setConfigOption: vi.fn(),
});

const play = (...events: AcpTranscriptEvent[]) => events.reduce(reduceAcpEvent, createTranscript('main'));

const prompted: AcpTranscriptEvent[] = [
  { type: 'prompt', prompt: [{ type: 'text', text: 'Run the tests.' }], own: true },
  { type: 'turn/started' },
  { type: 'session/update', update: { sessionUpdate: 'tool_call', toolCallId: 'run', title: 'Run cargo test', kind: 'execute', status: 'completed' } },
  { type: 'session/update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'They pass.' } } },
];

const promptId = (events: AcpTranscriptEvent[]) => play(...events).entries.find((entry) => entry.kind === 'message' && entry.role === 'user')?.id;

describe('a turn ending in the pane', () => {
  beforeEach(() => anchorMessage.mockClear());

  it('brings its prompt back to the top as it folds', () => {
    const view = render(<ChatPane model={play(...prompted)} actions={actions()} />);
    expect(anchorMessage).not.toHaveBeenCalled();

    const ended = [...prompted, { type: 'turn/ended', stopReason: 'end_turn' }, { type: 'turn/stopped', stopReason: 'end_turn' }] as AcpTranscriptEvent[];
    view.rerender(<ChatPane model={play(...ended)} actions={actions()} />);
    expect(anchorMessage).toHaveBeenCalledTimes(1);
    expect(anchorMessage).toHaveBeenCalledWith(promptId(ended));
  });

  it('leaves a failed turn, which does not fold, where it is', () => {
    const view = render(<ChatPane model={play(...prompted)} actions={actions()} />);
    const failed = [...prompted, { type: 'turn/ended', stopReason: 'end_turn', error: 'The agent exited' }, { type: 'turn/stopped', stopReason: 'end_turn' }] as AcpTranscriptEvent[];
    view.rerender(<ChatPane model={play(...failed)} actions={actions()} />);
    expect(anchorMessage).not.toHaveBeenCalled();
  });

  it('moves nothing for a thread opened after its turn ended', () => {
    const ended = [...prompted, { type: 'turn/ended', stopReason: 'end_turn' }, { type: 'turn/stopped', stopReason: 'end_turn' }] as AcpTranscriptEvent[];
    const view = render(<ChatPane model={play(...ended)} actions={actions()} />);
    view.rerender(<ChatPane model={play(...ended)} actions={actions()} />);
    expect(anchorMessage).not.toHaveBeenCalled();
  });
});
