import { describe, expect, it } from 'vitest';
import { createTranscript, reduceAcpEvent } from '@/chat/acp-transcript';
import type { OpenedSession } from './connection';
import { JournalFollower, type JournalReading, reopenedText, transcriptEvents } from './journal';
import type { SessionEvent, SessionEventNotification, TurnOrigin } from './protocol';

const opened = (journal: string, head: number, replay?: OpenedSession['replay']) =>
  ({ state: { journal: { id: journal, head } }, replay }) as unknown as OpenedSession;

const event = (seq: number, body: SessionEvent, sessionId = 's-1'): SessionEventNotification =>
  ({ sessionId, seq, at: 0, event: body });

describe('JournalFollower', () => {
  it('handles each event once and knows which are history', () => {
    const follower = new JournalFollower();
    expect(follower.replaying).toBe(false);
    expect(follower.opened(opened('j-1', 2, { from: 1, reset: true }))).toEqual({ reset: true });
    expect(follower.replaying).toBe(true);
    const first = event(1, { kind: 'notice', text: 'a' });
    expect(follower.accept(first)).toBe(true);
    expect(follower.isHistory(first)).toBe(true);
    expect(follower.accept(first)).toBe(false);
    expect(follower.replaying).toBe(true);
    expect(follower.accept(event(2, { kind: 'notice', text: 'b' }))).toBe(true);
    expect(follower.replaying).toBe(false);
    const live = event(3, { kind: 'notice', text: 'c' });
    expect(follower.accept(live)).toBe(true);
    expect(follower.isHistory(live)).toBe(false);
    expect(follower.position).toEqual({ journal: 'j-1', seq: 3 });
  });

  it('starts over when the Host replays another journal', () => {
    const follower = new JournalFollower();
    follower.opened(opened('j-1', 1, { from: 1, reset: true }));
    follower.accept(event(1, { kind: 'notice', text: 'a' }));
    expect(follower.opened(opened('j-1', 1, { from: 2, reset: false }))).toEqual({ reset: false });
    // Nothing missed: no replay to wait for.
    expect(follower.replaying).toBe(false);
    expect(follower.opened(opened('j-1', 4, { from: 2, reset: false }))).toEqual({ reset: false });
    expect(follower.replaying).toBe(true);
    expect(follower.opened(opened('j-2', 1, { from: 1, reset: true }))).toEqual({ reset: true });
    expect(follower.accept(event(1, { kind: 'notice', text: 'again' }))).toBe(true);
  });
});

const live: JournalReading = { history: false, own: (origin) => 'client' in origin && origin.client.id === 'c2' };
const replayed: JournalReading = { ...live, history: true };

