import type { MastraDBMessage } from '@mastra/core/agent';
import { MastraAgentService } from './service.ts';
import { AgentRunCoordinator } from './run-coordinator.ts';
import type { ThreadCompactionRecord } from './thread-compaction-repository.ts';
import { normalizeCheckpoint } from './thread-compaction.ts';
import { __modelOptionsTest } from './model-options.ts';

const summary = [
  '# Objective and user intent',
  '# Decisions and constraints',
  '# Completed outcomes',
  '# Current repository and runtime state',
  '# Validation state',
  '# Remaining work and blockers',
  '# Important identifiers and references',
  '# Failures and work not to repeat',
].join('\n\n');

const persistedMessage = (id: number, role: MastraDBMessage['role'], text: string): MastraDBMessage => ({
  id: String(id),
  role,
  createdAt: new Date(`2026-01-01T00:00:${String(id).padStart(2, '0')}Z`),
  content: { format: 2, parts: [{ type: 'text', text }] },
  threadId: 'thread-1',
  resourceId: 'resource-1',
} as MastraDBMessage);

Deno.test('manual compaction uses Luna with medium reasoning and leaves the transcript intact', async () => {
  const previousFlag = Deno.env.get('WEAVE_THREAD_COMPACTION');
  const previousOptions = Deno.env.get('WEAVE_MODEL_OPTIONS');
  const previousCompactionModel = Deno.env.get('WEAVE_COMPACTION_MODEL');
  const previousV2Mode = Deno.env.get('WEAVE_COMPACTION_V2_MODE');
  Deno.env.set('WEAVE_THREAD_COMPACTION', 'true');
  Deno.env.set('WEAVE_COMPACTION_MODEL', 'openai/gpt-5.6-luna');
  Deno.env.set('WEAVE_COMPACTION_V2_MODE', 'legacy');
  Deno.env.set(
    'WEAVE_MODEL_OPTIONS',
    JSON.stringify([
      { id: 'test/conversation', contextWindow: 1_000 },
      { id: 'openai/gpt-5.6-luna' },
    ]),
  );
  __modelOptionsTest.clearCache();

  const messages = [
    persistedMessage(1, 'user', 'A'.repeat(120)),
    persistedMessage(2, 'assistant', 'B'.repeat(120)),
    persistedMessage(3, 'user', 'C'.repeat(120)),
    persistedMessage(4, 'assistant', 'D'.repeat(120)),
    persistedMessage(5, 'user', 'E'.repeat(120)),
    persistedMessage(6, 'assistant', 'F'.repeat(120)),
  ];
  let checkpoint: ThreadCompactionRecord | undefined;
  let capturedOptions: Record<string, unknown> | undefined;
  const memory = {
    getThreadById: async () => ({ id: 'thread-1', resourceId: 'resource-1' }),
    recall: async () => ({ messages: [...messages], total: messages.length }),
  };
  const repository = {
    latest: async (_resourceId: string, _threadId: string, completedOnly = true) =>
      !checkpoint || (completedOnly && checkpoint.status !== 'completed') ? undefined : checkpoint,
    completed: async () => checkpoint?.status === 'completed' ? [checkpoint] : [],
    begin: async (input: any) => {
      checkpoint = {
        id: 'compaction-1',
        resourceId: input.resourceId,
        threadId: input.threadId,
        generation: 1,
        trigger: input.trigger,
        status: 'running',
        compactionMode: input.compactionMode,
        conversationModel: input.conversationBudget.modelId,
        compactionModel: input.compactionModel,
        reasoningEffort: input.reasoningEffort,
        advertisedContextTokens: input.conversationBudget.advertisedContextTokens,
        contextLimitPercent: input.conversationBudget.contextLimitPercent,
        contextLimitTokens: input.conversationBudget.contextLimitTokens,
        recentTailTokens: input.conversationBudget.recentTailTokens,
        retryDeltaTokens: input.conversationBudget.retryDeltaTokens,
        compactionAdvertisedContextTokens: input.compactionBudget.advertisedContextTokens,
        compactionContextLimitTokens: input.compactionBudget.contextLimitTokens,
        summaryOutputTokens: input.compactionBudget.summaryOutputTokens,
        sourceTokens: input.sourceTokens,
        startedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return checkpoint;
    },
    complete: async (_id: string, result: any) => {
      checkpoint = { ...checkpoint!, ...result, status: 'completed', completedAt: new Date().toISOString() };
    },
    fail: async () => undefined,
    deleteThread: async () => undefined,
  };
  const service = new MastraAgentService(
    {
      getAgent: async (id: string) =>
        id === 'mageHandAgent' ? { getMemory: async () => memory } : {
          stream: async (_prompt: unknown, options: Record<string, unknown>) => {
            capturedOptions = options;
            return { text: Promise.resolve(summary) };
          },
        },
    } as any,
    new AgentRunCoordinator({ subscribeContextUsage: () => () => undefined }),
    async () => new ReadableStream() as never,
    async () => ({
      agentFiles: [],
      config: { instructions: '', model: 'test/conversation', reasoningEffort: 'medium', memory: {} },
    }),
    {} as any,
    repository as any,
    {
      get: async () => undefined,
      latest: async () => undefined,
      events: async () => [],
    } as any,
  );

  try {
    const result = await service.compactChatThread({
      resourceId: 'resource-1',
      threadId: 'thread-1',
      model: 'test/conversation',
    });
    if (result.status !== 'completed') throw new Error('expected completed compaction');
    const scopedModel = (capturedOptions?.model as any)?.[0];
    if (scopedModel?.model !== 'chatgpt/codex/gpt-5.6-luna') throw new Error('expected Luna gateway model');
    if ((capturedOptions?.providerOptions as any)?.openai?.reasoningEffort !== 'medium') {
      throw new Error('expected medium compaction reasoning');
    }
    if (scopedModel?.headers?.['x-weave-credential-owner-id'] !== 'resource-1') {
      throw new Error('expected owner-scoped compaction credentials');
    }
    if (capturedOptions?.toolChoice !== 'none') throw new Error('expected tool-free compaction request');
    if (capturedOptions?.maxOutputTokens !== 7_440) throw new Error('expected Luna-relative output allowance');
    if (messages.length !== 6) throw new Error('durable transcript was mutated');
    if (checkpoint?.checkpoint?.producer !== 'legacy_normalized') {
      throw new Error('legacy summaries must retain provenance for the first active V2 rebuild');
    }
    if (checkpoint.compactionMode !== 'rebuild') throw new Error('the first legacy checkpoint should be a rebuild');
  } finally {
    if (previousFlag === undefined) Deno.env.delete('WEAVE_THREAD_COMPACTION');
    else Deno.env.set('WEAVE_THREAD_COMPACTION', previousFlag);
    if (previousOptions === undefined) Deno.env.delete('WEAVE_MODEL_OPTIONS');
    else Deno.env.set('WEAVE_MODEL_OPTIONS', previousOptions);
    if (previousCompactionModel === undefined) Deno.env.delete('WEAVE_COMPACTION_MODEL');
    else Deno.env.set('WEAVE_COMPACTION_MODEL', previousCompactionModel);
    if (previousV2Mode === undefined) Deno.env.delete('WEAVE_COMPACTION_V2_MODE');
    else Deno.env.set('WEAVE_COMPACTION_V2_MODE', previousV2Mode);
    __modelOptionsTest.clearCache();
  }
});

Deno.test('active V2 compaction persists structured JSON and true projection metrics', async () => {
  const previousFlag = Deno.env.get('WEAVE_THREAD_COMPACTION');
  const previousOptions = Deno.env.get('WEAVE_MODEL_OPTIONS');
  const previousMode = Deno.env.get('WEAVE_COMPACTION_V2_MODE');
  Deno.env.set('WEAVE_THREAD_COMPACTION', 'true');
  Deno.env.set('WEAVE_COMPACTION_V2_MODE', 'active');
  Deno.env.set(
    'WEAVE_MODEL_OPTIONS',
    JSON.stringify([
      { id: 'test/conversation', contextWindow: 10_000 },
      { id: 'openai/gpt-5.6-luna' },
    ]),
  );
  __modelOptionsTest.clearCache();

  const messages = Array.from(
    { length: 10 },
    (_, index) => persistedMessage(index + 1, index % 2 === 0 ? 'user' : 'assistant', String(index).repeat(2_000)),
  );
  let record: ThreadCompactionRecord | undefined = {
    id: 'legacy-checkpoint',
    resourceId: 'resource-1',
    threadId: 'thread-1',
    generation: 1,
    trigger: 'automatic',
    status: 'completed',
    summary,
    checkpoint: normalizeCheckpoint(undefined, summary),
    compactedMessageCount: 4,
  } as ThreadCompactionRecord;
  let structuredOutput: unknown;
  let rejectCandidate = false;
  const memory = {
    getThreadById: async () => ({ id: 'thread-1', resourceId: 'resource-1' }),
    recall: async () => ({ messages: [...messages], total: messages.length }),
  };
  const repository = {
    latest: async (_resourceId: string, _threadId: string, completedOnly = true) =>
      !record || (completedOnly && record.status !== 'completed') ? undefined : record,
    completed: async () => record?.status === 'completed' ? [record] : [],
    begin: async (input: any) => {
      const now = new Date().toISOString();
      record = {
        id: 'compaction-v2',
        resourceId: input.resourceId,
        threadId: input.threadId,
        generation: 1,
        trigger: input.trigger,
        status: 'running',
        compactionMode: input.compactionMode,
        conversationModel: input.conversationBudget.modelId,
        compactionModel: input.compactionModel,
        reasoningEffort: input.reasoningEffort,
        advertisedContextTokens: input.conversationBudget.advertisedContextTokens,
        contextLimitPercent: input.conversationBudget.contextLimitPercent,
        contextLimitTokens: input.conversationBudget.contextLimitTokens,
        recentTailTokens: input.conversationBudget.recentTailTokens,
        retryDeltaTokens: input.conversationBudget.retryDeltaTokens,
        compactionAdvertisedContextTokens: input.compactionBudget.advertisedContextTokens,
        compactionContextLimitTokens: input.compactionBudget.contextLimitTokens,
        summaryOutputTokens: input.compactionBudget.summaryOutputTokens,
        sourceTokens: input.sourceTokens,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      return record;
    },
    complete: async (_id: string, result: any) => {
      record = { ...record!, ...result, status: 'completed', completedAt: new Date().toISOString() };
    },
    reject: async (_id: string, result: any) => {
      record = {
        ...record!,
        status: 'rejected',
        decisionReason: result.reason,
        projectionBeforeTokens: result.projectionBeforeTokens,
        projectionAfterTokens: result.projectionAfterTokens,
        reclaimedTokens: result.reclaimedTokens,
        updatedAt: new Date().toISOString(),
      };
    },
    fail: async () => undefined,
    deleteThread: async () => undefined,
  };
  const service = new MastraAgentService(
    {
      getAgent: async (id: string) =>
        id === 'mageHandAgent' ? { getMemory: async () => memory } : {
          generate: async (_prompt: unknown, options: Record<string, unknown>) => {
            structuredOutput = options.structuredOutput;
            return {
              object: {
                version: 2,
                objectiveAndIntent: [rejectCandidate ? 'X'.repeat(14_000) : 'Implement durable compaction.'],
                decisionsAndConstraints: ['Preserve the raw transcript.'],
                completedOutcomes: [],
                repositoryAndRuntimeState: ['Compaction V2 is active.'],
                validationState: ['Focused test running.'],
                remainingWorkAndBlockers: [],
                importantReferences: [{ kind: 'thread', value: 'thread-1', context: 'active' }],
                failuresToAvoid: ['Do not duplicate messages.'],
                attachments: [],
                lineageDepth: 0,
              },
            };
          },
        },
    } as any,
    new AgentRunCoordinator({ subscribeContextUsage: () => () => undefined }),
    async () => new ReadableStream() as never,
    async () => ({
      agentFiles: [],
      config: { instructions: '', model: 'test/conversation', reasoningEffort: 'medium', memory: {} },
    }),
    {} as any,
    repository as any,
  );

  try {
    const result = await service.compactChatThread({
      resourceId: 'resource-1',
      threadId: 'thread-1',
      model: 'test/conversation',
    });
    if (result.status !== 'completed') throw new Error(`expected completed V2 compaction, got ${result.status}`);
    if (record?.checkpoint?.version !== 2) throw new Error('expected structured checkpoint JSON');
    if (record.compactionMode !== 'rebuild') {
      throw new Error('the first active V2 checkpoint must rebuild legacy state');
    }
    if (!record.projectionBeforeTokens || !record.projectionAfterTokens || !record.reclaimedTokens) {
      throw new Error('expected complete projection metrics');
    }
    if (record.projectionBeforeTokens <= record.projectionAfterTokens) {
      throw new Error('expected useful token reclamation');
    }
    if (!structuredOutput) throw new Error('expected Mastra structured output');
    if (messages.length !== 10) throw new Error('durable transcript was mutated');

    rejectCandidate = true;
    messages.push(
      persistedMessage(11, 'user', 'N'.repeat(2_000)),
      persistedMessage(12, 'assistant', 'O'.repeat(2_000)),
      persistedMessage(13, 'user', 'P'.repeat(2_000)),
      persistedMessage(14, 'assistant', 'Q'.repeat(2_000)),
    );
    const events: any[] = [];
    const rejected = await service.compactChatThread({
      resourceId: 'resource-1',
      threadId: 'thread-1',
      model: 'test/conversation',
      onEvent: (event) => events.push(event),
    });
    if (rejected.status !== 'rejected' || !rejected.reason || record?.status !== 'rejected') {
      throw new Error(`expected rejected V2 candidate, got ${JSON.stringify(rejected)}`);
    }
    if (events.map((event) => event.data.phase).join(',') !== 'started,rejected') {
      throw new Error(`expected stable rejection events, got ${JSON.stringify(events)}`);
    }
    if (events[0]?.data.compactionId !== events[1]?.data.compactionId) {
      throw new Error('compaction lifecycle events must share one stable id');
    }
  } finally {
    if (previousFlag === undefined) Deno.env.delete('WEAVE_THREAD_COMPACTION');
    else Deno.env.set('WEAVE_THREAD_COMPACTION', previousFlag);
    if (previousOptions === undefined) Deno.env.delete('WEAVE_MODEL_OPTIONS');
    else Deno.env.set('WEAVE_MODEL_OPTIONS', previousOptions);
    if (previousMode === undefined) Deno.env.delete('WEAVE_COMPACTION_V2_MODE');
    else Deno.env.set('WEAVE_COMPACTION_V2_MODE', previousMode);
    __modelOptionsTest.clearCache();
  }
});

Deno.test('threaded start returns a durable run before automatic compaction and duplicate request ids reuse it', async () => {
  const previousFlag = Deno.env.get('WEAVE_THREAD_COMPACTION');
  const previousOptions = Deno.env.get('WEAVE_MODEL_OPTIONS');
  const previousMode = Deno.env.get('WEAVE_COMPACTION_V2_MODE');
  Deno.env.set('WEAVE_THREAD_COMPACTION', 'true');
  Deno.env.set('WEAVE_COMPACTION_V2_MODE', 'legacy');
  Deno.env.set(
    'WEAVE_MODEL_OPTIONS',
    JSON.stringify([{ id: 'test/conversation', contextWindow: 5_000 }, { id: 'openai/gpt-5.6-luna' }]),
  );
  __modelOptionsTest.clearCache();

  const messages = Array.from(
    { length: 8 },
    (_, index) => persistedMessage(index + 1, index % 2 === 0 ? 'user' : 'assistant', String(index).repeat(3_000)),
  );
  let resolveCompaction: (value: string) => void = () => undefined;
  const compactionText = new Promise<string>((resolve) => {
    resolveCompaction = resolve;
  });
  let record: ThreadCompactionRecord | undefined;
  let beginCount = 0;
  let modelStreamStarted = false;
  const memory = {
    getThreadById: async () => ({ id: 'thread-1', resourceId: 'resource-1' }),
    recall: async () => ({ messages: [...messages], total: messages.length }),
  };
  const repository = {
    latest: async (_resourceId: string, _threadId: string, completedOnly = true) =>
      !record || (completedOnly && record.status !== 'completed') ? undefined : record,
    completed: async () => record?.status === 'completed' ? [record] : [],
    begin: async (input: any) => {
      beginCount += 1;
      const now = new Date().toISOString();
      record = {
        id: 'compaction-start',
        resourceId: input.resourceId,
        threadId: input.threadId,
        generation: 1,
        trigger: input.trigger,
        status: 'running',
        compactionMode: input.compactionMode,
        conversationModel: input.conversationBudget.modelId,
        compactionModel: input.compactionModel,
        reasoningEffort: input.reasoningEffort,
        advertisedContextTokens: input.conversationBudget.advertisedContextTokens,
        contextLimitPercent: input.conversationBudget.contextLimitPercent,
        contextLimitTokens: input.conversationBudget.contextLimitTokens,
        recentTailTokens: input.conversationBudget.recentTailTokens,
        retryDeltaTokens: input.conversationBudget.retryDeltaTokens,
        compactionAdvertisedContextTokens: input.compactionBudget.advertisedContextTokens,
        compactionContextLimitTokens: input.compactionBudget.contextLimitTokens,
        summaryOutputTokens: input.compactionBudget.summaryOutputTokens,
        sourceTokens: input.sourceTokens,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      return record;
    },
    complete: async (_id: string, result: any) => {
      record = { ...record!, ...result, status: 'completed', completedAt: new Date().toISOString() };
    },
    reject: async () => undefined,
    fail: async () => undefined,
    deleteThread: async () => undefined,
  };
  const coordinator = new AgentRunCoordinator({ subscribeContextUsage: () => () => undefined });
  const service = new MastraAgentService(
    {
      getAgent: async (id: string) =>
        id === 'mageHandAgent' ? { getMemory: async () => memory } : {
          stream: async () => ({ text: compactionText }),
        },
    } as any,
    coordinator,
    async () => {
      modelStreamStarted = true;
      return new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'finish' });
          controller.close();
        },
      }) as never;
    },
    async () => ({
      agentFiles: [],
      config: { instructions: '', model: 'test/conversation', reasoningEffort: 'medium', memory: {} },
    }),
    {} as any,
    repository as any,
    {
      get: async () => undefined,
      latest: async () => undefined,
      events: async () => [],
    } as any,
  );
  const input = {
    resourceId: 'resource-1',
    threadId: 'thread-1',
    requestId: '4d83759e-e3aa-4f55-b93a-170bec7f8f9a',
    requestContext: {
      values: new Map(),
      get(key: string) {
        return this.values.get(key);
      },
      set(key: string, value: unknown) {
        this.values.set(key, value);
      },
    },
    submittedUserMessages: [{ id: 'submitted', role: 'user', parts: [{ type: 'text', text: 'continue' }] }],
    params: {
      model: 'test/conversation',
      memory: { thread: 'thread-1' },
      messages: [{ id: 'submitted', role: 'user', parts: [{ type: 'text', text: 'continue' }] }],
    },
  };

  try {
    const [started, duplicate] = await Promise.all([
      service.startChatRun(input),
      service.startChatRun(input),
    ]);
    if (started.snapshot.runId !== input.requestId || started.snapshot.phase !== 'compacting') {
      throw new Error(`expected acknowledged compacting run, got ${JSON.stringify(started.snapshot)}`);
    }
    if (modelStreamStarted) throw new Error('model stream started before compaction completed');
    if (duplicate.snapshot.runId !== started.snapshot.runId) {
      throw new Error('duplicate request created a different run');
    }
    const reorderedDuplicate = await service.startChatRun({
      ...input,
      params: {
        messages: input.params.messages,
        memory: input.params.memory,
        model: input.params.model,
      },
    });
    if (reorderedDuplicate.snapshot.runId !== started.snapshot.runId) {
      throw new Error('semantically identical request input must reuse the request id regardless of key order');
    }

    const reader = started.stream.getReader();
    const first = await reader.read();
    if ((first.value as any)?.data?.phase !== 'started') throw new Error('expected replayable compaction start event');
    if (beginCount !== 1) throw new Error(`expected one compaction job, got ${beginCount}`);
    resolveCompaction(summary);
    const second = await reader.read();
    if ((second.value as any)?.data?.phase !== 'completed') {
      throw new Error('expected replayable compaction completion');
    }
    while (!(await reader.read()).done) {
      // Drain the model stream so the coordinator settles.
    }
    if (!modelStreamStarted) throw new Error('model stream did not start after compaction');
  } finally {
    coordinator.clearForTests();
    if (previousFlag === undefined) Deno.env.delete('WEAVE_THREAD_COMPACTION');
    else Deno.env.set('WEAVE_THREAD_COMPACTION', previousFlag);
    if (previousOptions === undefined) Deno.env.delete('WEAVE_MODEL_OPTIONS');
    else Deno.env.set('WEAVE_MODEL_OPTIONS', previousOptions);
    if (previousMode === undefined) Deno.env.delete('WEAVE_COMPACTION_V2_MODE');
    else Deno.env.set('WEAVE_COMPACTION_V2_MODE', previousMode);
    __modelOptionsTest.clearCache();
  }
});
