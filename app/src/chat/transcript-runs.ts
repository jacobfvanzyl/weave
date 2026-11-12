import type { TranscriptEntry, TranscriptMessage, TranscriptSubagent, TurnEnd } from './acp-transcript';
import { isPrompt } from './acp-transcript';

/** What a run of work holds: tool calls, and the agent's thinking between them. */
export type WorkEntry = Extract<TranscriptEntry, { kind: 'tool' | 'message' }>;

type ToolCall = Extract<TranscriptEntry, { kind: 'tool' }>;

/**
 * A run of the agent's work folded into one row; `working` while it's the running turn's latest.
 * It began (`since`) when the prompt or message before it was last written, or with its first
 * entry, and was last at work at `until`; neither is known for entries the journal didn't date.
 */
export type WorkRun = { kind: 'work'; id: string; entries: WorkEntry[]; working: boolean; since?: number; until?: number };

/** A row of the transcript as it shows today: an entry, or a run of work. */
export type ShownItem = { kind: 'entry'; entry: TranscriptEntry } | WorkRun;

/** A row of a folded turn, and whether the fold hides it while it's closed. */
export type FoldRow = { item: ShownItem; hidden: boolean };

/**
 * A finished turn's work folded under one row (WVE-218): `worked`, or `stopped` when the person
 * cancelled the turn, under its prompt, and `continued` for the work after a steer. `rows` are the
 * rows it spans, in the order the turn shows them open: from the first after the prompt or steer
 * to the last it hides, with those that stay in sight among them. Closed, it shows only those. `took`
 * is the whole turn's time, from its prompt to its end, for the row under the prompt, and for one
 * after a steer from the steer to the last update of what came after it; none where the journal
 * didn't date them.
 */
export type TurnFold = { kind: 'fold'; id: string; label: 'worked' | 'continued' | 'stopped'; took?: number; rows: FoldRow[] };

/** One row of the transcript: an entry, a run of work, or a finished turn's work folded. */
export type TranscriptItem = ShownItem | TurnFold;

/** What the turns need besides the entries: how each ended, and the subagents still running. */
export type TurnContext = {
  /** `AcpTranscript.turnEnds`. */
  turnEnds?: Record<string, TurnEnd>;
  /** The transcript's subagents, for which of them are still at work. */
  subagents?: TranscriptSubagent[];
};

/** An assistant message with nothing in it but thinking. */
const thinking = (entry: TranscriptEntry): entry is Extract<TranscriptEntry, { kind: 'message' }> =>
  entry.kind === 'message' && entry.role === 'assistant' && entry.chunks.length > 0 && entry.chunks.every(({ kind }) => kind === 'thought');

const isWork = (entry: TranscriptEntry): entry is WorkEntry => entry.kind === 'tool' || thinking(entry);

const isSteer = (entry: TranscriptEntry) => entry.kind === 'message' && entry.role === 'user' && Boolean(entry.steer);

/**
 * The transcript as it shows. An uninterrupted run of tool calls, with the thinking between them,
 * folds into one row once it holds a tool call, a lone one too; anything else the agent says ends it. While a
 * turn runs, the run at the end is its activity however short, and so is a prompt the agent hasn't
 * answered yet.
 *
 * A turn runs from a prompt to the next, and once it has ended its work folds too, under one row
 * between the prompt and its final message (`TurnFold`), and after each steer under a row of its
 * own. The last turn has ended unless the thread is `running`; one that failed stays open. What
 * comes before the first prompt is in no turn.
 */
export function transcriptItems(entries: TranscriptEntry[], running: boolean, { turnEnds = {}, subagents = [] }: TurnContext = {}): TranscriptItem[] {
  const starts = entries.flatMap((entry, index) => isPrompt(entry) ? [index] : []);
  if (starts.length === 0) return runItems(entries, running);
  const items: TranscriptItem[] = runItems(entries.slice(0, starts[0]), false);
  const working = new Set(subagents.filter(({ state }) => state === 'running').map(({ threadId }) => threadId));
  starts.forEach((start, turn) => {
    const latest = running && turn === starts.length - 1;
    const turnEntries = entries.slice(start, starts[turn + 1]);
    const end = turnEnds[turnEntries[0].id];
    items.push(...(latest || end?.end === 'failed' ? runItems(turnEntries, latest) : foldedTurn(turnEntries, end, working)));
  });
  return items;
}

