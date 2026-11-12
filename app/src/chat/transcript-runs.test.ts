import { describe, expect, it } from 'vitest';
import type {
  TranscriptCompaction,
  TranscriptDiagnostic,
  TranscriptElicitation,
  TranscriptEntry,
  TranscriptMessage,
  TranscriptPlan,
  TranscriptSubagent,
  TranscriptSubagentRow,
  TranscriptToolCall,
  TurnEnd,
} from './acp-transcript';
import { createTranscript } from './acp-transcript';
import { durationText, foldLabel, type TranscriptItem, transcriptItems, type TurnContext, type TurnFold, workStep, workSummary } from './transcript-runs';

const tool = (id: string, toolKind: TranscriptToolCall['toolKind'] = 'execute', status: TranscriptToolCall['status'] = 'completed'): TranscriptToolCall => ({
  id, kind: 'tool', toolCallId: id, title: `Run ${id}`, toolKind, status, content: [], locations: [],
});

const message = (id: string, role: 'user' | 'assistant', kind: 'message' | 'thought' = 'message'): TranscriptMessage => ({
  id, kind: 'message', role, optimistic: false, chunks: [{ kind, content: [{ type: 'text', text: id }] }],
});

const steer = (id: string): TranscriptMessage => ({ ...message(id, 'user'), steer: true });

/** An answer that thinks first, as agents' final messages often do. */
const thoughtful = (id: string, ...kinds: ('message' | 'thought')[]): TranscriptMessage => ({
  ...message(id, 'assistant'),
  chunks: kinds.map((kind, index) => ({ kind, content: [{ type: 'text', text: `${id} ${kind} ${index}` }] })),
});

const diagnostic = (id: string): TranscriptDiagnostic => ({ id, kind: 'diagnostic', severity: 'info', title: id });

const at = <T extends TranscriptEntry>(entry: T, startedAt: number, updatedAt = startedAt): T => ({ ...entry, startedAt, updatedAt });

/**
 * The items as letters: an entry by its id, a run as its entries in brackets, `*` while working, and
 * a fold as its label with the rows it spans in braces, `+` before those that stay in sight.
 */
const outlineItem = (item: TranscriptItem): string => {
  if (item.kind === 'entry') return item.entry.id;
  if (item.kind === 'fold') return `${foldLabel(item)}{${item.rows.map(({ item: row, hidden }) => `${hidden ? '' : '+'}${outlineItem(row)}`).join(' ')}}`;
  return `[${item.entries.map(({ id }) => id).join(' ')}]${item.working ? '*' : ''}`;
};

const outline = (entries: TranscriptEntry[], running = false, context?: TurnContext) =>
  transcriptItems(entries, running, context).map(outlineItem);

const folds = (items: TranscriptItem[]) => items.filter((item): item is TurnFold => item.kind === 'fold');

describe('transcriptItems', () => {
  it('folds an uninterrupted run of tool calls, with the thinking between them', () => {
    expect(outline([message('ask', 'user'), tool('a'), message('hm', 'assistant', 'thought'), tool('b'), message('done', 'assistant')], true))
      .toEqual(['ask', '[a hm b]', 'done']);
  });

  it('folds a lone tool call too, and anything the agent says ends a run', () => {
    expect(outline([tool('a'), message('so', 'assistant'), tool('b'), tool('c'), message('ok', 'assistant'), tool('d')]))
      .toEqual(['[a]', 'so', '[b c]', 'ok', '[d]']);
    // Thinking alone isn't a run.
    expect(outline([message('hm', 'assistant', 'thought'), message('so', 'assistant')])).toEqual(['hm', 'so']);
  });

  it('makes the running turn\'s latest run its activity, however short', () => {
    expect(outline([message('ask', 'user'), tool('a')], true)).toEqual(['ask', '[a]*']);
    expect(outline([message('ask', 'user'), tool('a'), tool('b'), message('so', 'assistant'), tool('c')], true))
      .toEqual(['ask', '[a b]', 'so', '[c]*']);
    // Once the turn ends, a lone tool call stays a run, in the turn's fold.
    expect(outline([message('ask', 'user'), tool('a')])).toEqual(['ask', 'Worked{[a]}']);
  });

  it('says the agent is working on a prompt it hasn\'t answered yet', () => {
    expect(outline([message('ask', 'user')], true)).toEqual(['ask', '[]*']);
    expect(outline([message('ask', 'user')])).toEqual(['ask']);
    expect(outline([message('ask', 'user'), message('sure', 'assistant')], true)).toEqual(['ask', 'sure']);
  });
});

