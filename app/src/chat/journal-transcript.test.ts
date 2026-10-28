// Transcripts from journals recorded from a dev Host with the fake agent (`scripts/record-journals.ts`):
// each event kind as the app shows it, and the same transcript whether the journal arrives live or
// replayed.
import { describe, expect, it } from 'vitest';
import type { OpenedSession } from '@/host/connection';
import { JournalFollower, transcriptEvents } from '@/host/journal';
import type { SessionEventNotification, SessionState } from '@/host/protocol';
import {
  type AcpTranscript,
  blocksText,
  createTranscript,
  reduceAcpEvent,
  sessionLabel,
  TERMINAL_KEEP,
  type TranscriptEntry,
} from './acp-transcript';
import { terminalText } from './terminal-text';

type Recording = { name: string; state: SessionState; events: SessionEventNotification[] };

const recordings = Object.fromEntries(
  Object.values(import.meta.glob<Recording>('./fixtures/journals/*.json', { eager: true, import: 'default' }))
    .map((recording) => [recording.name, recording]),
);

/**
 * The transcript a client shows after following the journal: `live` as each event happened, or
 * `replayed` from history after attaching once it was all written.
 */
function follow(recording: Recording, how: 'live' | 'replayed'): AcpTranscript {
  const follower = new JournalFollower();
  const head = how === 'replayed' ? recording.events.at(-1)?.seq ?? 0 : 0;
  const state = { ...recording.state, journal: { ...recording.state.journal, head } };
  follower.opened({ state, replay: { from: 1, reset: true } } as OpenedSession);
  let transcript = reduceAcpEvent(createTranscript(state.sessionId), { type: 'session/loaded', modes: state.modes, configOptions: state.configOptions });
  for (const notification of recording.events) {
    if (!follower.accept(notification)) continue;
    const reading = { history: follower.isHistory(notification), own: () => false };
    transcript = transcriptEvents(notification, reading).reduce(reduceAcpEvent, transcript);
  }
  return transcript;
}

const text = (entry: Extract<TranscriptEntry, { kind: 'message' }>) => entry.chunks
  .map((chunk) => `${chunk.kind === 'thought' ? '(thinking) ' : ''}${chunk.content.map((block) => block.type === 'text' ? block.text : `[${block.type}]`).join('')}`)
  .join(' ');

/** A transcript as lines of text, for reading its snapshot. */
function outline(transcript: AcpTranscript, root = transcript, depth = 0): string[] {
  const indent = '  '.repeat(depth);
  const lines = transcript.entries.flatMap((entry): string[] => {
    switch (entry.kind) {
      case 'message':
        return [`${entry.role}${entry.steer ? ' (steer)' : ''}${entry.origin ? ` (from ${entry.origin})` : ''}: ${text(entry)}`];
      case 'tool': {
        const content = entry.content.map((item) => {
          if (item.type === 'diff') return `  diff ${item.path}: ${item.oldText ?? '(new)'} → ${item.newText}`;
          if (item.type === 'content') return `  ${blocksText([item.content])}`;
          const terminal = root.terminals[item.terminalId];
          return `  terminal ${JSON.stringify(terminalText(terminal?.output ?? ''))} ${JSON.stringify(terminal?.exit ?? null)}`;
        });
        return [`tool ${entry.toolKind} ${entry.status}: ${entry.title}`, ...content];
      }
      case 'plan':
        return [`plan: ${entry.entries?.map(({ content, status }) => `[${status}] ${content}`).join('; ')}`];
      case 'compaction':
        return [`compaction ${entry.status}: ${JSON.stringify(blocksText(entry.summary))}`];
      case 'diagnostic':
        return [`${entry.severity}: ${entry.title}${entry.detail ? ` — ${entry.detail}` : ''}`];
      case 'subagent':
        return [`• ${entry.event} ${sessionLabel(root, entry.subagentId)}${entry.detail ? ` — ${entry.detail}` : ''}`];
      case 'session-message':
        return [`message ${sessionLabel(root, entry.senderSessionId)} → ${sessionLabel(root, entry.recipientSessionId)}: ${blocksText(entry.content)}`];
      case 'elicitation':
        return [`elicitation ${entry.status}`];
      case 'client-tool':
        return [`client tool ${entry.tool} on ${entry.runner} ${entry.status}`];
    }
  });
  const nested = transcript.subagents.flatMap((subagent) => [
    `subagent ${sessionLabel(root, subagent.sessionId)} (${subagent.state ?? 'no state'}):`,
    ...outline(subagent.transcript, root, 1),
  ]);
  return [...lines, ...nested].map((line) => indent + line);
}

/**
 * Everything but the turn's state, which replayed history doesn't change, and which messages
 * were replayed, here and in subagents.
 */
