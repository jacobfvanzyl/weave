import type { MastraDBMessage } from '@mastra/core/agent';
import { MastraAgentService } from './service.ts';
import { AgentRunCoordinator } from './run-coordinator.ts';
import type { ThreadCompactionRecord } from './thread-compaction-repository.ts';
import { __modelOptionsTest } from './model-options.ts';

const summary = [
  '# Objective and user intent',
  '# Decisions and constraints',
  '# Completed outcomes',
  '# Current repository and runtime state',
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
  Deno.env.set('WEAVE_THREAD_COMPACTION', 'true');
  Deno.env.set('WEAVE_COMPACTION_MODEL', 'openai/gpt-5.6-luna');
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
  );

  try {
    const result = await service.compactChatThread({
      resourceId: 'resource-1',
      threadId: 'thread-1',
      model: 'test/conversation',
    });
    if (result.status !== 'completed') throw new Error('expected completed compaction');
    if (capturedOptions?.model !== 'chatgpt/codex/gpt-5.6-luna') throw new Error('expected Luna gateway model');
    if ((capturedOptions?.providerOptions as any)?.openai?.reasoningEffort !== 'medium') {
      throw new Error('expected medium compaction reasoning');
    }
    if (capturedOptions?.toolChoice !== 'none') throw new Error('expected tool-free compaction request');
    if (capturedOptions?.maxOutputTokens !== 7_440) throw new Error('expected Luna-relative output allowance');
    if (messages.length !== 6) throw new Error('durable transcript was mutated');
  } finally {
    if (previousFlag === undefined) Deno.env.delete('WEAVE_THREAD_COMPACTION');
    else Deno.env.set('WEAVE_THREAD_COMPACTION', previousFlag);
    if (previousOptions === undefined) Deno.env.delete('WEAVE_MODEL_OPTIONS');
    else Deno.env.set('WEAVE_MODEL_OPTIONS', previousOptions);
    if (previousCompactionModel === undefined) Deno.env.delete('WEAVE_COMPACTION_MODEL');
    else Deno.env.set('WEAVE_COMPACTION_MODEL', previousCompactionModel);
    __modelOptionsTest.clearCache();
  }
});