describe('a finished turn', () => {
  const work = [message('ask', 'user'), message('so', 'assistant'), tool('a'), tool('b'), message('then', 'assistant'), tool('c'), message('done', 'assistant')];

  it('folds everything between its prompt and its final message under one row', () => {
    expect(outline(work)).toEqual(['ask', 'Worked{so [a b] then [c]}', 'done']);
  });

  it('never folds while it runs, and folds once it ends', () => {
    const earlier = [message('ask0', 'user'), tool('z'), message('ok', 'assistant')];
    expect(outline([...earlier, ...work.slice(0, -1)], true)).toEqual(['ask0', 'Worked{[z]}', 'ok', 'ask', 'so', '[a b]', 'then', '[c]*']);
    expect(outline([...earlier, ...work], true)).toEqual(['ask0', 'Worked{[z]}', 'ok', 'ask', 'so', '[a b]', 'then', '[c]', 'done']);
    expect(outline([...earlier, ...work])).toEqual(['ask0', 'Worked{[z]}', 'ok', 'ask', 'Worked{so [a b] then [c]}', 'done']);
  });

  it('folds whether or not its end was recorded, as for history an agent loaded', () => {
    const ends: Record<string, TurnEnd> = { ask: { end: 'finished' } };
    expect(outline(work, false, { turnEnds: ends })).toEqual(['ask', 'Worked{so [a b] then [c]}', 'done']);
    expect(outline(work, false, { turnEnds: {} })).toEqual(['ask', 'Worked{so [a b] then [c]}', 'done']);
  });

  it('stays open when it failed, or the Host stopped while it ran', () => {
    const failed = [...work.slice(0, -1), diagnostic('Turn failed')];
    expect(outline(failed, false, { turnEnds: { ask: { end: 'failed', endedAt: 9_000 } } }))
      .toEqual(['ask', 'so', '[a b]', 'then', '[c]', 'Turn failed']);
    // The turn after it folds as usual.
    expect(outline([...failed, message('ask2', 'user'), tool('d'), message('ok', 'assistant')], false, { turnEnds: { ask: { end: 'failed' } } }))
      .toEqual(['ask', 'so', '[a b]', 'then', '[c]', 'Turn failed', 'ask2', 'Worked{[d]}', 'ok']);
  });

  it('says the person stopped it', () => {
    const stopped = [...work.slice(0, 4), diagnostic('Turn cancelled')];
    expect(outline(stopped, false, { turnEnds: { ask: { end: 'stopped' } } })).toEqual(['ask', 'You stopped the turn{+so [a b]}', 'Turn cancelled']);
    expect(outline([message('ask', 'user'), tool('a'), diagnostic('Turn cancelled')], false, { turnEnds: { ask: { end: 'stopped', endedAt: 66_000 } } }))
      .toEqual(['ask', 'You stopped the turn{[a]}', 'Turn cancelled']);
    expect(folds(transcriptItems([at(message('ask', 'user'), 1_000), tool('a')], false, { turnEnds: { ask: { end: 'stopped', endedAt: 66_000 } } })).map(foldLabel))
      .toEqual(['You stopped after 1m 5s']);
  });

  it('folds a turn that reached a limit or refused, with the line saying why in sight', () => {
    expect(outline([...work, diagnostic('Stopped: the agent reached its token limit')], false, { turnEnds: { ask: { end: 'finished' } } }))
      .toEqual(['ask', 'Worked{so [a b] then [c]}', 'done', 'Stopped: the agent reached its token limit']);
  });

  it('shows only its fold when it has no final message', () => {
    expect(outline([message('ask', 'user'), message('hm', 'assistant', 'thought'), tool('a'), tool('b')])).toEqual(['ask', 'Worked{[hm a b]}']);
  });

  it('has no fold when there is nothing to hide', () => {
    expect(outline([message('ask', 'user'), message('done', 'assistant')])).toEqual(['ask', 'done']);
    expect(outline([message('ask', 'user'), message('done', 'assistant'), diagnostic('note')])).toEqual(['ask', 'done', 'note']);
  });

  it('ends in the last thing the agent said, and folds the finished tool calls after it, the final message in sight between them', () => {
    expect(outline([message('ask', 'user'), tool('a'), message('done', 'assistant'), tool('b')])).toEqual(['ask', 'Worked{[a] +done [b]}']);
    // Thinking says nothing.
    expect(outline([message('ask', 'user'), message('done', 'assistant'), tool('a'), message('hm', 'assistant', 'thought')])).toEqual(['ask', 'Worked{+done [a hm]}']);
  });

  it('puts its row under the prompt, ahead of what stays in sight', () => {
    expect(outline([message('ask', 'user'), diagnostic('note'), tool('a'), message('done', 'assistant')])).toEqual(['ask', 'Worked{+note [a]}', 'done']);
  });

  it('spans its rows in the order the turn shows them, with what stays in sight among what it hides', () => {
    const compaction: TranscriptCompaction = { id: 'compacted', kind: 'compaction', compactionId: 'c', status: 'completed', summary: [] };
    const entries = [message('ask', 'user'), tool('a'), compaction, message('so', 'assistant'), tool('b'), diagnostic('note'), message('done', 'assistant')];
    // What stays in sight after the last row it hides shows after it.
    expect(outline(entries)).toEqual(['ask', 'Worked{[a] +compacted so [b]}', 'note', 'done']);
    const [, fold] = transcriptItems(entries, false) as [TranscriptItem, TurnFold];
    // Open, the turn reads as it did before it folded.
    expect(fold.rows.flatMap(({ item }) => item.kind === 'entry' ? [item.entry.id] : item.entries.map(({ id }) => id)))
      .toEqual(['a', 'compacted', 'so', 'b']);
    expect(fold.rows.filter(({ hidden }) => !hidden).map(({ item }) => item.kind === 'entry' && item.entry.id)).toEqual(['compacted']);
  });

  it('spans each part of a steered turn on its own', () => {
    expect(outline([
      message('ask', 'user'), tool('a'), diagnostic('one'), tool('b'),
      steer('more'), diagnostic('two'), tool('c'), diagnostic('three'), message('done', 'assistant'),
    ])).toEqual(['ask', 'Worked{[a] +one [b]}', 'more', 'Continued{+two [c]}', 'three', 'done']);
  });

  it('keeps tool calls after the final message in sight when they failed or still run', () => {
    expect(outline([message('ask', 'user'), tool('a'), message('done', 'assistant'), tool('b', 'execute', 'failed')])).toEqual(['ask', 'Worked{[a]}', 'done', '[b]']);
    expect(outline([message('ask', 'user'), tool('a'), message('done', 'assistant'), tool('b', 'execute', 'in_progress')])).toEqual(['ask', 'Worked{[a]}', 'done', '[b]']);
    // Before it, they fold whatever their state.
    expect(outline([message('ask', 'user'), tool('a', 'execute', 'failed'), message('done', 'assistant')])).toEqual(['ask', 'Worked{[a]}', 'done']);
  });

  it('keeps what isn\'t work after the final message in sight', () => {
    const plan: TranscriptPlan = { id: 'plan', kind: 'plan', planId: 'p', format: 'entries', entries: [] };
    expect(outline([message('ask', 'user'), tool('a'), message('done', 'assistant'), plan, diagnostic('notice')])).toEqual(['ask', 'Worked{[a]}', 'done', 'plan', 'notice']);
    // Before it, a plan folds.
    expect(outline([message('ask', 'user'), plan, tool('a'), message('done', 'assistant')])).toEqual(['ask', 'Worked{plan [a]}', 'done']);
  });

  it('keeps pending requests, answered questions, compactions and subagents at work in sight', () => {
    const question = (id: string, status: TranscriptElicitation['status']): TranscriptElicitation =>
      ({ id, kind: 'elicitation', requestId: id, request: { mode: 'form', message: id } as TranscriptElicitation['request'], status });
    const compaction: TranscriptCompaction = { id: 'compacted', kind: 'compaction', compactionId: 'c', status: 'completed', summary: [] };
    const row = (id: string, subagentId: string): TranscriptSubagentRow => ({ id, kind: 'subagent', subagentId, event: 'spawned' });
    const subagent = (threadId: string, state: string): TranscriptSubagent => ({ threadId, number: 1, state, transcript: createTranscript(threadId) });
    const asking: TranscriptToolCall = { ...tool('b'), permission: { requestId: 'r', options: [], status: 'pending' } };
    const entries = [
      message('ask', 'user'),
      tool('a'), message('so', 'assistant'), tool('c'), asking,
      question('asked', 'pending'), question('answered', 'answered'), question('elsewhere', 'elsewhere'), question('dropped', 'cancelled'),
      compaction, row('ada', 'main:ada'), row('robie', 'main:robie'),
      message('done', 'assistant'),
    ];
    expect(outline(entries, false, { subagents: [subagent('main:ada', 'running'), subagent('main:robie', 'idle')] }))
      .toEqual(['ask', 'Worked{[a] so +[c b] +asked +answered +elsewhere dropped +compacted +ada robie}', 'done']);
  });

  it('folds the thinking in its final message, leaving what it says after it', () => {
    const answer = thoughtful('done', 'thought', 'message');
    const entries = [message('ask', 'user'), tool('a'), answer];
    const items = transcriptItems(entries, false);
    expect(items.map(outlineItem)).toEqual(['ask', 'Worked{[a done:work]}', 'done']);
    const [, fold, final] = items;
    expect(final).toMatchObject({ kind: 'entry', entry: { id: 'done', chunks: [answer.chunks[1]] } });
    expect((fold as TurnFold).rows[0].item).toMatchObject({ kind: 'work', entries: [{ id: 'a' }, { id: 'done:work', chunks: [answer.chunks[0]] }] });
    // The same message gives the same parts, so their views keep.
    const parts = (items: TranscriptItem[]) => {
      const [, folded, last] = items;
      const run = (folded as TurnFold).rows[0].item;
      return [run.kind === 'work' ? run.entries[1] : undefined, last.kind === 'entry' ? last.entry : undefined];
    };
    const [work, said] = parts(transcriptItems(entries, false));
    const [workAgain, saidAgain] = parts(transcriptItems([...entries], false));
    expect(workAgain).toBe(work);
    expect(saidAgain).toBe(said);
    // What it said before its last thinking folds with the thinking.
    expect(outline([message('ask', 'user'), thoughtful('done', 'message', 'thought', 'message')])).toEqual(['ask', 'Worked{done:work}', 'done']);
    // A message that ends in thinking isn't the answer.
    expect(outline([message('ask', 'user'), message('ok', 'assistant'), thoughtful('later', 'message', 'thought')])).toEqual(['ask', 'ok', 'later']);
  });

  it('leaves what came before the first prompt as it was', () => {
    expect(outline([tool('a'), message('so', 'assistant'), message('ask', 'user'), tool('b'), message('done', 'assistant')]))
      .toEqual(['[a]', 'so', 'ask', 'Worked{[b]}', 'done']);
  });

  it('starts a turn at a message this device is still sending', () => {
    expect(outline([message('ask', 'user'), tool('a'), message('done', 'assistant'), { ...message('next', 'user'), optimistic: true }], true))
      .toEqual(['ask', 'Worked{[a]}', 'done', 'next', '[]*']);
  });

  it('keys its folds by the prompt and the steers', () => {
    const items = transcriptItems([message('ask', 'user'), tool('a'), steer('more'), tool('b'), message('done', 'assistant')], false);
    expect(folds(items).map(({ id }) => id)).toEqual(['fold-ask', 'fold-more']);
  });
});