/** The entries as rows, with their runs of work folded, `running` when the last of them are the running turn's. */
function runItems(entries: TranscriptEntry[], running: boolean): ShownItem[] {
  const items: ShownItem[] = [];
  let run: WorkEntry[] = [];
  let before: TranscriptEntry | undefined;
  const end = (latest: boolean) => {
    const [first] = run;
    if (!first) return;
    const working = running && latest;
    if (working || run.some(({ kind }) => kind === 'tool')) {
      items.push({ kind: 'work', id: `work-${first.id}`, entries: run, working, ...times(run, before) });
    } else {
      items.push(...run.map((entry) => ({ kind: 'entry' as const, entry })));
    }
    run = [];
  };
  for (const entry of entries) {
    if (isWork(entry)) {
      run.push(entry);
      continue;
    }
    end(false);
    items.push({ kind: 'entry', entry });
    before = entry;
  }
  end(true);
  const last = entries.at(-1);
  if (running && last?.kind === 'message' && last.role === 'user') {
    items.push({ kind: 'work', id: `work-after-${last.id}`, entries: [], working: true, ...times([], last) });
  }
  return items;
}

/** Where a message's thinking ends: the index after its last thought chunk, or 0. */
const afterThinking = (message: TranscriptMessage) => {
  for (let index = message.chunks.length - 1; index >= 0; index -= 1) {
    if (message.chunks[index].kind === 'thought') return index + 1;
  }
  return 0;
};

/** An assistant message that says something after its thinking, which can end a turn. */
const answers = (entry: TranscriptEntry): entry is TranscriptMessage =>
  entry.kind === 'message' && entry.role === 'assistant' && entry.chunks.slice(afterThinking(entry)).some((chunk) =>
    chunk.kind === 'message' && chunk.content.some((block) => block.type !== 'text' || block.text.trim() !== ''));

const answerParts = new WeakMap<TranscriptMessage, { work?: TranscriptMessage; answer: TranscriptMessage }>();

/**
 * A turn's final message, apart from the thinking and anything it said before it, which fold with
 * the turn's work: the thinking as an entry of its own, `<id>:work`, and the answer keeping the
 * message's id. The same message gives the same parts, so views of them keep.
 */
function answerOf(message: TranscriptMessage): { work?: TranscriptMessage; answer: TranscriptMessage } {
  let parts = answerParts.get(message);
  if (!parts) {
    const at = afterThinking(message);
    parts = at === 0
      ? { answer: message }
      : { work: { ...message, id: `${message.id}:work`, chunks: message.chunks.slice(0, at) }, answer: { ...message, chunks: message.chunks.slice(at) } };
    answerParts.set(message, parts);
  }
  return parts;
}

/** A pending request: a tool call waiting for permission, a question, or a client tool. */
const waiting = (entry: TranscriptEntry) =>
  (entry.kind === 'tool' && entry.permission?.status === 'pending')
  || ((entry.kind === 'elicitation' || entry.kind === 'client-tool') && entry.status === 'pending');

/**
 * What stays in sight in a folded turn: pending requests, questions the person answered,
 * compactions, what the Host or agent said of the thread (diagnostics), and subagents still at
 * work.
 */
const staysInSight = (entry: TranscriptEntry, working: Set<string>) => {
  switch (entry.kind) {
    case 'elicitation':
      return entry.status === 'pending' || entry.status === 'answered' || entry.status === 'elsewhere' || entry.status === 'completed';
    case 'compaction':
    case 'diagnostic':
      return true;
    case 'subagent':
      return working.has(entry.subagentId);
    default:
      return waiting(entry);
  }
};

const itemEntries = (item: ShownItem): TranscriptEntry[] => item.kind === 'entry' ? [item.entry] : item.entries;

/**
 * A finished turn as it shows: its prompt, the steers and what stays in sight in place, and the
 * rest folded, under the prompt and under each steer after the turn had begun its work; then its
 * final message, the last thing the agent said, and after it what isn't a finished tool call. A
 * fold spans what it hides with what stays in sight among it, so open it reads as the turn did.
 */