const shown = ({ turn: _turn, entries, subagents, ...rest }: AcpTranscript): unknown => ({
  ...rest,
  entries: entries.map((entry) => {
    if (entry.kind !== 'message') return entry;
    const { replayed: _replayed, ...unmarked } = entry;
    return unmarked;
  }),
  subagents: subagents.map((subagent) => ({ ...subagent, transcript: shown(subagent.transcript) })),
});

describe('transcripts from recorded journals', () => {
  it('records the journals the tests read', () => {
    expect(Object.keys(recordings).sort()).toEqual(
      ['cancel', 'close', 'compact', 'delegate', 'image', 'markdown', 'modes', 'notice', 'plan', 'questions', 'reopen', 'run', 'steer', 'think', 'write'],
    );
  });

  for (const name of Object.keys(recordings).sort()) {
    it(`shows the ${name} journal the same live and replayed`, () => {
      const live = follow(recordings[name], 'live');
      const replayed = follow(recordings[name], 'replayed');
      expect(shown(replayed)).toEqual(shown(live));
      expect(outline(live).join('\n')).toMatchSnapshot();
    });
  }

  it('says where prompts came from, and changes turn state only live', () => {
    const live = follow(recordings.steer, 'live');
    const replayed = follow(recordings.steer, 'replayed');
    expect(live.entries[0]).toMatchObject({ kind: 'message', role: 'user', origin: 'the TUI' });
    expect(live.turn.status).toBe('stopped');
    expect(replayed.turn.status).toBe('idle');
  });

  it('marks the messages it replays, and none that arrive live', () => {
    const messages = (transcript: AcpTranscript) => transcript.entries.filter((entry) => entry.kind === 'message');
    const replayed = messages(follow(recordings.steer, 'replayed'));
    const live = messages(follow(recordings.steer, 'live'));
    expect(replayed.length).toBeGreaterThan(1);
    expect(replayed.every((message) => message.replayed)).toBe(true);
    expect(live.some((message) => message.replayed)).toBe(false);
  });

  it('keeps the latest modes and config options', () => {
    const transcript = follow(recordings.modes, 'replayed');
    expect(transcript.currentModeId).toBe('code');
    expect(transcript.availableCommands.map(({ name }) => name)).toContain('plan');
  });

  it('shows terminal output as text, in the tool call that runs it', () => {
    const transcript = follow(recordings.run, 'live');
    const [terminal] = Object.values(transcript.terminals);
    expect(terminalText(terminal.output)).toBe('green and plain\nline two\nline three\n');
    expect(terminal.exit).toEqual({ exitCode: 3 });
  });

  it('shows subagents\' work in their own transcripts', () => {
    const transcript = follow(recordings.delegate, 'live');
    expect(transcript.subagents.map(({ title, state }) => [title, state])).toEqual([['Robie', 'idle'], ['Ada', 'idle']]);
    expect(transcript.subagents[0].transcript.entries.map(({ kind }) => kind)).toEqual(['session-message', 'tool', 'tool', 'message']);
  });

  it('keeps the end of a terminal\'s output when it writes a lot', () => {
    let transcript = createTranscript('s-1');
    for (let index = 0; index < 40; index += 1) {
      transcript = reduceAcpEvent(transcript, { type: 'terminal/output', terminalId: 't', data: `${index}`.padEnd(10_000, '.') });
    }
    const terminal = transcript.terminals.t;
    expect(terminal.output).toHaveLength(TERMINAL_KEEP);
    expect(terminal.truncated).toBe(true);
    expect(terminal.output.startsWith('39')).toBe(false);
    expect(terminal.output.slice(-10_000).startsWith('39')).toBe(true);
  });

  it('replays a journal of thousands of events quickly', () => {
    const sessionId = 's-long';
    const events: SessionEventNotification[] = [];
    let seq = 0;
    const push = (event: SessionEventNotification['event']) => events.push({ sessionId, seq: ++seq, at: 0, event });
    for (let turn = 0; turn < 200; turn += 1) {
      push({ kind: 'turnStarted', sessionId, prompt: [{ type: 'text', text: `Turn ${turn}` }], origin: { run: {} } });
      for (let chunk = 0; chunk < 40; chunk += 1) {
        push({ kind: 'update', notification: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `word${chunk} ` } } } });
      }
      push({ kind: 'update', notification: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: `tool-${turn}`, title: 'Read', kind: 'read', status: 'completed' } } });
      push({ kind: 'turnEnded', sessionId, response: { stopReason: 'end_turn' } });
    }
    const state = { ...recordings.plan.state, sessionId, journal: { id: 'j', head: seq } };
    const started = performance.now();
    const transcript = follow({ name: 'long', state, events }, 'replayed');
    const elapsed = performance.now() - started;
    expect(events.length).toBeGreaterThan(8_000);
    expect(transcript.entries).toHaveLength(600);
    expect(elapsed).toBeLessThan(2_000);
  });
});