describe('a steered turn', () => {
  it('keeps the steer in sight and folds the work after it under a row of its own', () => {
    expect(outline([message('ask', 'user'), message('so', 'assistant'), tool('a'), steer('more'), tool('b'), message('done', 'assistant')]))
      .toEqual(['ask', 'Worked{so [a]}', 'more', 'Continued{[b]}', 'done']);
  });

  it('isn\'t split by a steer before the turn has done anything', () => {
    expect(outline([message('ask', 'user'), steer('more'), tool('a'), message('done', 'assistant')]))
      .toEqual(['ask', 'more', 'Worked{[a]}', 'done']);
  });

  it('is split once by steers one after another, after the last', () => {
    const items = transcriptItems([message('ask', 'user'), tool('a'), steer('more'), steer('also'), tool('b'), message('done', 'assistant')], false);
    expect(items.map(outlineItem)).toEqual(['ask', 'Worked{[a]}', 'more', 'also', 'Continued{[b]}', 'done']);
    expect(folds(items).map(({ id }) => id)).toEqual(['fold-ask', 'fold-also']);
  });

  it('has no row after a steer that nothing after it hides', () => {
    expect(outline([message('ask', 'user'), tool('a'), steer('more'), message('done', 'assistant')])).toEqual(['ask', 'Worked{[a]}', 'more', 'done']);
  });

  it('times the top row by the whole turn, and each after a steer from the steer', () => {
    const entries = [
      at(message('ask', 'user'), 1_000),
      at(tool('a'), 2_000, 30_000),
      at(steer('more'), 40_000),
      at(tool('b'), 45_000, 70_000),
      at(message('done', 'assistant'), 75_000, 80_000),
    ];
    const items = transcriptItems(entries, false, { turnEnds: { ask: { end: 'finished', endedAt: 138_000 } } });
    expect(folds(items).map(foldLabel)).toEqual(['Worked for 2m 17s', 'Continued for 40s']);
    expect(folds(items).map(({ took }) => took)).toEqual([137_000, 40_000]);
    // A turn whose end wasn't recorded has no time at the top.
    expect(folds(transcriptItems(entries, false)).map(foldLabel)).toEqual(['Worked', 'Continued for 40s']);
  });
});

