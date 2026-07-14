import type { MastraDBMessage } from '@mastra/core/agent';
import {
  batchCompactionMessages,
  batchCompactionTranscripts,
  buildCompactionPrompt,
  collectCompactionAttachments,
  evaluateCompactionFidelity,
  normalizeCheckpoint,
  parseStructuredCheckpoint,
  projectCompaction,
  putThreadCompactionContext,
  putThreadCompactionStepRuntime,
  renderStructuredCheckpoint,
  selectCompactionCut,
  serializeCompactionMessages,
  threadCompactionDisplayMessage,
  ThreadCompactionProcessor,
  validateCompactionSummary,
  validateStructuredCheckpoint,
} from './thread-compaction.ts';
import type { ThreadCompactionRecord } from './thread-compaction-repository.ts';

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message);
};

const message = (
  id: string,
  role: MastraDBMessage['role'],
  text: string,
  parts?: unknown[],
): MastraDBMessage => ({
  id,
  role,
  createdAt: new Date(`2026-01-01T00:00:${id.padStart(2, '0')}Z`),
  content: { format: 2, parts: (parts ?? [{ type: 'text', text }]) as never },
  threadId: 'thread-1',
  resourceId: 'resource-1',
} as MastraDBMessage);

Deno.test('compaction cuts at a complete user-turn boundary and retains at least two user turns', () => {
  const messages = [
    message('1', 'user', 'first'),
    message('2', 'assistant', 'first response'),
    message('3', 'user', 'second'),
    message('4', 'assistant', 'second response'),
    message('5', 'user', 'third'),
    message('6', 'assistant', 'third response'),
  ];
  const cut = selectCompactionCut(messages, 1);
  assert(cut, 'expected a compaction cut');
  assert(
    cut.firstRetained.role === 'user',
    'retained history must begin with a user turn',
  );
  assert(
    cut.retained.filter((item) => item.role === 'user').length >= 2,
    'expected two retained user turns',
  );
  assert(
    cut.compactedThrough.id === '2',
    'the first turn should be compacted as a unit',
  );
});

Deno.test('compaction serialization redacts secrets and omits reasoning and data-only parts', () => {
  const serialized = serializeCompactionMessages([
    message('1', 'user', '', [
      { type: 'text', text: 'api_key=sk-abcdefghijklmnop' },
      { type: 'reasoning', text: 'hidden thought' },
      { type: 'data-private', data: { secret: true } },
      { type: 'file', filename: 'diagram.png', mediaType: 'image/png' },
    ]),
  ]);
  assert(serialized.includes('[REDACTED]'), 'expected credential redaction');
  assert(
    !serialized.includes('hidden thought'),
    'reasoning must not be summarized',
  );
  assert(
    !serialized.includes('data-private'),
    'data-only parts must not be summarized',
  );
  assert(
    serialized.includes('diagram.png'),
    'attachments should be represented by placeholders',
  );
  assert(serialized.includes('attachment:1:3'), 'attachment placeholders need stable message/part ids');
});

Deno.test('V2 checkpoints validate attachment ids and render deterministic compatibility Markdown', () => {
  const messages = [message('7', 'user', '', [
    { type: 'text', text: 'Use this reference.' },
    { type: 'image', filename: 'reference.png', mediaType: 'image/png' },
  ])];
  const validated = validateStructuredCheckpoint({
    version: 2,
    objectiveAndIntent: ['Match the reference image.'],
    decisionsAndConstraints: ['Keep spacing exact.'],
    completedOutcomes: [],
    repositoryAndRuntimeState: ['/workspace is dirty.', 'api_key=sk-abcdefghijklmnop'],
    validationState: ['Not run.'],
    remainingWorkAndBlockers: ['Implement the layout.'],
    importantReferences: [{ kind: 'file', value: '/workspace/ui.tsx', context: 'target' }],
    failuresToAvoid: ['Do not replace unrelated files.'],
    attachments: [{ id: 'attachment:7:1', note: 'visual reference' }],
    lineageDepth: 2,
  }, {
    maxTokens: 1_000,
    attachmentCatalog: collectCompactionAttachments(messages),
  });
  assert(validated.checkpoint.attachments[0]?.messageId === '7', 'trusted attachment identity should be restored');
  assert(validated.summary === renderStructuredCheckpoint(validated.checkpoint), 'Markdown must be deterministic');
  assert(!JSON.stringify(validated.checkpoint).includes('sk-abcdefghijklmnop'), 'persisted JSON must redact secrets');
  const normalized = normalizeCheckpoint(undefined, validated.summary);
  assert(
    normalized.objectiveAndIntent.includes('Match the reference image.'),
    'legacy normalization should remain readable',
  );
  assert(normalized.producer === 'legacy_normalized', 'legacy normalization should preserve checkpoint provenance');
  assert(validated.checkpoint.producer === 'v2', 'validated structured output must be marked as V2');
});