describe('transcriptEvents', () => {
  it('shows prompts as the user\'s messages, one per turn, with where others came from', () => {
    const events = [
      event(1, { kind: 'turnStarted', sessionId: 's-1', prompt: [{ type: 'text', text: 'First' }], origin: { client: { name: 'weave-ios', id: 'c1', device: "Jaco's iPad" } } }),
      event(2, { kind: 'update', notification: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } } } }),
      event(3, { kind: 'turnSteered', sessionId: 's-1', prompt: [{ type: 'text', text: 'Also this' }], origin: { client: { name: 'weave-app', id: 'c2' } } }),
      event(4, { kind: 'turnEnded', sessionId: 's-1', response: { stopReason: 'end_turn' } }),
    ];
    const transcript = events.flatMap((notification) => transcriptEvents(notification, live)).reduce(reduceAcpEvent, createTranscript('s-1'));
    expect(transcript.entries.map((entry) => entry.kind === 'message' ? [entry.role, entry.origin, entry.steer] : entry.kind)).toEqual([
      ['user', "Jaco's iPad", undefined],
      ['assistant', undefined, undefined],
      ['user', undefined, true],
    ]);
    expect(transcript.turn.status).toBe('stopped');
  });

  it('names another session as where a prompt came from, and shows a queued one of its own', () => {
    const events = [
      event(1, { kind: 'turnStarted', sessionId: 's-1', prompt: [{ type: 'text', text: 'Port the tests' }], origin: { session: { sessionId: 's-0' } } }),
      event(2, { kind: 'turnEnded', sessionId: 's-1', response: { stopReason: 'end_turn' } }),
      event(3, { kind: 'turnStarted', sessionId: 's-1', prompt: [{ type: 'text', text: 'Queued here' }], origin: { client: { name: 'weave-app', id: 'c2' } }, queuedId: 'q-1' }),
    ];
    const transcript = events.flatMap((notification) => transcriptEvents(notification, live)).reduce(reduceAcpEvent, createTranscript('s-1'));
    expect(transcript.entries.map((entry) => entry.kind === 'message' ? [entry.role, entry.origin ?? null] : entry.kind)).toEqual([
      ['user', 'another thread'],
      ['user', null],
    ]);
  });

  it('changes no turn state for history', () => {
    const started = event(1, { kind: 'turnStarted', sessionId: 's-1', prompt: [{ type: 'text', text: 'First' }], origin: { run: {} } });
    expect(transcriptEvents(started, replayed).map(({ type }) => type)).toEqual(['prompt']);
    expect(transcriptEvents(started, live).map(({ type }) => type)).toEqual(['prompt', 'turn/started']);
    const ended = event(2, { kind: 'turnEnded', sessionId: 's-1', response: { stopReason: 'cancelled' } });
    expect(transcriptEvents(ended, replayed)).toEqual([{ type: 'turn/ended', sessionId: 's-1', stopReason: 'cancelled' }]);
    expect(transcriptEvents(ended, live).map(({ type }) => type)).toEqual(['turn/ended', 'turn/stopped']);
  });

  it('says why a turn failed', () => {
    const failed = event(1, { kind: 'turnEnded', sessionId: 's-1', error: { code: -32603, message: 'The agent crashed' } });
    const transcript = transcriptEvents(failed, live).reduce(reduceAcpEvent, createTranscript('s-1'));
    expect(transcript.entries).toMatchObject([{ kind: 'diagnostic', severity: 'error', title: 'Turn failed', detail: 'The agent crashed' }]);
    expect(transcript.turn).toEqual({ status: 'failed', error: 'The agent crashed' });
  });

  it('routes subagent updates to their session and skips unknown kinds', () => {
    expect(transcriptEvents(event(1, { kind: 'update', notification: { sessionId: 'child', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } } } }), live))
      .toEqual([{ type: 'session/update', sessionId: 'child', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } } }]);
    expect(transcriptEvents(event(2, { kind: 'somethingNew' } as unknown as SessionEvent), live)).toEqual([]);
  });

  it('says who renamed the session, and titles it', () => {
    const renamed = (by?: TurnOrigin) => transcriptEvents(event(1, { kind: 'renamed', title: 'Parser fixes', ...(by ? { by } : {}) }), live);
    expect(renamed()).toEqual([{ type: 'session/renamed', title: 'Parser fixes', by: 'The agent' }]);
    expect(renamed({ client: { name: 'weave-app', id: 'c2' } })[0]).toMatchObject({ by: 'You' });
    expect(renamed({ client: { name: 'weave-tui', id: 'c7' } })[0]).toMatchObject({ by: 'The TUI' });
    expect(renamed({ client: { name: 'weave-app', id: 'c8', device: "Jaco's iPhone" } })[0]).toMatchObject({ by: "Jaco's iPhone" });
    const shown = renamed().reduce(reduceAcpEvent, createTranscript('s-1'));
    expect(shown.title).toBe('Parser fixes');
    expect(shown.entries).toMatchObject([{ kind: 'diagnostic', severity: 'info', title: 'The agent renamed this thread to “Parser fixes”' }]);
  });

  it('shows the Host\'s notices', () => {
    expect(transcriptEvents(event(1, { kind: 'notice', text: 'Client tools are unavailable with this agent.' }), live))
      .toEqual([{ type: 'notice', severity: 'info', title: 'Client tools are unavailable with this agent.' }]);
  });
});

describe('reopenedText', () => {
  it('says what the session runs now, as the TUI does', () => {
    const release = { name: '@zed-industries/claude-code-acp', version: '0.7.0' };
    expect(reopenedText(release, { name: release.name, version: '0.6.1' })).toBe('Moved this thread to claude-code-acp 0.7.0, from 0.6.1');
    expect(reopenedText(release)).toBe('Reopened this thread on claude-code-acp 0.7.0');
    expect(reopenedText(release, undefined, "0.7.1 couldn't take the session up")).toBe("0.7.1 couldn't take the session up; it runs claude-code-acp 0.7.0 again");
    expect(reopenedText()).toBe('Reopened this thread in a new agent process');
  });
});