describe('foldLabel', () => {
  it('says how long, or without times what happened', () => {
    expect(foldLabel({ label: 'worked', took: 137_000 })).toBe('Worked for 2m 17s');
    expect(foldLabel({ label: 'continued', took: 40_000 })).toBe('Continued for 40s');
    expect(foldLabel({ label: 'stopped', took: 65_000 })).toBe('You stopped after 1m 5s');
    expect(foldLabel({ label: 'worked' })).toBe('Worked');
    expect(foldLabel({ label: 'continued' })).toBe('Continued');
    expect(foldLabel({ label: 'stopped' })).toBe('You stopped the turn');
  });
});

describe('workSummary', () => {
  it('says what the tool calls did, by kind', () => {
    expect(workSummary([tool('a'), tool('b'), tool('c', 'edit'), tool('d', 'read'), tool('e', 'other')])).toBe('2 commands, 1 edit, 1 read, 1 other');
    expect(workSummary([tool('a', 'other'), tool('b', 'think')])).toBe('2 tool calls');
    expect(workSummary([tool('a', 'search'), tool('b', 'search')])).toBe('2 searches');
  });
});

describe('workStep', () => {
  it('is the latest tool call, or thinking', () => {
    expect(workStep([tool('a'), tool('b')])).toBe('Run b');
    expect(workStep([tool('a'), message('hm', 'assistant', 'thought')])).toBe('Thinking');
    expect(workStep([])).toBeUndefined();
  });
});

