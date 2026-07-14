import {
  extractSuspendedAskUserRunIdsFromWorkflowSnapshots,
  hashChatSystemPrompt,
  MastraAgentService,
  threadCompactionEnabled,
} from './service.ts';
import { AgentRunCoordinator } from './run-coordinator.ts';
import type { ResolvedAgentContext } from './mastra/context/resolver.ts';
import { __modelOptionsTest } from './model-options.ts';

// Service tests that do not provide a compaction repository keep the feature
// disabled explicitly; production defaults to enabled when the variable is absent.
if (Deno.env.get('WEAVE_THREAD_COMPACTION') === undefined) {
  Deno.env.set('WEAVE_THREAD_COMPACTION', 'false');
}

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  const actualJson = JSON.stringify(stable(actual));
  const expectedJson = JSON.stringify(stable(expected));
  if (actualJson !== expectedJson) {
    throw new Error(message ?? `Expected ${actualJson} to equal ${expectedJson}`);
  }
};

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]),
  );
};

const createRequestContext = () => {
  const values = new Map<string, unknown>();
  return {
    set: (key: string, value: unknown) => values.set(key, value),
    get: (key: string) => values.get(key),
    values,
  };
};

const resolvedContext = (): ResolvedAgentContext => ({
  threadMetadata: {
    mode: 'project',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
  },
  projectKind: 'git',
  agentFiles: [{
    kind: 'agents',
    path: 'AGENTS.md',
    content: 'Project-specific agent guidance.',
  }],
  config: {
    instructions: 'base',
    model: 'openai/gpt-5.6-sol',
    reasoningEffort: 'xhigh',
    serviceTier: 'priority',
    memory: {
      semanticRecall: false,
    },
  },
});

const createCoordinator = () =>
  new AgentRunCoordinator({
    createPerf: () => undefined,
    subscribeContextUsage: () => () => undefined,
  });

const streamOf = (...chunks: unknown[]) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

Deno.test('thread compaction defaults to enabled and can be explicitly disabled', () => {
  const previous = Deno.env.get('WEAVE_THREAD_COMPACTION');
  try {
    Deno.env.delete('WEAVE_THREAD_COMPACTION');
    assertEquals(threadCompactionEnabled(), true);
    Deno.env.set('WEAVE_THREAD_COMPACTION', 'false');
    assertEquals(threadCompactionEnabled(), false);
    Deno.env.set('WEAVE_THREAD_COMPACTION', '0');
    assertEquals(threadCompactionEnabled(), false);
  } finally {
    if (previous === undefined) Deno.env.delete('WEAVE_THREAD_COMPACTION');
    else Deno.env.set('WEAVE_THREAD_COMPACTION', previous);
  }
});

