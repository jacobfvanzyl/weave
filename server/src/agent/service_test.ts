import { MastraAgentService } from './service.ts';
import { AgentRunCoordinator } from './run-coordinator.ts';
import type { ResolvedAgentContext } from './mastra/context/resolver.ts';

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
    model: 'openai/gpt-5.5',
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
    await service.startChatRun({
      resourceId: 'resource-1',
      threadId: 'thread-1',
      requestContext,
      abortSignal: new AbortController().signal,
      submittedUserMessages: [{ id: 'user-1', role: 'user' }],
      params: {
        model: 'openai/gpt-5.5',
        providerOptions: { openai: { existing: true } },
        memory: { thread: 'thread-1' },
        system: 'Caller system',
        messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      },
    });

    assert(captured.options, 'expected stream handler options');
    assertEquals(captured.options.agentId, 'mage-hand');
    assertEquals(captured.options.version, 'v6');
    assertEquals(captured.options.sendReasoning, true);
    assertEquals(captured.options.defaultOptions, { maxSteps: 1000 });
    assertEquals(captured.options.params.model, 'chatgpt/codex/gpt-5.5');
    assertEquals(captured.options.params.providerOptions.openai, {
      existing: true,
      reasoningEffort: 'xhigh',
      serviceTier: 'priority',
    });
    assertEquals(captured.options.params.providerOptions.mastraContextUsage, {
      threadId: 'thread-1',
      resourceId: 'resource-1',
    });
    assertEquals(captured.options.params.memory.thread, 'thread-1');
    assertEquals(captured.options.params.memory.resource, 'resource-1');
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

  const usage = await service.getChatThreadContextUsage({ resourceId: 'resource-1', threadId: 'thread-1' });
  assertEquals(usage.contextWindow, 1000);
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