function foldedTurn(entries: TranscriptEntry[], end: TurnEnd | undefined, working: Set<string>): TranscriptItem[] {
  const [prompt] = entries;
  let finalIndex = -1;
  for (let index = entries.length - 1; index > 0 && finalIndex === -1; index -= 1) {
    if (answers(entries[index])) finalIndex = index;
  }
  let final: TranscriptEntry | undefined;
  let parted = entries;
  if (finalIndex !== -1) {
    const { work, answer } = answerOf(entries[finalIndex] as TranscriptMessage);
    final = answer;
    parted = [...entries.slice(0, finalIndex), ...(work ? [work] : []), answer, ...entries.slice(finalIndex + 1)];
  }
  const items = runItems(parted, false);
  const finalAt = final ? items.findIndex((item) => item.kind === 'entry' && item.entry === final) : items.length;
  const inSight = (item: ShownItem, index: number) => {
    if (index === finalAt) return true;
    // After the final message only finished tool calls fold.
    const trailing = index > finalAt;
    if (item.kind === 'work') {
      return item.entries.some(waiting) || (trailing && item.entries.some((entry) => entry.kind === 'tool' && entry.status !== 'completed'));
    }
    return trailing || staysInSight(item.entry, working);
  };

  // The turn in parts, each folded under a row at its start: under the prompt, and the steers
  // before the turn began its work, or under the steer that split the turn.
  type Part = { steer?: TranscriptEntry; rows: { item: ShownItem; inSight: boolean }[] };
  const sequence: (ShownItem | Part)[] = [items[0]];
  let part: Part | undefined;
  items.slice(1).forEach((item, offset) => {
    if (item.kind === 'entry' && isSteer(item.entry)) {
      // A steer splits the turn once it has begun its work; steers one after another split it once, after the last.
      if (part?.steer && part.rows.length === 0) {
        part.steer = item.entry;
        sequence.splice(-1, 1, item, part);
        return;
      }
      sequence.push(item);
      if (!part) return;
      part = { steer: item.entry, rows: [] };
      sequence.push(part);
      return;
    }
    if (!part) {
      part = { rows: [] };
      sequence.push(part);
    }
    part.rows.push({ item, inSight: inSight(item, offset + 1) });
  });

  // A part's fold spans its rows up to the last it hides; what follows that shows after it.
  return sequence.flatMap((step): TranscriptItem[] => {
    if (!('rows' in step)) return [step];
    const { steer, rows } = step;
    const last = rows.length - 1 - [...rows].reverse().findIndex(({ inSight }) => !inSight);
    if (last === rows.length) return rows.map(({ item }) => item);
    const label = steer ? 'continued' : end?.end === 'stopped' ? 'stopped' : 'worked';
    const fold: TurnFold = { kind: 'fold', id: `fold-${(steer ?? prompt).id}`, label, rows: rows.slice(0, last + 1).map(({ item, inSight }) => ({ item, hidden: !inSight })) };
    const from = (steer ?? prompt).startedAt;
    const updates = rows.flatMap(({ item }) => itemEntries(item)).map(({ updatedAt }) => updatedAt).filter((at) => at !== undefined);
    const to = steer ? (updates.length > 0 ? Math.max(...updates) : undefined) : end?.endedAt;
    if (from !== undefined && to !== undefined) fold.took = to - from;
    return [fold, ...rows.slice(last + 1).map(({ item }) => item)];
  });
}

/**
 * When a run began and was last at work. A prompt or message just before it is written by then,
 * so the thinking before its first tool call counts; anything else before it may still change.
 */
function times(run: WorkEntry[], before?: TranscriptEntry): Pick<WorkRun, 'since' | 'until'> {
  const starts = [...(before?.kind === 'message' ? [before.updatedAt] : []), run[0]?.startedAt].filter((at) => at !== undefined);
  const updates = run.map(({ updatedAt }) => updatedAt).filter((at) => at !== undefined);
  return {
    ...(starts.length > 0 ? { since: Math.min(...starts) } : {}),
    ...(updates.length > 0 ? { until: Math.max(...updates) } : {}),
  };
}

/** A fold's row: "Worked for 2m 17s", "Continued for 40s", "You stopped after 1m 5s"; without times, "Worked", "Continued", "You stopped the turn". */
export function foldLabel({ label, took }: Pick<TurnFold, 'label' | 'took'>): string {
  const time = took === undefined ? undefined : durationText(took);
  switch (label) {
    case 'worked':
      return time ? `Worked for ${time}` : 'Worked';
    case 'continued':
      return time ? `Continued for ${time}` : 'Continued';
    case 'stopped':
      return time ? `You stopped after ${time}` : 'You stopped the turn';
  }
}

/** How long something took, as people say it: "45s", "2m 17s", "1h 5m". */
export function durationText(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What a run's tool calls did, by kind: "9 commands, 2 edits, 1 read". */
export function workSummary(entries: WorkEntry[]): string {
  const tools = entries.filter((entry): entry is ToolCall => entry.kind === 'tool');
  const of = (...kinds: ToolCall['toolKind'][]) => tools.filter(({ toolKind }) => kinds.includes(toolKind)).length;
  const kinds = [
    [of('execute'), 'command', 'commands'],
    [of('edit', 'delete', 'move'), 'edit', 'edits'],
    [of('read'), 'read', 'reads'],
    [of('search'), 'search', 'searches'],
    [of('fetch'), 'fetch', 'fetches'],
  ] as const;
  const named = kinds.reduce((sum, [count]) => sum + count, 0);
  const others = tools.length - named;
  if (named === 0) return counted(tools.length, 'tool call', 'tool calls');
  return [
    ...kinds.filter(([count]) => count > 0).map(([count, one, many]) => counted(count, one, many)),
    ...(others > 0 ? [`${others} other`] : []),
  ].join(', ');
}

/** The step a run is on: the latest tool call's title, or thinking. */
export function workStep(entries: WorkEntry[]): string | undefined {
  const latest = entries.at(-1);
  if (!latest) return undefined;
  return latest.kind === 'tool' ? latest.title : 'Thinking';
}
