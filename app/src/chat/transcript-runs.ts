import type { TranscriptEntry } from './acp-transcript';

/** What a run of work holds: tool calls, and the agent's thinking between them. */
export type WorkEntry = Extract<TranscriptEntry, { kind: 'tool' | 'message' }>;

type ToolCall = Extract<TranscriptEntry, { kind: 'tool' }>;

/**
 * A run of the agent's work folded into one row; `working` while it's the running turn's latest.
 * It began (`since`) when the prompt or message before it was last written, or with its first
 * entry, and was last at work at `until`; neither is known for entries the journal didn't date.
 */
export type WorkRun = { kind: 'work'; id: string; entries: WorkEntry[]; working: boolean; since?: number; until?: number };

/** One row of the transcript: an entry, or a run of work. */
export type TranscriptItem = { kind: 'entry'; entry: TranscriptEntry } | WorkRun;

/** An assistant message with nothing in it but thinking. */
const thinking = (entry: TranscriptEntry): entry is Extract<TranscriptEntry, { kind: 'message' }> =>
  entry.kind === 'message' && entry.role === 'assistant' && entry.chunks.length > 0 && entry.chunks.every(({ kind }) => kind === 'thought');

const isWork = (entry: TranscriptEntry): entry is WorkEntry => entry.kind === 'tool' || thinking(entry);

/**
 * The transcript as it shows. An uninterrupted run of tool calls, with the thinking between them,
 * folds into one row once it holds two tool calls; anything else the agent says ends it. While a
 * turn runs, the run at the end is its activity however short, and so is a prompt the agent hasn't
 * answered yet.
 */
export function transcriptItems(entries: TranscriptEntry[], running: boolean): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let run: WorkEntry[] = [];
  let before: TranscriptEntry | undefined;
  const end = (latest: boolean) => {
    const [first] = run;
    if (!first) return;
    const working = running && latest;
    if (working || run.filter(({ kind }) => kind === 'tool').length >= 2) {
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
