import { describe, expect, it } from 'vitest';
import { createTranscript, reduceAcpEvent } from '@/chat/acp-transcript';
import type { OpenedSession } from './connection';
import { JournalFollower, transcriptEvents } from './journal';
import type { SessionEvent, SessionEventNotification } from './protocol';

const opened = (journal: string, head: number, replay?: OpenedSession['replay']) =>
  ({ state: { journal: { id: journal, head } }, replay }) as unknown as OpenedSession;

const event = (seq: number, body: SessionEvent, sessionId = 's-1'): SessionEventNotification =>
  ({ sessionId, seq, at: 0, event: body });

describe('JournalFollower', () => {
  it('handles each event once and knows which are history', () => {
    const follower = new JournalFollower();
    expect(follower.opened(opened('j-1', 2, { from: 1, reset: true }))).toEqual({ reset: true });
    const first = event(1, { kind: 'notice', text: 'a' });
    expect(follower.accept(first)).toBe(true);
    expect(follower.isHistory(first)).toBe(true);
    expect(follower.accept(first)).toBe(false);
    expect(follower.accept(event(2, { kind: 'notice', text: 'b' }))).toBe(true);
    const live = event(3, { kind: 'notice', text: 'c' });
    expect(follower.accept(live)).toBe(true);
    expect(follower.isHistory(live)).toBe(false);
    expect(follower.position).toEqual({ journal: 'j-1', seq: 3 });
  });

  it('starts over when the Host replays another journal', () => {
    const follower = new JournalFollower();
    follower.opened(opened('j-1', 1, { from: 1, reset: true }));
    follower.accept(event(1, { kind: 'notice', text: 'a' }));
    expect(follower.opened(opened('j-1', 4, { from: 2, reset: false }))).toEqual({ reset: false });
    expect(follower.opened(opened('j-2', 1, { from: 1, reset: true }))).toEqual({ reset: true });
    expect(follower.accept(event(1, { kind: 'notice', text: 'again' }))).toBe(true);
  });
});

describe('transcriptEvents', () => {
  it('shows prompts as the user\'s messages, one per turn, and turn ends', () => {
    const events = [
      event(1, { kind: 'turnStarted', sessionId: 's-1', prompt: [{ type: 'text', text: 'First' }], origin: { client: { name: 'weave-tui', id: 'c1' } } }),
      event(2, { kind: 'update', notification: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } } } }),
      event(3, { kind: 'turnSteered', sessionId: 's-1', prompt: [{ type: 'text', text: 'Also this' }], origin: { client: { name: 'weave-app', id: 'c2' } } }),
      event(4, { kind: 'turnEnded', sessionId: 's-1', response: { stopReason: 'end_turn' } }),
    ];
    const transcript = events.flatMap(transcriptEvents).reduce(reduceAcpEvent, createTranscript('s-1'));
    const messages = transcript.entries.flatMap((entry) => entry.kind === 'message' ? [`${entry.role}: ${entry.chunks.flatMap((chunk) => chunk.content).map((block) => block.type === 'text' ? block.text : '').join('')}`] : []);
    expect(messages).toEqual(['user: First', 'assistant: Hi', 'user: Also this']);
    expect(transcript.turn.status).toBe('stopped');
  });

  it('leaves subagent sessions and unknown kinds out', () => {
    expect(transcriptEvents(event(1, { kind: 'update', notification: { sessionId: 'child', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } } } }))).toEqual([]);
    expect(transcriptEvents(event(2, { kind: 'somethingNew' } as unknown as SessionEvent))).toEqual([]);
  });

  it('shows the Host\'s notices', () => {
    expect(transcriptEvents(event(1, { kind: 'notice', text: 'Client tools are unavailable with this agent.' })))
      .toEqual([{ type: 'notice', severity: 'info', title: 'Client tools are unavailable with this agent.' }]);
  });
});
