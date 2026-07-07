import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordThreadContextUsage } from '../../server/src/agent/mastra/context-usage';
import { __chatRunRegistryTest, createChatRoutes } from '../../server/src/modules/chat/routes/chat';
import { __chatStateContextUsageTest } from '../../server/src/modules/chat/routes/chat-state';

const routeHandler = (path: string, routes: ReturnType<typeof createChatRoutes>) => {
  const handler = routes.find((route) => route.path === path)?.handler;
  if (typeof handler !== 'function') {
    throw new Error(`route not found: ${path}`);
  }
  return handler as (c: any) => Promise<unknown>;
};

const steerRouteHandler = (routes: ReturnType<typeof createChatRoutes>) => routeHandler('/chat/runs/:threadId/steer', routes);

const chatRouteContext = (overrides: Record<string, unknown> = {}) => ({
  get: (key: string) => {
    if (key === 'requestContext') return { get: () => 'resource-1' };
    return undefined;
  },
  req: {
    param: () => 'thread-1',
    json: async () => ({}),
    raw: { signal: new AbortController().signal },
  },
  json: vi.fn((body: unknown, status?: number) => ({ body, status })),
  ...overrides,
});

describe('chat active run registry', () => {
  afterEach(() => {
    __chatRunRegistryTest.clear();
  });

  it('replays buffered chunks and continues with live chunks for late observers', async () => {
    const run = __chatRunRegistryTest.create('resource-1', 'thread-1');
    const startChunk = { type: 'text-start', id: 'msg-1' };
    const textChunk = { type: 'text-delta', id: 'msg-1', delta: 'hello' };
    const finishChunk = { type: 'finish' };

    __chatRunRegistryTest.append(run, startChunk);
    __chatRunRegistryTest.append(run, textChunk);

    const reader = __chatRunRegistryTest.observe(run).getReader();

    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: startChunk,
    });
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: textChunk,
    });

    const liveRead = reader.read();
    __chatRunRegistryTest.append(run, finishChunk);
    await expect(liveRead).resolves.toEqual({
      done: false,
      value: finishChunk,
    });

    const closedRead = reader.read();
    __chatRunRegistryTest.complete(run);
    await expect(closedRead).resolves.toEqual({ done: true, value: undefined });
  });

  it('carries run timing metadata through hydrated assistant messages', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-02T10:00:00.000Z'));
      const run = __chatRunRegistryTest.create('resource-1', 'thread-1');
      __chatRunRegistryTest.append(run, {
        type: 'start',
        messageId: 'assistant-1',
        messageMetadata: __chatRunRegistryTest.runTimingMetadata(run, 'running'),
      });
      __chatRunRegistryTest.append(run, { type: 'text-start', id: 'text-1' });
      __chatRunRegistryTest.append(run, {
        type: 'text-delta',
        id: 'text-1',
        delta: 'Done.',
      });

      vi.setSystemTime(new Date('2026-07-02T10:00:19.000Z'));
      __chatRunRegistryTest.append(run, {
        type: 'finish',
        messageMetadata: __chatRunRegistryTest.runTimingMetadata(run, 'completed'),
      });
      __chatRunRegistryTest.complete(run);

      expect(__chatRunRegistryTest.snapshot(run)).toMatchObject({
        active: false,
        status: 'completed',
        durationMs: 19_000,
      });
      expect(__chatRunRegistryTest.uiMessages('resource-1', 'thread-1')).toEqual([
        expect.objectContaining({
          id: 'assistant-1',
          metadata: {
            weaveRunTiming: {
              runId: run.runId,
              status: 'completed',
              startedAt: '2026-07-02T10:00:00.000Z',
              completedAt: '2026-07-02T10:00:19.000Z',
              durationMs: 19_000,
            },
          },
        }),
      ]);
    } finally {
      __chatRunRegistryTest.clear();
      vi.useRealTimers();
    }
  });

  it('keeps the submitted user message available for late hydration', () => {
    const submittedMessage = {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Please keep me visible.' }],
    };

    __chatRunRegistryTest.create('resource-1', 'thread-1', [submittedMessage]);

    expect(__chatRunRegistryTest.submittedUserMessages('resource-1', 'thread-1')).toEqual([submittedMessage]);
    expect(__chatRunRegistryTest.submittedUserMessages('other-resource', 'thread-1')).toEqual([]);
  });

  it('returns not_active when steering a thread without an active run', async () => {
    const routes = createChatRoutes({
      hasActiveThreadRun: () => false,
      getChatRun: () => ({ active: false, status: 'idle' }),
    } as any);
    const json = vi.fn((body: unknown, status?: number) => ({ body, status }));
    const response = await steerRouteHandler(routes)({
      get: (key: string) => (key === 'requestContext' ? { get: () => 'resource-1' } : undefined),
      req: {
        param: () => 'thread-1',
        json: async () => ({
          message: {
            id: 'user-1',
            role: 'user',
            parts: [{ type: 'text', text: 'steer' }],
          },
        }),
      },
      json,
    });

    expect(response).toEqual({
      body: {
        ok: false,
        reason: 'not_active',
        run: { active: false, status: 'idle' },
      },
      status: 409,
    });
  });

  it('returns 204 from stream endpoint when no AgentService run is active', async () => {
    const routes = createChatRoutes({
      observeChatRun: () => undefined,
    } as any);
    const response = await routeHandler('/chat/runs/:threadId/stream', routes)(chatRouteContext());

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(204);
  });

  it('returns SSE from stream endpoint when AgentService has an active run', async () => {
    const routes = createChatRoutes({
      observeChatRun: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'finish' });
            controller.close();
          },
        }),
    } as any);
    const response = (await routeHandler('/chat/runs/:threadId/stream', routes)(chatRouteContext())) as Response;

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    await expect(response.text()).resolves.toBe('data: {"type":"finish"}\n\n');
  });

  it('adapts cancel endpoint to AgentService idempotent snapshots', async () => {
    const cancelChatRun = vi.fn(() => ({
      active: false,
      status: 'cancelled',
      runId: 'run-1',
    }));
    const routes = createChatRoutes({ cancelChatRun } as any);
    const json = vi.fn((body: unknown, status?: number) => ({ body, status }));

    const response = await routeHandler('/chat/runs/:threadId/cancel', routes)(chatRouteContext({ json }));

    expect(cancelChatRun).toHaveBeenCalledWith('resource-1', 'thread-1');
    expect(response).toEqual({
      body: {
        ok: true,
        run: { active: false, status: 'cancelled', runId: 'run-1' },
      },
      status: undefined,
    });
  });

  it('returns 409 from create run endpoint when AgentService reports an active thread', async () => {
    const startChatRun = vi.fn();
    const routes = createChatRoutes({
      hasActiveThreadRun: () => true,
      startChatRun,
    } as any);
    const json = vi.fn((body: unknown, status?: number) => ({ body, status }));

    const response = await routeHandler(
      '/chat/runs',
      routes,
    )(
      chatRouteContext({
        json,
        req: {
          param: () => 'thread-1',
          raw: { signal: new AbortController().signal },
          json: async () => ({
            memory: { thread: 'thread-1' },
            messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'start' }] }],
          }),
        },
      }),
    );

    expect(startChatRun).toHaveBeenCalledTimes(0);
    expect(response).toEqual({
      body: { error: 'thread has an active stream' },
      status: 409,
    });
  });

  it('delegates create run endpoint to AgentService and returns SSE headers', async () => {
    const abortController = new AbortController();
    const startChatRun = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'finish' });
          controller.close();
        },
      }),
    }));
    const routes = createChatRoutes({
      hasActiveThreadRun: () => false,
      startChatRun,
    } as any);
    const requestContext = { get: () => 'resource-1' };
    const json = vi.fn((body: unknown, status?: number) => ({ body, status }));

    const response = (await routeHandler(
      '/chat/runs',
      routes,
    )(
      chatRouteContext({
        get: (key: string) => (key === 'requestContext' ? requestContext : undefined),
        json,
        req: {
          param: () => 'thread-1',
          raw: { signal: abortController.signal },
          json: async () => ({
            model: 'openai/gpt-5.5',
            memory: { thread: 'thread-1' },
            messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'start' }] }],
          }),
        },
      }),
    )) as Response;

    expect(startChatRun).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: 'resource-1',
        threadId: 'thread-1',
        requestContext,
        submittedUserMessages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'start' }] }],
        abortSignal: abortController.signal,
      }),
    );
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    await expect(response.text()).resolves.toBe('data: {"type":"finish"}\n\n');
  });

  it('preserves Mastra resume fields when creating a resumed chat run', async () => {
    const startChatRun = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'finish' });
          controller.close();
        },
      }),
    }));
    const routes = createChatRoutes({
      hasActiveThreadRun: () => false,
      startChatRun,
    } as any);
    const resumeData = {
      action: 'submit',
      answers: [{ id: 'scope', selectedOptionId: 'narrow', finalAnswer: 'Narrow' }],
    };

    await routeHandler(
      '/chat/runs',
      routes,
    )(
      chatRouteContext({
        req: {
          param: () => 'thread-1',
          raw: { signal: new AbortController().signal },
          json: async () => ({
            runId: 'mastra-run-1',
            toolCallId: 'ask-1',
            resumeData,
            memory: { thread: 'thread-1' },
            messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Scope: Narrow' }] }],
          }),
        },
      }),
    );

    expect(startChatRun).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          runId: 'mastra-run-1',
          toolCallId: 'ask-1',
          resumeData,
        }),
        submittedUserMessages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Scope: Narrow' }] }],
      }),
    );
  });

  it('delivers active steering messages through AgentService', async () => {
    const sendChatMessage = vi.fn(async () => ({
      accepted: true,
      runId: 'mastra-run-1',
      messageId: 'signal-1',
    }));
    const routes = createChatRoutes({
      hasActiveThreadRun: () => true,
      getChatRun: () => ({ active: true, status: 'running', runId: 'run-1' }),
      sendChatMessage,
    } as any);
    const handler = steerRouteHandler(routes);
    const json = vi.fn((body: unknown, status?: number) => ({ body, status }));

    const response = await handler({
      get: (key: string) => {
        if (key === 'requestContext') return { get: () => 'resource-1' };
        return undefined;
      },
      req: {
        param: () => 'thread-1',
        json: async () => ({
          message: {
            id: 'user-1',
            role: 'user',
            parts: [{ type: 'text', text: 'steer' }],
          },
        }),
      },
      json,
    });

    expect(sendChatMessage).toHaveBeenCalledWith({
      resourceId: 'resource-1',
      threadId: 'thread-1',
      message: { contents: [{ type: 'text', text: 'steer' }] },
    });
    expect(response).toEqual({
      body: {
        ok: true,
        accepted: true,
        runId: 'mastra-run-1',
        messageId: 'signal-1',
      },
      status: undefined,
    });
  });

  it('streams and replays transient context usage updates during active runs', async () => {
    const run = __chatRunRegistryTest.create('resource-1', 'thread-context-live');
    const textChunk = { type: 'text-delta', id: 'msg-1', delta: 'working' };
    __chatRunRegistryTest.append(run, textChunk);

    const reader = __chatRunRegistryTest.observe(run).getReader();
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: textChunk,
    });

    const contextRead = reader.read();
    recordThreadContextUsage({
      threadId: 'thread-context-live',
      resourceId: 'resource-1',
      usedTokens: 8_500,
      totalProcessedTokens: 9_100,
      inputTokens: 8_500,
      cachedInputTokens: 2_400,
      outputTokens: 600,
    });

    await expect(contextRead).resolves.toEqual({
      done: false,
      value: {
        type: 'data-context-usage',
        transient: true,
        data: {
          tokens: 8_500,
          inputTokens: 8_500,
          cachedInputTokens: 2_400,
          outputTokens: 600,
          totalProcessedTokens: 9_100,
          updatedAt: expect.any(String),
          source: 'provider',
        },
      },
    });

    const finishChunk = { type: 'finish' };
    const finishRead = reader.read();
    __chatRunRegistryTest.append(run, finishChunk);
    await expect(finishRead).resolves.toEqual({
      done: false,
      value: finishChunk,
    });

    const replayReader = __chatRunRegistryTest.observe(run).getReader();
    await expect(replayReader.read()).resolves.toEqual({
      done: false,
      value: textChunk,
    });
    await expect(replayReader.read()).resolves.toEqual({
      done: false,
      value: {
        type: 'data-context-usage',
        transient: true,
        data: {
          tokens: 8_500,
          inputTokens: 8_500,
          cachedInputTokens: 2_400,
          outputTokens: 600,
          totalProcessedTokens: 9_100,
          updatedAt: expect.any(String),
          source: 'provider',
        },
      },
    });
  });

  it('merges pending submitted messages without duplicating persisted user turns', () => {
    const pending = __chatStateContextUsageTest.toPendingSubmittedMessage(
      {
        id: 'user-1',
        role: 'user',
        metadata: { slashCommandOriginalText: '/commit current work' },
        parts: [{ type: 'text', text: 'Expanded commit prompt' }],
      },
      'http://localhost',
      0,
    );

    expect(pending).toMatchObject({
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: '/commit current work' }],
    });

    const previous = {
      id: 'old-user',
      role: 'user',
      parts: [{ type: 'text', text: 'Previous turn' }],
    };
    expect(__chatStateContextUsageTest.mergePendingSubmittedMessages([previous], pending ? [pending] : [])).toEqual([previous, pending]);

    const persistedSameTurn = {
      id: 'db-user-1',
      role: 'user',
      parts: [{ type: 'text', text: '/commit current work' }],
    };
    expect(__chatStateContextUsageTest.mergePendingSubmittedMessages([previous, persistedSameTurn], pending ? [pending] : [])).toEqual([previous, persistedSameTurn]);
  });

  it('anchors or suppresses pending ask_user response messages when merging hydrated chat state', () => {
    const assistantAsk = {
      id: 'assistant-ask',
      role: 'assistant',
      parts: [
        {
          type: 'data-ask-user',
          data: {
            mastraRunId: 'mastra-run-1',
            toolCallId: 'ask-1',
            toolName: 'ask_user',
            status: 'pending',
            questions: [
              {
                id: 'scope',
                header: 'Scope',
                question: 'How broad should this be?',
                options: [
                  { id: 'narrow', label: 'Narrow' },
                  { id: 'broad', label: 'Broad' },
                ],
              },
            ],
          },
        },
      ],
    };
    const assistantAfter = {
      id: 'assistant-after',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Continuing after the answer.' }],
    };
    const pendingAskResponse = {
      id: 'pending-answer',
      role: 'user',
      parts: [{ type: 'text', text: 'Scope: Narrow' }],
      metadata: {
        askUserResponse: {
          toolCallId: 'ask-1',
          mastraRunId: 'mastra-run-1',
          action: 'submit',
          answers: [{ id: 'scope', selectedOptionId: 'narrow', finalAnswer: 'Narrow' }],
        },
      },
    };

    expect(
      __chatStateContextUsageTest.mergePendingSubmittedMessages(
        [assistantAsk, assistantAfter],
        [pendingAskResponse],
      ),
    ).toEqual([assistantAsk, pendingAskResponse, assistantAfter]);

    const completedAsk = {
      ...assistantAsk,
      parts: [
        {
          type: 'data-ask-user',
          data: {
            ...(assistantAsk.parts[0] as any).data,
            status: 'submitted',
            resume: {
              action: 'submit',
              answers: [{ id: 'scope', selectedOptionId: 'narrow', finalAnswer: 'Narrow' }],
            },
          },
        },
      ],
    };

    expect(
      __chatStateContextUsageTest.mergePendingSubmittedMessages(
        [completedAsk, assistantAfter],
        [pendingAskResponse],
      ),
    ).toEqual([completedAsk, assistantAfter]);
  });

  it('hydrates persisted ask_user suspensions as submitted when matching output exists', () => {
    const message = {
      id: 'assistant-ask',
      role: 'assistant',
      threadId: 'thread-1',
      resourceId: 'resource-1',
      createdAt: new Date(),
      content: {
        parts: [
          {
            type: 'data-tool-call-suspended',
            data: {
              state: 'data-tool-call-suspended',
              runId: 'mastra-run-1',
              toolCallId: 'ask-1',
              toolName: 'ask_user',
              suspendPayload: {
                questions: [
                  {
                    id: 'scope',
                    question: 'How broad should this be?',
                    options: [
                      { id: 'narrow', label: 'Narrow' },
                      { id: 'broad', label: 'Broad' },
                    ],
                  },
                ],
              },
            },
          },
          {
            type: 'tool-ask_user',
            toolCallId: 'ask-1',
            output: { ok: true },
          },
        ],
      },
    } as any;
    const completedAskIds = __chatStateContextUsageTest.collectCompletedAskToolCallIds([message]);
    const uiMessage = __chatStateContextUsageTest.toUiMessage(message, 'http://localhost', completedAskIds);

    expect(uiMessage.parts[0]).toMatchObject({
      type: 'data-ask-user',
      data: {
        mastraRunId: 'mastra-run-1',
        toolCallId: 'ask-1',
        status: 'submitted',
      },
    });
  });

  it('hydrates persisted ask_user tool invocations with Mastra suspended run ids', () => {
    const message = {
      id: 'assistant-ask',
      role: 'assistant',
      threadId: 'thread-1',
      resourceId: 'resource-1',
      createdAt: new Date(),
      content: {
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'result',
              toolName: 'ask_user',
              toolCallId: 'ask-1',
              args: {
                questions: [
                  {
                    id: 'scope',
                    question: 'How broad should this be?',
                    options: [
                      { id: 'narrow', label: 'Narrow' },
                      { id: 'broad', label: 'Broad' },
                    ],
                  },
                ],
              },
              result: {
                ok: true,
                answered: 1,
                questionCount: 1,
                answers: [
                  {
                    id: 'scope',
                    selectedOptionId: 'narrow',
                    finalAnswer: 'Narrow',
                    question: 'How broad should this be?',
                    selectedOptionLabel: 'Narrow',
                  },
                ],
              },
            },
          },
        ],
      },
    } as any;

    const uiMessage = __chatStateContextUsageTest.toUiMessage(
      message,
      'http://localhost',
      new Set(),
      { 'ask-1': 'mastra-run-1' },
    );

    expect(uiMessage.parts).toEqual([
      {
        type: 'data-ask-user',
        data: {
          mastraRunId: 'mastra-run-1',
          toolCallId: 'ask-1',
          toolName: 'ask_user',
          questions: [
            {
              id: 'scope',
              question: 'How broad should this be?',
              options: [
                { id: 'narrow', label: 'Narrow' },
                { id: 'broad', label: 'Broad' },
              ],
            },
          ],
          status: 'submitted',
          resume: {
            action: 'submit',
            answers: [{ id: 'scope', selectedOptionId: 'narrow', finalAnswer: 'Narrow' }],
          },
        },
      },
    ]);
  });

  it('detaches one observer without cancelling the run for other observers', async () => {
    const run = __chatRunRegistryTest.create('resource-1', 'thread-1');
    const firstReader = __chatRunRegistryTest.observe(run).getReader();
    const secondReader = __chatRunRegistryTest.observe(run).getReader();
    const chunk = { type: 'text-delta', id: 'msg-1', delta: 'still running' };

    await firstReader.cancel();

    const secondRead = secondReader.read();
    __chatRunRegistryTest.append(run, chunk);

    await expect(secondRead).resolves.toEqual({ done: false, value: chunk });
    expect(__chatRunRegistryTest.snapshot(run)).toMatchObject({
      active: true,
      status: 'running',
    });
  });

  it('cancels idempotently and closes observers with an abort chunk', async () => {
    const run = __chatRunRegistryTest.create('resource-1', 'thread-1');
    const reader = __chatRunRegistryTest.observe(run).getReader();
    const abortRead = reader.read();

    expect(__chatRunRegistryTest.cancel(run)).toBe(true);
    await expect(abortRead).resolves.toEqual({
      done: false,
      value: { type: 'abort', reason: 'cancelled' },
    });
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(__chatRunRegistryTest.cancel(run)).toBe(false);
    expect(__chatRunRegistryTest.snapshot(run)).toMatchObject({
      active: false,
      status: 'cancelled',
    });
  });

  it('reconstructs a retained assistant message from cancelled run chunks', () => {
    const run = __chatRunRegistryTest.create('resource-1', 'thread-1');
    __chatRunRegistryTest.append(run, {
      type: 'start',
      messageId: 'assistant-1',
    });
    __chatRunRegistryTest.append(run, { type: 'text-start', id: 'text-1' });
    __chatRunRegistryTest.append(run, {
      type: 'text-delta',
      id: 'text-1',
      delta: 'partial answer',
    });
    __chatRunRegistryTest.append(run, {
      type: 'tool-input-available',
      toolCallId: 'call-1',
      toolName: 'bash',
      input: { command: 'date' },
    });
    __chatRunRegistryTest.cancel(run);

    expect(__chatRunRegistryTest.uiMessages('resource-1', 'thread-1')).toEqual([
      {
        id: 'assistant-1',
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        parts: [
          { type: 'text', text: 'partial answer' },
          {
            type: 'tool-bash',
            toolCallId: 'call-1',
            state: 'input-available',
            input: { command: 'date' },
          },
        ],
      },
    ]);
  });

  it('reconstructs retained assistant and steered user messages in stream order', () => {
    const run = __chatRunRegistryTest.create('resource-1', 'thread-1');
    __chatRunRegistryTest.append(run, {
      type: 'start',
      messageId: 'assistant-1',
    });
    __chatRunRegistryTest.append(run, { type: 'text-start', id: 'text-1' });
    __chatRunRegistryTest.append(run, {
      type: 'text-delta',
      id: 'text-1',
      delta: 'first answer',
    });
    __chatRunRegistryTest.append(run, {
      type: 'data-user-message',
      transient: true,
      data: {
        id: 'steer-1',
        type: 'user',
        contents: 'Actually check the narrow case.',
        createdAt: '2026-07-02T10:00:00.000Z',
      },
    });
    __chatRunRegistryTest.append(run, {
      type: 'start',
      messageId: 'assistant-2',
    });
    __chatRunRegistryTest.append(run, { type: 'text-start', id: 'text-2' });
    __chatRunRegistryTest.append(run, {
      type: 'text-delta',
      id: 'text-2',
      delta: 'second answer',
    });

    expect(__chatRunRegistryTest.uiMessages('resource-1', 'thread-1')).toEqual([
      {
        id: 'assistant-1',
        role: 'assistant',
        status: { type: 'complete' },
        parts: [{ type: 'text', text: 'first answer' }],
      },
      {
        id: 'steer-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Actually check the narrow case.' }],
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        status: { type: 'running' },
        parts: [{ type: 'text', text: 'second answer' }],
      },
    ]);
  });

  it('flushes buffered assistant text before a steered user message chunk', async () => {
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: 'text-delta',
          id: 'text-1',
          delta: 'partial',
        });
        controller.enqueue({
          type: 'data-user-message',
          transient: true,
          data: {
            id: 'steer-1',
            type: 'user',
            contents: 'Steer now',
            createdAt: '2026-07-02T10:00:00.000Z',
          },
        });
        controller.close();
      },
    });
    const reader = __chatRunRegistryTest.buffer(input).getReader();

    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { type: 'text-delta', id: 'text-1', delta: 'partial' },
    });
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: {
        type: 'data-user-message',
        transient: false,
        data: { id: 'steer-1' },
      },
    });
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('marks an active run as errored when the stream emits an error chunk', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = __chatRunRegistryTest.create('resource-1', 'thread-1');
    const reader = __chatRunRegistryTest.observe(run).getReader();
    const textChunk = {
      type: 'text-delta',
      id: 'msg-1',
      delta: 'before failure',
    };
    const errorChunk = {
      type: 'error',
      errorText: 'Provider stream ended before completion.',
    };

    try {
      __chatRunRegistryTest.pump(
        run,
        new ReadableStream({
          start(controller) {
            controller.enqueue(textChunk);
            controller.enqueue(errorChunk);
            controller.enqueue({
              type: 'text-delta',
              id: 'msg-1',
              delta: 'after failure',
            });
            controller.close();
          },
        }),
      );

      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: textChunk,
      });
      await expect(reader.read()).rejects.toThrow('Provider stream ended before completion.');
      expect(__chatRunRegistryTest.snapshot(run)).toMatchObject({
        active: false,
        status: 'error',
        error: 'Provider stream ended before completion.',
      });

      const replayReader = __chatRunRegistryTest.observe(run).getReader();
      await expect(replayReader.read()).resolves.toEqual({
        done: false,
        value: textChunk,
      });
      await expect(replayReader.read()).resolves.toEqual({
        done: false,
        value: errorChunk,
      });
      await expect(replayReader.read()).resolves.toEqual({
        done: true,
        value: undefined,
      });
    } finally {
      consoleError.mockRestore();
    }
  });
});
