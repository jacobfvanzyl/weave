import { assertEquals } from 'jsr:@std/assert@1.0.19';
import { compareEvalTrials, summarizeEvalTrials } from './report.ts';
import type { EvalTrialV1 } from './schema.ts';

const trial = (taskId: string, passed: boolean, trialNumber: number): EvalTrialV1 => ({
  version: 1,
  suite: 'suite',
  configuration: 'config',
  taskId,
  trial: trialNumber,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z',
  passed,
  noHarm: true,
  validationPassed: passed,
  durationMs: 1_000,
  graderEvidence: [],
});

Deno.test('eval reports pass rate and all-trials consistency separately', () => {
  const summary = summarizeEvalTrials([trial('a', true, 1), trial('a', false, 2), trial('b', true, 1)]);
  assertEquals(summary.passAt1, 1);
  assertEquals(summary.passRate, 2 / 3);
  assertEquals(summary.passAllTrials, 0.5);
});

Deno.test('eval comparison exposes candidate deltas', () => {
  const comparison = compareEvalTrials([trial('a', false, 1)], [trial('a', true, 1)]);
  assertEquals(comparison.delta.passAt1, 1);
  assertEquals(comparison.delta.noHarmRate, 0);
});