Deno.test('MastraAgentService.startChatRun prepares chat model, memory, provider options, and context', async () => {
  const originalInfo = console.info;
  console.info = () => undefined;
  const requestContext = createRequestContext();
  const captured: { options?: any } = {};
  const streamHandler = async (options: any) => {
    captured.options = options;
    return streamOf({ type: 'finish' }) as any;
  };
  const coordinator = createCoordinator();
  const service = new MastraAgentService(
    {} as any,
    coordinator,
    streamHandler as any,
    async () => resolvedContext(),
  );

  try {
    const started = await service.startChatRun({
      resourceId: 'resource-1',
      threadId: 'thread-1',
      requestContext,
      abortSignal: new AbortController().signal,
      submittedUserMessages: [{ id: 'user-1', role: 'user' }],
      params: {
        model: 'openai/gpt-5.6-sol',
        providerOptions: { openai: { existing: true } },
        memory: { thread: 'thread-1' },
        system: 'Caller system',
        messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      },
    });
    await started.run?.executionPromise;

    assert(captured.options, 'expected stream handler options');
    assertEquals(captured.options.agentId, 'mage-hand');
    assertEquals(captured.options.version, 'v6');
    assertEquals(captured.options.sendReasoning, true);
    assertEquals(captured.options.defaultOptions, { maxSteps: 64 });
    assertEquals(captured.options.params.maxSteps, 64);
    assertEquals(captured.options.params.tracingOptions.metadata.harness, 'weave-mastra-v1');
    assertEquals(captured.options.params.tracingOptions.metadata.executionProfile, 'workspace');
    assertEquals(captured.options.params.tracingOptions.metadata.threadId, 'thread-1');
    assertEquals(captured.options.params.tracingOptions.tags, ['weave-coding-agent', 'execution:workspace']);
    assertEquals(captured.options.params.model, [{
      model: 'chatgpt/codex/gpt-5.6-sol',
      headers: { 'x-weave-credential-owner-id': 'resource-1' },
    }]);
    assertEquals(captured.options.params.providerOptions.openai, {
      existing: true,
      reasoningEffort: 'xhigh',
      serviceTier: 'priority',
    });
    assertEquals(captured.options.params.providerOptions.mastraContextUsage, {
      threadId: 'thread-1',
      resourceId: 'resource-1',
      modelId: 'openai/gpt-5.6-sol',
      advertisedContextTokens: 372_000,
      contextLimitPercent: 80,
      maxTokens: 297_600,
    });
    assertEquals(captured.options.params.memory.thread, 'thread-1');
    assertEquals(captured.options.params.memory.resource, 'resource-1');
    assert(typeof captured.options.params.runId === 'string', 'expected generated Mastra run id');
    assert(
      captured.options.params.memory.options && typeof captured.options.params.memory.options === 'object',
      'expected memory options',
    );
    assert(String(captured.options.params.system).includes('# Git Project Coding Agent'), 'expected git instructions');
    assert(
      String(captured.options.params.system).includes('Project-specific agent guidance.'),
      'expected agent file instructions',
    );
    assert(String(captured.options.params.system).includes('Caller system'), 'expected caller system');
    assertEquals(requestContext.get('gitWorkspace'), true);
    assertEquals(requestContext.get('gitProject'), true);
    assert(requestContext.values.has('weave.agentContext'), 'expected resolved context on request context');
  } finally {
    coordinator.clearForTests();
    console.info = originalInfo;
  }
});

Deno.test('chat system prompt hashing accepts absent plain-thread system content', () => {
  const first = hashChatSystemPrompt(undefined);
  assert(typeof first === 'string' && first.length === 12, 'expected a short stable prompt hash');
  assertEquals(first, hashChatSystemPrompt(undefined));
});

Deno.test('extractSuspendedAskUserRunIdsFromWorkflowSnapshots maps current ask_user payloads only', () => {
  assertEquals(
    extractSuspendedAskUserRunIdsFromWorkflowSnapshots([
      {
        run_id: 'mastra-run-1',
        snapshot: JSON.stringify({
          context: {
            toolCallStep: {
              payload: [
                { toolName: 'ask_user', toolCallId: 'ask-1' },
                { toolName: 'read', toolCallId: 'read-1' },
              ],
            },
            messageList: {
              messages: [
                {
                  content: {
                    parts: [
                      { toolName: 'ask_user', toolCallId: 'copied-old-ask' },
                    ],
                  },
                },
              ],
            },
          },
        }),
      },
      {
        run_id: 'older-mastra-run',
        snapshot: {
          context: {
            toolCallStep: {
              payload: [{ toolName: 'ask_user', toolCallId: 'ask-1' }],
            },
          },
        },
      },
    ]),
    { 'ask-1': 'mastra-run-1' },
  );
});

