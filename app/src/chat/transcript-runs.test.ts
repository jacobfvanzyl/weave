import { describe, expect, it } from 'vitest';
import type { TranscriptEntry, TranscriptMessage, TranscriptPlan, TranscriptToolCall } from './acp-transcript';
import { durationText, transcriptItems, workStep, workSummary } from './transcript-runs';

const tool = (id: string, toolKind: TranscriptToolCall['toolKind'] = 'execute'): TranscriptToolCall => ({
  id, kind: 'tool', toolCallId: id, title: `Run ${id}`, toolKind, status: 'completed', content: [], locations: [],
});

const message = (id: string, role: 'user' | 'assistant', kind: 'message' | 'thought' = 'message'): TranscriptMessage => ({
  id, kind: 'message', role, optimistic: false, chunks: [{ kind, content: [{ type: 'text', text: id }] }],
});

/** The items as letters: an entry by its id, a run as its entries in brackets, `*` while working. */
const outline = (entries: TranscriptEntry[], running = false) => transcriptItems(entries, running).map((item) =>
  item.kind === 'entry' ? item.entry.id : `[${item.entries.map(({ id }) => id).join(' ')}]${item.working ? '*' : ''}`);

describe('transcriptItems', () => {
  it('folds an uninterrupted run of tool calls, with the thinking between them', () => {
    expect(outline([message('ask', 'user'), tool('a'), message('hm', 'assistant', 'thought'), tool('b'), message('done', 'assistant')]))
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
    // Once the turn ends, a lone tool call stays a run.
    expect(outline([message('ask', 'user'), tool('a')])).toEqual(['ask', '[a]']);
  });

  it('says the agent is working on a prompt it hasn\'t answered yet', () => {
    expect(outline([message('ask', 'user')], true)).toEqual(['ask', '[]*']);
    expect(outline([message('ask', 'user')])).toEqual(['ask']);
    expect(outline([message('ask', 'user'), message('sure', 'assistant')], true)).toEqual(['ask', 'sure']);
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
  const at = <T extends TranscriptEntry>(entry: T, startedAt: number, updatedAt = startedAt): T => ({ ...entry, startedAt, updatedAt });

  it('runs from the prompt or message before it to its last update', () => {
    const items = transcriptItems([at(message('ask', 'user'), 1_000), at(tool('a'), 5_000, 9_000), at(tool('b'), 9_500, 20_000), at(message('done', 'assistant'), 21_000)], false);
    expect(items[1]).toMatchObject({ kind: 'work', since: 1_000, until: 20_000 });
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
