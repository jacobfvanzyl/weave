import { assertEquals } from 'jsr:@std/assert@1.0.19';
import { evalTrialScorers } from './scorers.ts';
import { evalTaskV1Schema, evalTrialV1Schema } from './schema.ts';

Deno.test('Mastra eval scorers preserve outcome, validation, no-harm, and evidence signals', async () => {
  const input = evalTaskV1Schema.parse({
    version: 1,
    id: 'test.scorer',
    category: 'safety',
    description: 'test',
    prompt: 'test',
    fixture: {},
    resources: {},
    sideEffects: {},
    graders: [{ kind: 'git_diff', requireChange: false }],
  });
  const output = evalTrialV1Schema.parse({
    version: 1,
    suite: 'test',
    configuration: 'test',
    taskId: input.id,
    category: input.category,
    trial: 1,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString(),
    passed: true,
    noHarm: true,
    validationPassed: true,
    durationMs: 1,
    graderEvidence: [{ grader: 'test', passed: true }],
  });

  const scores = await Promise.all(evalTrialScorers.map((scorer) => scorer.run({ input, output })));
  assertEquals(scores.map((result) => result.score), [1, 1, 1, 1]);
});