Deno.test('MastraAgentService.startChatRun uses coordinator abort signal for threaded runs and request signal for unthreaded runs', async () => {
  const originalInfo = console.info;
  console.info = () => undefined;
  const threadedRequestAbort = new AbortController();
  const unthreadedRequestAbort = new AbortController();
  const capturedSignals: unknown[] = [];
  const streamHandler = async (options: any) => {
    capturedSignals.push(options.params.abortSignal);
    return streamOf({ type: 'finish' }) as any;
  };
  const coordinator = createCoordinator();
  const service = new MastraAgentService(
    {} as any,
    coordinator,
    streamHandler as any,
    async () => resolvedContext(),
  );

  try {
    await service.startChatRun({
      resourceId: 'resource-1',
      threadId: 'thread-1',
      requestContext: createRequestContext(),
      abortSignal: threadedRequestAbort.signal,
      params: { messages: [], memory: { thread: 'thread-1' } },
    });
    await service.startChatRun({
      resourceId: 'resource-1',
      requestContext: createRequestContext(),
      abortSignal: unthreadedRequestAbort.signal,
      params: { messages: [] },
    });

    assert(capturedSignals[0] instanceof AbortSignal, 'expected threaded abort signal');
    assert(capturedSignals[0] !== threadedRequestAbort.signal, 'threaded run should use coordinator abort signal');
    assertEquals(capturedSignals[1], unthreadedRequestAbort.signal);
  } finally {
    coordinator.clearForTests();
    console.info = originalInfo;
  }
});

Deno.test('MastraAgentService.sendChatMessage preserves active delivery and idle discard options', async () => {
  let capturedMessage: unknown;
  let capturedOptions: unknown;
  const service = new MastraAgentService(
    {
      getAgent: async () => ({
        sendMessage: (message: unknown, options: unknown) => {
          capturedMessage = message;
          capturedOptions = options;
          return {
            accepted: true,
            runId: 'mastra-run-1',
            signal: { id: 'signal-1' },
          };
        },
      }),
    } as any,
    createCoordinator(),
    async () => streamOf() as any,
    async () => resolvedContext(),
  );

  const result = await service.sendChatMessage({
    resourceId: 'resource-1',
    threadId: 'thread-1',
    message: { contents: [{ type: 'text', text: 'steer' }] } as any,
  });

  assertEquals(capturedMessage, { contents: [{ type: 'text', text: 'steer' }] });
  assertEquals(capturedOptions, {
    resourceId: 'resource-1',
    threadId: 'thread-1',
    ifActive: {
      behavior: 'deliver',
      attributes: {
        source: 'composer',
        delivery: 'while-active',
      },
    },
    ifIdle: { behavior: 'discard' },
  });
  assertEquals(result, {
    accepted: true,
    runId: 'mastra-run-1',
    messageId: 'signal-1',
  });
});

Deno.test('MastraAgentService.sendChatMessage rejects stale guarded thread runs before Mastra delivery', async () => {
  let getAgentCalled = false;
  const service = new MastraAgentService(
    {
      getAgent: async () => {
        getAgentCalled = true;
        return undefined;
      },
    } as any,
    createCoordinator(),
    async () => streamOf() as any,
    async () => resolvedContext(),
  );

  const result = await service.sendChatMessage({
    resourceId: 'resource-1',
    threadId: 'thread-1',
    activeThreadRunId: 'run-1',
    message: { contents: [{ type: 'text', text: 'steer' }] } as any,
  });

  assertEquals(result, {
    accepted: false,
    reason: 'stale_run',
  });
  assertEquals(getAgentCalled, false);
});

Deno.test('MastraAgentService.runPrompt invokes Mastra without chat thread semantics', async () => {
  let capturedAgentId: unknown;
  let capturedMessages: unknown;
  let capturedOptions: unknown;
  const service = new MastraAgentService(
    {
      getAgent: async (agentId: unknown) => {
        capturedAgentId = agentId;
        return {
          generate: async (messages: unknown, options: unknown) => {
            capturedMessages = messages;
            capturedOptions = options;
            return {
              runId: 'mastra-run-1',
              text: 'Prompt result',
              finishReason: 'stop',
              usage: { totalTokens: 12 },
            };
          },
        };
      },
    } as any,
    createCoordinator(),
    async () => streamOf() as any,
    async () => resolvedContext(),
  );

  const result = await service.runPrompt({
    caller: { kind: 'workflow', ownerId: 'owner-1', correlation: { workflowRunId: 'workflow-run-1' } },
    input: { prompt: 'Summarize this' },
    model: 'openai/gpt-5.5',
    maxSteps: 3,
    memory: { scope: 'workflow', workflowRunId: 'workflow-run-1' },
  });

  assertEquals(capturedAgentId, 'mageHandAgent');
  assertEquals(capturedMessages, 'Summarize this');
  assertEquals(capturedOptions, {
    model: 'openai/gpt-5.5',
    maxSteps: 3,
    memory: { thread: '__workflow__workflow-run-1', resource: 'owner-1' },
  });
  assertEquals(result, {
    finishReason: 'stop',
    runId: 'mastra-run-1',
    text: 'Prompt result',
    usage: { totalTokens: 12 },
  });
});

