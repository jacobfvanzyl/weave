import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordThreadContextUsage } from '../../server/src/agent/mastra/context-usage';
import { __chatRunRegistryTest, chatRoutes } from '../../server/src/modules/chat/routes/chat';
import { __chatStateContextUsageTest } from '../../server/src/modules/chat/routes/chat-state';

const steerRouteHandler = () => {
  const handler = chatRoutes.find(route => route.path === '/chat/runs/:threadId/steer')?.handler;
  if (typeof handler !== 'function') throw new Error('steering route not found');
  return handler as (c: any) => Promise<unknown>;
};

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

    await expect(reader.read()).resolves.toEqual({ done: false, value: startChunk });
    await expect(reader.read()).resolves.toEqual({ done: false, value: textChunk });

    const liveRead = reader.read();
    __chatRunRegistryTest.append(run, finishChunk);
    await expect(liveRead).resolves.toEqual({ done: false, value: finishChunk });

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
      __chatRunRegistryTest.append(run, { type: 'text-delta', id: 'text-1', delta: 'Done.' });

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
    const json = vi.fn((body: unknown, status?: number) => ({ body, status }));
    const response = await steerRouteHandler()({
      get: (key: string) => key === 'requestContext' ? { get: () => 'resource-1' } : undefined,
      req: {
        param: () => 'thread-1',
        json: async () => ({
          message: { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'steer' }] },
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

  it('delivers active steering messages through Mastra sendMessage', async () => {
    __chatRunRegistryTest.create('resource-1', 'thread-1');
    const sendMessage = vi.fn(() => ({
      accepted: true,
      runId: 'mastra-run-1',
      signal: { id: 'signal-1' },
    }));
    const getAgent = vi.fn(async () => ({ sendMessage }));
    const json = vi.fn((body: unknown, status?: number) => ({ body, status }));

    const response = await steerRouteHandler()({
      get: (key: string) => {
        if (key === 'requestContext') return { get: () => 'resource-1' };
        if (key === 'mastra') return { getAgent };
        return undefined;
      },
      req: {
        param: () => 'thread-1',
        json: async () => ({
          message: { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'steer' }] },
        }),
      },
      json,
    });

    expect(getAgent).toHaveBeenCalledWith('mageHandAgent');
    expect(sendMessage).toHaveBeenCalledWith(
      { contents: [{ type: 'text', text: 'steer' }] },
      {
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
      },
    );
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
    await expect(reader.read()).resolves.toEqual({ done: false, value: textChunk });

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
    await expect(finishRead).resolves.toEqual({ done: false, value: finishChunk });

    const replayReader = __chatRunRegistryTest.observe(run).getReader();
    await expect(replayReader.read()).resolves.toEqual({ done: false, value: textChunk });
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
    const pending = __chatStateContextUsageTest.toPendingSubmittedMessage({
      id: 'user-1',
      role: 'user',
      metadata: { slashCommandOriginalText: '/commit current work' },
      parts: [{ type: 'text', text: 'Expanded commit prompt' }],
    }, 'http://localhost', 0);

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
    expect(__chatStateContextUsageTest.mergePendingSubmittedMessages([previous, persistedSameTurn], pending ? [pending] : []))
      .toEqual([previous, persistedSameTurn]);
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
    expect(__chatRunRegistryTest.snapshot(run)).toMatchObject({ active: true, status: 'running' });
  });

  it('cancels idempotently and closes observers with an abort chunk', async () => {
    const run = __chatRunRegistryTest.create('resource-1', 'thread-1');
    const reader = __chatRunRegistryTest.observe(run).getReader();
    const abortRead = reader.read();

    expect(__chatRunRegistryTest.cancel(run)).toBe(true);
    await expect(abortRead).resolves.toEqual({ done: false, value: { type: 'abort', reason: 'cancelled' } });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(__chatRunRegistryTest.cancel(run)).toBe(false);
    expect(__chatRunRegistryTest.snapshot(run)).toMatchObject({ active: false, status: 'cancelled' });
  });

  it('reconstructs a retained assistant message from cancelled run chunks', () => {
    const run = __chatRunRegistryTest.create('resource-1', 'thread-1');
    __chatRunRegistryTest.append(run, { type: 'start', messageId: 'assistant-1' });
    __chatRunRegistryTest.append(run, { type: 'text-start', id: 'text-1' });
    __chatRunRegistryTest.append(run, { type: 'text-delta', id: 'text-1', delta: 'partial answer' });
    __chatRunRegistryTest.append(run, { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'bash', input: { command: 'date' } });
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
    __chatRunRegistryTest.append(run, { type: 'start', messageId: 'assistant-1' });
    __chatRunRegistryTest.append(run, { type: 'text-start', id: 'text-1' });
    __chatRunRegistryTest.append(run, { type: 'text-delta', id: 'text-1', delta: 'first answer' });
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
    __chatRunRegistryTest.append(run, { type: 'start', messageId: 'assistant-2' });
    __chatRunRegistryTest.append(run, { type: 'text-start', id: 'text-2' });
    __chatRunRegistryTest.append(run, { type: 'text-delta', id: 'text-2', delta: 'second answer' });

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
        controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'partial' });
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
      value: { type: 'data-user-message', transient: false, data: { id: 'steer-1' } },
    });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it('marks an active run as errored when the stream emits an error chunk', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = __chatRunRegistryTest.create('resource-1', 'thread-1');
    const reader = __chatRunRegistryTest.observe(run).getReader();
    const textChunk = { type: 'text-delta', id: 'msg-1', delta: 'before failure' };
    const errorChunk = { type: 'error', errorText: 'Provider stream ended before completion.' };

    try {
      __chatRunRegistryTest.pump(run, new ReadableStream({
        start(controller) {
          controller.enqueue(textChunk);
          controller.enqueue(errorChunk);
          controller.enqueue({ type: 'text-delta', id: 'msg-1', delta: 'after failure' });
          controller.close();
        },
      }));

      await expect(reader.read()).resolves.toEqual({ done: false, value: textChunk });
      await expect(reader.read()).rejects.toThrow('Provider stream ended before completion.');
      expect(__chatRunRegistryTest.snapshot(run)).toMatchObject({
        active: false,
        status: 'error',
        error: 'Provider stream ended before completion.',
      });

      const replayReader = __chatRunRegistryTest.observe(run).getReader();
      await expect(replayReader.read()).resolves.toEqual({ done: false, value: textChunk });
      await expect(replayReader.read()).resolves.toEqual({ done: false, value: errorChunk });
      await expect(replayReader.read()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      consoleError.mockRestore();
    }
  });
});
