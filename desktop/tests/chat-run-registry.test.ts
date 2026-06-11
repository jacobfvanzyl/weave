import { afterEach, describe, expect, it } from 'vitest';
import { recordThreadContextUsage } from '../../server/src/mastra/context-usage';
import { __chatRunRegistryTest } from '../../server/src/mastra/routes/chat';
import { __chatStateContextUsageTest } from '../../server/src/mastra/routes/chat-state';

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
});