Deno.test('MastraAgentService.startRun tracks product-neutral lifecycle and stream replay', async () => {
  let resolveGenerate: (value: unknown) => void = () => undefined;
  const service = new MastraAgentService(
    {
      getAgent: async () => ({
        generate: (_messages: unknown, _options: unknown) =>
          new Promise((resolve) => {
            resolveGenerate = resolve;
          }),
      }),
    } as any,
    createCoordinator(),
    async () => streamOf() as any,
    async () => resolvedContext(),
  );

  const snapshot = await service.startRun({
    caller: { kind: 'workflow', ownerId: 'owner-1', correlation: { workflowRunId: 'workflow-run-1' } },
    input: 'Run this prompt',
    memory: { scope: 'none' },
  });
  assertEquals(snapshot.status, 'running');
  assertEquals(snapshot.agentId, 'mage-hand');

  const reader = service.streamRun(snapshot.runId).getReader();
  const start = await reader.read();
  assertEquals((start.value as any)?.type, 'start');

  resolveGenerate({ runId: 'mastra-run-2', text: 'Done', finishReason: 'stop' });
  const finish = await reader.read();
  const closed = await reader.read();
  await reader.cancel();

  assertEquals((finish.value as any)?.type, 'finish');
  assertEquals((finish.value as any)?.result, { finishReason: 'stop', runId: 'mastra-run-2', text: 'Done' });
  assertEquals(closed.done, true);
  const completed = await service.getRun(snapshot.runId);
  assertEquals(completed?.status, 'completed');
  assertEquals(completed?.result, { finishReason: 'stop', runId: 'mastra-run-2', text: 'Done' });
});

Deno.test('MastraAgentService.cancelRun aborts product-neutral runs', async () => {
  let capturedSignal: AbortSignal | undefined;
  const service = new MastraAgentService(
    {
      getAgent: async () => ({
        generate: (_messages: unknown, options: { abortSignal?: AbortSignal }) => {
          capturedSignal = options.abortSignal;
          return new Promise((_resolve, reject) => {
            options.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        },
      }),
    } as any,
    createCoordinator(),
    async () => streamOf() as any,
    async () => resolvedContext(),
  );

  const snapshot = await service.startRun({
    caller: { kind: 'workflow', ownerId: 'owner-1', correlation: { workflowRunId: 'workflow-run-1' } },
    input: 'Run this prompt',
    memory: { scope: 'none' },
  });
  assert(capturedSignal, 'expected generate abort signal');

  const cancelled = await service.cancelRun(snapshot.runId);
  assertEquals(cancelled?.status, 'cancelled');
  assertEquals(capturedSignal?.aborted, true);
  assertEquals((await service.getRun(snapshot.runId))?.status, 'cancelled');
});

Deno.test('MastraAgentService.listModels exposes the shared model config contract', async () => {
  __modelOptionsTest.clearCache();
  const originalFetch = globalThis.fetch;
  const originalDefault = Deno.env.get('WEAVE_DEFAULT_MODEL');
  const originalOptions = Deno.env.get('WEAVE_MODEL_OPTIONS');
  globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch;
  Deno.env.set('WEAVE_DEFAULT_MODEL', 'openai/gpt-5.4');
  Deno.env.set('WEAVE_MODEL_OPTIONS', JSON.stringify([{ id: 'openai/gpt-5.4', label: 'GPT Custom' }]));
  const service = new MastraAgentService({} as any, createCoordinator(), async () => streamOf() as any);

  try {
    assertEquals(await service.listModels(), {
      defaultModel: 'openai/gpt-5.4',
      options: [{
        id: 'openai/gpt-5.4',
        label: 'GPT Custom',
        providerId: 'openai',
        providerLogoUrl: 'https://models.dev/logos/openai.svg',
        providerName: 'OpenAI',
        supportedReasoningEfforts: [
          { effort: 'low', label: 'Low', description: 'Fast responses with lighter reasoning' },
          {
            effort: 'medium',
            label: 'Medium',
            description: 'Balances speed and reasoning depth for everyday tasks',
          },
          { effort: 'high', label: 'High', description: 'Greater reasoning depth for complex problems' },
          { effort: 'xhigh', label: 'Extra High', description: 'Extra high reasoning depth for complex problems' },
        ],
        defaultReasoningEffort: 'medium',
        serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }],
        defaultServiceTier: null,
      }],
    });
  } finally {
    __modelOptionsTest.clearCache();
    globalThis.fetch = originalFetch;
    if (originalDefault === undefined) Deno.env.delete('WEAVE_DEFAULT_MODEL');
    else Deno.env.set('WEAVE_DEFAULT_MODEL', originalDefault);
    if (originalOptions === undefined) Deno.env.delete('WEAVE_MODEL_OPTIONS');
    else Deno.env.set('WEAVE_MODEL_OPTIONS', originalOptions);
  }
});