Deno.test('cumulative prompts carry the previous checkpoint and summaries require the stable schema', () => {
  const prompt = buildCompactionPrompt({
    previousSummary: 'old checkpoint',
    transcript: 'new turn',
    instructions: 'focus',
  });
  assert(
    prompt.includes('old checkpoint') && prompt.includes('new turn') &&
      prompt.includes('focus'),
    'expected cumulative prompt',
  );
  const summary = [
    '# Objective and user intent\nPreserve visual requirements.',
    '# Decisions and constraints',
    '# Completed outcomes',
    '# Current repository and runtime state',
    '# Validation state\nTests pass; image att_visual remains available.',
    '# Remaining work and blockers',
    '# Important identifiers and references',
    '# Failures and work not to repeat',
  ].join('\n\n');
  assert(
    validateCompactionSummary(summary, 1_000).summary === summary,
    'expected valid structured summary',
  );
  const checkpoint = parseStructuredCheckpoint(summary);
  const fidelity = evaluateCompactionFidelity(checkpoint, {
    requirements: ['Preserve visual requirements'],
    visualReferences: ['att_visual'],
  });
  assert(fidelity.passed, `expected faithful checkpoint: ${JSON.stringify(fidelity.missing)}`);
});

Deno.test('oversized compaction sources are batched without reordering messages', () => {
  const messages = [
    message('1', 'user', 'A'.repeat(80)),
    message('2', 'assistant', 'B'.repeat(80)),
    message('3', 'user', 'C'.repeat(80)),
    message('4', 'assistant', 'D'.repeat(80)),
  ];
  const batches = batchCompactionMessages(messages, 50);
  assert(batches.length > 1, 'expected multiple source batches');
  assert(
    batches.flat().map((item) => item.id).join(',') === '1,2,3,4',
    'batching must preserve source order',
  );
});

Deno.test('a single oversized message is segmented instead of rejecting compaction', () => {
  const batches = batchCompactionTranscripts([message('oversized', 'assistant', 'x'.repeat(20_000))], 500);
  assert(batches.length > 1, 'expected hierarchical source segments');
  assert(batches.every((batch) => batch.includes('oversized')), 'segments must retain the source message identity');
  assert(batches[0].includes('segment 1/'), 'segments must carry deterministic ordering markers');
});

Deno.test('compaction projections enforce useful gain, headroom, and the hard ceiling', () => {
  const budget = {
    modelId: 'test/model',
    advertisedContextTokens: 100_000,
    contextLimitPercent: 80,
    contextLimitTokens: 80_000,
    recentTailTokens: 5_000,
    summaryOutputTokens: 2_000,
    retryDeltaTokens: 2_500,
  };
  const accepted = projectCompaction({
    budget,
    sourceTokens: 20_000,
    retainedTokens: 55_000,
    candidateTokens: 2_000,
  });
  assert(accepted.accepted && accepted.reclaimedTokens === 18_000, 'expected useful compaction');
  const rejected = projectCompaction({
    budget,
    sourceTokens: 3_000,
    retainedTokens: 75_000,
    candidateTokens: 1_000,
  });
  assert(!rejected.accepted && rejected.reason === 'insufficient_gain', 'small gains must be rejected');
  const noHeadroom = projectCompaction({
    budget,
    sourceTokens: 20_000,
    retainedTokens: 79_000,
    candidateTokens: 1_000,
  });
  assert(
    !noHeadroom.accepted && noHeadroom.reason === 'insufficient_headroom',
    'useful compression must still leave retry headroom',
  );
  const aboveHardCeiling = projectCompaction({
    budget,
    fixedTokens: 20_000,
    sourceTokens: 20_000,
    retainedTokens: 74_000,
    candidateTokens: 1_000,
  });
  assert(
    !aboveHardCeiling.accepted && aboveHardCeiling.reason === 'hard_ceiling',
    'fixed prompt and tool overhead must participate in the provider hard ceiling',
  );
});

