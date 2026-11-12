// Transcripts from journals recorded from a dev Host with the fake agent (`scripts/record-journals.ts`):
// each event kind as the app shows it, and the same transcript whether the journal arrives live or
// replayed.
import { describe, expect, it } from 'vitest';
import type { ThreadEventNotification } from '@/host/protocol';
import {
  type AcpTranscript,
  blocksText,
  createTranscript,
  reduceAcpEvent,
  TERMINAL_KEEP,
  threadLabel,
  type TranscriptEntry,
} from './acp-transcript';
import { follow, type Recording, recordings } from './fixtures/recordings';
import { terminalText } from './terminal-text';
import { foldLabel, type TranscriptItem, transcriptItems, type TurnFold, workSummary } from './transcript-runs';

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
        return [`• ${entry.event} ${threadLabel(root, entry.subagentId)}${entry.detail ? ` — ${entry.detail}` : ''}`];
      case 'session-message':
        return [`message ${threadLabel(root, entry.senderSessionId)} → ${threadLabel(root, entry.recipientSessionId)}: ${blocksText(entry.content)}`];
      case 'elicitation':
        return [`elicitation ${entry.status}`];
      case 'client-tool':
        return [`client tool ${entry.tool} on ${entry.runner} ${entry.status}`];
    }
  });
  const nested = transcript.subagents.flatMap((subagent) => [
    `subagent ${threadLabel(root, subagent.threadId)} (${subagent.state ?? 'no state'}):`,
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
      ['cancel', 'close', 'compact', 'delegate', 'image', 'markdown', 'modes', 'narrate', 'narrate-cancel', 'narrate-fail', 'narrate-steer', 'notice', 'plan', 'questions', 'reopen', 'run', 'steer', 'think', 'write'],
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
    const threadId = 's-long';
    const events: ThreadEventNotification[] = [];
    let seq = 0;
    const push = (event: ThreadEventNotification['event']) => events.push({ threadId, seq: ++seq, at: 0, event });
    for (let turn = 0; turn < 200; turn += 1) {
      push({ kind: 'turnStarted', threadId, prompt: [{ type: 'text', text: `Turn ${turn}` }], origin: { run: {} } });
      for (let chunk = 0; chunk < 40; chunk += 1) {
        push({ kind: 'update', notification: { sessionId: threadId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `word${chunk} ` } } } });
      }
      push({ kind: 'update', notification: { sessionId: threadId, update: { sessionUpdate: 'tool_call', toolCallId: `tool-${turn}`, title: 'Read', kind: 'read', status: 'completed' } } });
      push({ kind: 'turnEnded', threadId, response: { stopReason: 'end_turn' } });
    }
    const state = { ...recordings.plan.state, threadId, journal: { id: 'j', head: seq } };
    const started = performance.now();
    const transcript = follow({ name: 'long', state, events }, 'replayed');
    const elapsed = performance.now() - started;
    expect(events.length).toBeGreaterThan(8_000);
    expect(transcript.entries).toHaveLength(600);
    expect(elapsed).toBeLessThan(2_000);
  });
});

/**
 * A transcript's rows as the chat shows them: a fold by its label, its time said as "…", with the
 * rows it spans in braces, `+` before those that stay in sight.
 */
function rows(transcript: AcpTranscript, running = transcript.turn.status === 'running'): string[] {
  const row = (item: TranscriptItem): string => {
    if (item.kind === 'fold') return `${foldLabel(item).replace(/\d+[hms]( \d+[ms])?$/, '…')} {${item.rows.map(({ item: spanned, hidden }) => `${hidden ? '' : '+'}${row(spanned)}`).join(' | ')}}`;
    if (item.kind === 'work') return `[${workSummary(item.entries)}]${item.working ? ' working' : ''}`;
    const { entry } = item;
    if (entry.kind === 'message') return `${entry.role}${entry.steer ? ' (steer)' : ''}: ${text(entry)}`;
    if (entry.kind === 'diagnostic') return `${entry.severity}: ${entry.title}`;
    return entry.kind;
  };
  return items(transcript, running).map(row);
}

const items = (transcript: AcpTranscript, running = transcript.turn.status === 'running') =>
  transcriptItems(transcript.entries, running, { turnEnds: transcript.turnEnds, subagents: transcript.subagents });

const folds = (transcript: AcpTranscript) => items(transcript).filter((item): item is TurnFold => item.kind === 'fold');

/** When the journal recorded an event of `kind`, the first or the last. */
const recorded = (recording: Recording, kind: ThreadEventNotification['event']['kind'], which: 'first' | 'last' = 'first') => {
  const found = recording.events.filter(({ event }) => event.kind === kind);
  return (which === 'first' ? found[0] : found.at(-1))!.at;
};