Deno.test('MastraAgentService.listModels defaults to Sol with GPT-5.6 subscription metadata', async () => {
  __modelOptionsTest.clearCache();
  const originalFetch = globalThis.fetch;
  const originalDefault = Deno.env.get('WEAVE_DEFAULT_MODEL');
  const originalOptions = Deno.env.get('WEAVE_MODEL_OPTIONS');
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          openai: {
            name: 'OpenAI',
            models: {
              'gpt-5.6-sol': { name: 'GPT-5.6 Sol', limit: { context: 1_050_000 } },
              'gpt-5.6-terra': { name: 'GPT-5.6 Terra', limit: { context: 1_050_000 } },
              'gpt-5.6-luna': { name: 'GPT-5.6 Luna', limit: { context: 1_050_000 } },
              'gpt-5.5': { name: 'GPT-5.5', limit: { context: 1_050_000 } },
            },
          },
        }),
        { status: 200 },
      ),
    )) as typeof fetch;
  Deno.env.delete('WEAVE_DEFAULT_MODEL');
  Deno.env.delete('WEAVE_MODEL_OPTIONS');
  const service = new MastraAgentService({} as any, createCoordinator(), async () => streamOf() as any);

  try {
    const config = await service.listModels();
    assertEquals(config.defaultModel, 'openai/gpt-5.6-sol');
    assertEquals(
      config.options.map((option) => option.id),
      [
        'openai/gpt-5.6-sol',
        'openai/gpt-5.6-terra',
        'openai/gpt-5.6-luna',
        'openai/gpt-5.5',
      ],
    );

    for (const option of config.options.slice(0, 3)) {
      assertEquals(option.contextWindow, 372_000);
      assertEquals(option.supportedReasoningEfforts?.map((effort) => effort.effort), [
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
      assertEquals(option.defaultReasoningEffort, 'medium');
      assertEquals(option.serviceTiers?.map((tier) => tier.id), ['priority']);
    }
    assertEquals(config.options[0]?.label, 'OpenAI/GPT-5.6 Sol');
  } finally {
    __modelOptionsTest.clearCache();
    globalThis.fetch = originalFetch;
    if (originalDefault === undefined) Deno.env.delete('WEAVE_DEFAULT_MODEL');
    else Deno.env.set('WEAVE_DEFAULT_MODEL', originalDefault);
    if (originalOptions === undefined) Deno.env.delete('WEAVE_MODEL_OPTIONS');
    else Deno.env.set('WEAVE_MODEL_OPTIONS', originalOptions);
  }
});