describe('how long a run took', () => {
  /** The finished turn's first run, in its fold. */
  const firstRun = (entries: TranscriptEntry[]) => (transcriptItems(entries, false).find((item) => item.kind === 'fold') as TurnFold).rows[0].item;

  it('runs from the prompt or message before it to its last update', () => {
    expect(firstRun([at(message('ask', 'user'), 1_000), at(tool('a'), 5_000, 9_000), at(tool('b'), 9_500, 20_000), at(message('done', 'assistant'), 21_000)]))
      .toMatchObject({ kind: 'work', since: 1_000, until: 20_000 });
  });

  it('runs from its first entry when what comes before it may still change, and has no times without dates', () => {
    const plan: TranscriptPlan = { id: 'plan', kind: 'plan', planId: 'p', format: 'entries', entries: [] };
    expect(transcriptItems([at(plan, 1_000, 30_000), at(tool('a'), 5_000), at(tool('b'), 6_000)], false)[1]).toMatchObject({ since: 5_000, until: 6_000 });
    expect(transcriptItems([tool('a'), tool('b')], false)[0]).not.toHaveProperty('since');
  });

  it('says it as people do', () => {
    expect([0, 45_000, 137_000, 120_000, 3_900_000, 7_200_000].map((ms) => durationText(ms))).toEqual(['0s', '45s', '2m 17s', '2m', '1h 5m', '2h']);
  });
});
