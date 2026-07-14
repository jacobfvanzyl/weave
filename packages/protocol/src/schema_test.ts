import { threadCompactionEventDataSchema, threadRunPhaseSchema } from './schema.ts';

Deno.test('thread run and compaction lifecycle schemas accept the shared wire contract', () => {
  if (threadRunPhaseSchema.parse('compacting') !== 'compacting') {
    throw new Error('expected compacting phase');
  }
  const event = threadCompactionEventDataSchema.parse({
    phase: 'rejected',
    compactionId: 'compaction-1',
    origin: 'mid_run',
    trigger: 'automatic',
    generation: 2,
    mode: 'incremental',
    reason: 'insufficient_gain',
    tokensBefore: 4_000,
    tokensAfter: 4_100,
    reclaimedTokens: -100,
    headroomTokens: 1_000,
  });
  if (event.reclaimedTokens !== -100) throw new Error('expected signed token reclamation');
});

Deno.test('thread compaction lifecycle schema rejects unknown phases', () => {
  let rejected = false;
  try {
    threadCompactionEventDataSchema.parse({
      phase: 'unknown',
      compactionId: 'compaction-1',
      origin: 'pre_run',
      trigger: 'automatic',
      generation: 1,
      mode: 'rebuild',
    });
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('expected invalid lifecycle phase to be rejected');
});