Deno.test('MastraAgentService chat thread state methods keep memory access behind service', async () => {
  const threadMessages = [{
    id: 'message-1',
    role: 'assistant',
    content: {
      parts: [{
        type: 'tool-rename-thread',
        result: { title: 'Renamed from tool output' },
      }],
      metadata: {},
    },
  }];
  const threads = [
    {
      id: 'thread-1',
      title: '...',
      resourceId: 'resource-1',
      updatedAt: '2026-07-02T10:00:00.000Z',
      metadata: { mode: 'plain', sortOrder: 1 },
    },
    {
      id: 'thread-2',
      title: 'Ready',
      resourceId: 'resource-1',
      updatedAt: '2026-07-02T10:01:00.000Z',
      metadata: { mode: 'plain', sortOrder: 0 },
    },
    {
      id: '__project__hidden',
      title: 'Hidden',
      resourceId: 'resource-1',
      updatedAt: '2026-07-02T10:02:00.000Z',
      metadata: {},
    },
  ];
  const updates: unknown[] = [];
  const memory = {
    MAX_CONTEXT_TOKENS: 1000,
    listThreads: async (options: any) => ({
      threads: threads.filter((thread) => thread.resourceId === options.filter.resourceId),
    }),
    recall: async (options: any) => ({
      messages: options.threadId === 'thread-1' ? threadMessages : [],
    }),
    createThread: async (options: any) => ({
      id: options.threadId,
      title: options.title,
      resourceId: options.resourceId,
      metadata: options.metadata,
    }),
    updateThread: async (options: any) => {
      updates.push(options);
      return {
        id: options.id,
        title: options.title,
        resourceId: 'resource-1',
        metadata: options.metadata,
      };
    },
    getThreadById: async (options: any) => threads.find((thread) => thread.id === options.threadId),
    deleteThread: async (threadId: string) => updates.push({ deleteThread: threadId }),
    estimateTokens: (text: string) => text.length,
    getContext: async () => ({
      systemMessage: 'system',
      messages: threadMessages,
    }),
  };
  const service = new MastraAgentService(
    {
      getAgent: async () => ({
        getMemory: async () => memory,
      }),
    } as any,
    createCoordinator(),
    async () => streamOf() as any,
    async () => resolvedContext(),
  );

  const listed = await service.listChatThreads({ resourceId: 'resource-1' });
  assertEquals(listed.map((thread) => ({ id: thread.id, title: thread.title })), [
    { id: 'thread-2', title: 'Ready' },
    { id: 'thread-1', title: 'Renamed from tool output' },
  ]);

  const created = await service.createChatThread({
    resourceId: 'resource-1',
    threadId: 'thread-new',
    title: 'New',
  });
  assertEquals(created, {
    id: 'thread-new',
    title: 'New',
    resourceId: 'resource-1',
    metadata: { mode: 'plain', sortOrder: -1 },
  });

  await service.reorderChatThreads({
    resourceId: 'resource-1',
    threadIds: ['thread-2', 'thread-1'],
    scope: { plain: true },
  });
  assertEquals(updates.slice(0, 2), [
    { id: 'thread-2', title: 'Ready', metadata: { mode: 'plain', sortOrder: 0 } },
    { id: 'thread-1', title: '...', metadata: { mode: 'plain', sortOrder: 1 } },
  ]);

  assertEquals(
    await service.getChatThreadRawMessages({ resourceId: 'resource-1', threadId: 'thread-1' }),
    threadMessages,
  );

  const usage = await service.getChatThreadContextUsage({
    resourceId: 'resource-1',
    threadId: 'thread-1',
    modelId: 'openai/gpt-5.6-luna',
  });
  assertEquals(usage.contextWindow, 372_000);
  assertEquals(usage.contextLimitTokens, 297_600);
  assertEquals(usage.source, 'estimate');
  assert(usage.tokens > 0, 'expected token estimate');

  const updated = await service.updateChatThread({
    resourceId: 'resource-1',
    threadId: 'thread-1',
    title: 'Updated',
    archived: true,
  });
  assertEquals(updated, {
    id: 'thread-1',
    title: 'Updated',
    resourceId: 'resource-1',
    metadata: { mode: 'plain', sortOrder: 1, archived: true },
  });

  await service.deleteChatThread({ resourceId: 'resource-1', threadId: 'thread-1' });
  assertEquals(updates[updates.length - 1], { deleteThread: 'thread-1' });
});