Deno.test('the Mastra input-step hook compacts after step zero without deleting the persisted source', async () => {
  const state = new Map<string, unknown>();
  const requestContext = {
    get: (key: string) => state.get(key),
    set: (key: string, value: unknown) => state.set(key, value),
  };
  const messages = [
    message('1', 'user', 'old'),
    message('2', 'assistant', 'old answer'),
    message('3', 'user', 'retained'),
    message('4', 'assistant', 'retained answer'),
  ];
  let compactionCalls = 0;
  putThreadCompactionStepRuntime(requestContext, {
    compactIfNeeded: async () => {
      compactionCalls += 1;
      return {
        status: 'completed',
        firstRetainedMessageId: '3',
        compactedThroughMessageId: '2',
      } as ThreadCompactionRecord;
    },
  });
  const processor = new ThreadCompactionProcessor();
  const result = await processor.processInputStep({
    stepNumber: 1,
    messages,
    requestContext,
  } as never);
  assert(result?.messages?.map((item) => item.id).join(',') === '3,4', 'only the model projection should be trimmed');
  assert(messages.map((item) => item.id).join(',') === '1,2,3,4', 'the source transcript must remain unchanged');
  putThreadCompactionStepRuntime(requestContext, undefined);
  const cleared = await processor.processInputStep({
    stepNumber: 2,
    messages,
    requestContext,
  } as never);
  assert(cleared === undefined && compactionCalls === 1, 'clearing a run-scoped hook must prevent stale callbacks');
});

Deno.test('the Mastra request hook clears checkpoints between reused request contexts', () => {
  const state = new Map<string, unknown>();
  const requestContext = {
    get: (key: string) => state.get(key),
    set: (key: string, value: unknown) => state.set(key, value),
  };
  const processor = new ThreadCompactionProcessor();
  putThreadCompactionContext(requestContext, {
    checkpoint: {
      status: 'completed',
      summary: '# Objective and user intent\n\n- Continue safely.',
      generation: 1,
    } as ThreadCompactionRecord,
    budget: {
      modelId: 'test/model',
      advertisedContextTokens: 100_000,
      contextLimitPercent: 80,
      contextLimitTokens: 80_000,
      recentTailTokens: 5_000,
      summaryOutputTokens: 2_000,
      retryDeltaTokens: 2_500,
    },
  });
  const injected = processor.processLLMRequest({ prompt: [], requestContext } as never);
  assert(injected?.prompt?.length === 1, 'expected the current checkpoint to be injected');
  putThreadCompactionContext(requestContext, undefined);
  assert(
    processor.processLLMRequest({ prompt: [], requestContext } as never) === undefined,
    'clearing a checkpoint must prevent cross-run injection',
  );
});

Deno.test('compaction display markers preserve the automatic/manual trigger', () => {
  const checkpoint = {
    id: 'checkpoint-1',
    trigger: 'automatic',
    generation: 3,
    completedAt: '2026-01-01T00:00:00.000Z',
  } as ThreadCompactionRecord;
  const marker = threadCompactionDisplayMessage(checkpoint);
  assert(
    marker.parts[0]?.text === 'Context automatically compacted',
    'expected automatic display label',
  );
  assert(
    marker.metadata.weaveDisplay.trigger === 'automatic',
    'expected persisted trigger metadata',
  );
});