describe('finished turns folded from recorded journals (WVE-218)', () => {
  const asked = "assistant: I'll read the parser and find where it loads its fixtures.";
  const commentary = "assistant: It reads them from the old path. I'll point it at tests/fixtures and run the tests.";
  const answer = 'assistant: Done: the parser reads its fixtures from tests/fixtures, and the tests pass.';

  it('folds a finished turn\'s commentary and tool calls under "Worked for …" between its prompt and final message', () => {
    for (const how of ['live', 'replayed'] as const) {
      const transcript = follow(recordings.narrate, how);
      expect(rows(transcript), how).toEqual([
        'user: /narrate',
        `Worked for … {${asked} | [1 read, 1 search] | ${commentary} | [1 command, 1 edit]}`,
        answer,
      ]);
      expect(folds(transcript)[0].took, how).toBe(recorded(recordings.narrate, 'turnEnded') - recorded(recordings.narrate, 'turnStarted'));
    }
  });

  it('records how each turn ended the same live and replayed', () => {
    const ends = (name: string) => Object.values(follow(recordings[name], 'live').turnEnds).map(({ end }) => end);
    expect(['narrate', 'narrate-steer', 'narrate-cancel', 'narrate-fail', 'reopen'].map(ends))
      .toEqual([['finished'], ['finished'], ['stopped'], ['failed'], ['finished', 'finished']]);
    const live = follow(recordings.narrate, 'live');
    const prompt = live.entries[0];
    expect(live.turnEnds).toEqual({ [prompt.id]: { end: 'finished', endedAt: recorded(recordings.narrate, 'turnEnded') } });
    expect(follow(recordings.narrate, 'replayed').turnEnds).toEqual(live.turnEnds);
  });

  it('shows a running turn as it did, and folds it once it ends', () => {
    const running = follow(recordings.narrate, 'live', ({ event }) => event.kind === 'turnEnded');
    expect(running.turn.status).toBe('running');
    expect(rows(running)).toEqual(['user: /narrate', asked, '[1 read, 1 search]', commentary, '[1 command, 1 edit]', answer]);
    const midway = follow(recordings.narrate, 'live', ({ event }) => event.kind === 'update' && event.notification.update.sessionUpdate === 'agent_message_chunk'
      && event.notification.update.content.type === 'text' && event.notification.update.content.text.startsWith('It reads'));
    expect(rows(midway)).toEqual(['user: /narrate', asked, '[1 read, 1 search] working']);
    expect(rows(follow(recordings.narrate, 'live'))[1]).toMatch(/^Worked for … \{/);
  });

  it('folds every finished turn in replayed history, and leaves only failed turns\' work out of a fold', () => {
    for (const name of Object.keys(recordings)) {
      const transcript = follow(recordings[name], 'replayed');
      const failed = Object.values(transcript.turnEnds).some(({ end }) => end === 'failed');
      const loose = items(transcript).filter((item) => item.kind === 'work');
      expect(loose.length > 0, name).toBe(failed);
    }
    // A compaction stays in sight, so that turn has nothing to fold.
    expect(rows(follow(recordings.compact, 'replayed'))).toEqual(['user: /compact', 'compaction', 'assistant: Compacted.']);
    expect(['narrate', 'narrate-steer', 'narrate-cancel', 'run', 'write', 'plan', 'think', 'delegate'].filter((name) => folds(follow(recordings[name], 'replayed')).length === 0))
      .toEqual([]);
  });

  it('reads in the order of the entries with every fold open', () => {
    const ids = (item: TranscriptItem): string[] => item.kind === 'fold'
      ? item.rows.flatMap(({ item: row }) => ids(row))
      : item.kind === 'work' ? item.entries.map(({ id }) => id) : [item.entry.id];
    for (const name of Object.keys(recordings)) {
      const transcript = follow(recordings[name], 'replayed');
      // A final message's thinking folds apart from it, as `<id>:work` before it.
      expect(items(transcript).flatMap(ids).filter((id) => !id.endsWith(':work')), name).toEqual(transcript.entries.map(({ id }) => id));
    }
  });

  it('keeps a steer in sight, with the work after it under "Continued for …"', () => {
    for (const how of ['live', 'replayed'] as const) {
      const transcript = follow(recordings['narrate-steer'], how);
      expect(rows(transcript), how).toEqual([
        'user: /narrate',
        `Worked for … {${asked} | [1 read]}`,
        'user (steer): And check the lexer too.',
        `Continued for … {[2 searches] | ${commentary} | [1 command, 1 edit]}`,
        `${answer} I looked into what you added too: And check the lexer too.`,
      ]);
      const [top, continued] = folds(transcript);
      expect(top.took).toBe(recorded(recordings['narrate-steer'], 'turnEnded') - recorded(recordings['narrate-steer'], 'turnStarted'));
      // From the steer to the answer's last chunk.
      const steered = recorded(recordings['narrate-steer'], 'turnSteered');
      expect(continued.took).toBe(transcript.entries.at(-1)!.updatedAt! - steered);
      expect(continued.took).toBeGreaterThan(0);
    }
  });

  it('says the person stopped a cancelled turn', () => {
    for (const how of ['live', 'replayed'] as const) {
      const transcript = follow(recordings['narrate-cancel'], how);
      expect(rows(transcript), how).toEqual(['user: /narrate', `You stopped after … {${asked} | [1 read, 1 search]}`, commentary, 'info: Turn cancelled']);
      expect(foldLabel(folds(transcript)[0])).toMatch(/^You stopped after \d+s$/);
    }
  });

  it('leaves a failed turn open', () => {
    for (const how of ['live', 'replayed'] as const) {
      expect(rows(follow(recordings['narrate-fail'], how)), how)
        .toEqual(['user: /narrate fail', asked, '[1 read, 1 search]', commentary, '[1 command, 1 edit]', 'error: Turn failed']);
    }
  });
});
