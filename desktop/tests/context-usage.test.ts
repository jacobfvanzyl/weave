import { describe, expect, it } from 'vitest';
import {
  contextUsageFromProviderUsage,
  getThreadContextUsageSnapshot,
  recordThreadContextUsage,
  subscribeThreadContextUsage,
} from '../../server/src/agent/mastra/context-usage';
import { __chatStateContextUsageTest } from '../../server/src/modules/chat/routes/chat-state';

describe('context usage tracking', () => {
  it('uses provider input tokens as the displayed context pressure', () => {
    const usage = contextUsageFromProviderUsage({
      inputTokens: 3_000,
      cachedInputTokens: 1_200,
      outputTokens: 800,
      totalTokens: 3_800,
    });

    expect(usage).toEqual({
      usedTokens: 3_000,
      totalProcessedTokens: 3_800,
      inputTokens: 3_000,
      cachedInputTokens: 1_200,
      outputTokens: 800,
    });

    recordThreadContextUsage({
      threadId: 'thread-context-usage-input',
      resourceId: 'resource-1',
      maxTokens: 100_000,
      ...usage!,
    });

    expect(getThreadContextUsageSnapshot('thread-context-usage-input', 'resource-1')).toMatchObject({
      usedTokens: 3_000,
      totalProcessedTokens: 3_800,
      inputTokens: 3_000,
      cachedInputTokens: 1_200,
      outputTokens: 800,
      source: 'provider',
    });
  });

  it('skips provider snapshots when input token usage is unavailable', () => {
    expect(contextUsageFromProviderUsage({ outputTokens: 800, totalTokens: 800 })).toBeUndefined();
  });

  it('notifies matching context usage subscribers when provider usage is recorded', () => {
    const snapshots: unknown[] = [];
    const usage = contextUsageFromProviderUsage({
      inputTokens: 4_200,
      cachedInputTokens: 2_000,
      outputTokens: 600,
      totalTokens: 4_800,
    });

    const unsubscribe = subscribeThreadContextUsage('thread-context-usage-live', 'resource-1', (snapshot) => {
      snapshots.push(snapshot);
    });

    recordThreadContextUsage({
      threadId: 'thread-context-usage-live',
      resourceId: 'resource-1',
      maxTokens: 100_000,
      ...usage!,
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      threadId: 'thread-context-usage-live',
      resourceId: 'resource-1',
      usedTokens: 4_200,
      totalProcessedTokens: 4_800,
      inputTokens: 4_200,
      cachedInputTokens: 2_000,
      outputTokens: 600,
      source: 'provider',
    });

    unsubscribe();

    recordThreadContextUsage({
      threadId: 'thread-context-usage-live',
      resourceId: 'resource-1',
      maxTokens: 100_000,
      usedTokens: 5_000,
      inputTokens: 5_000,
    });

    expect(snapshots).toHaveLength(1);
  });

  it('does not notify subscribers for provider snapshots without input tokens', () => {
    const snapshots: unknown[] = [];
    const unsubscribe = subscribeThreadContextUsage('thread-context-usage-invalid', 'resource-1', (snapshot) => {
      snapshots.push(snapshot);
    });

    expect(contextUsageFromProviderUsage({ outputTokens: 800, totalTokens: 800 })).toBeUndefined();
    recordThreadContextUsage({
      threadId: 'thread-context-usage-invalid',
      resourceId: 'resource-1',
      usedTokens: 800,
    });

    expect(snapshots).toEqual([]);
    unsubscribe();
  });

  it('keeps memory config on fallback context recall without forcing pagination', () => {
    const memoryConfig = {
      observationalMemory: {
        model: 'openai/gpt-5-mini',
        scope: 'thread',
      },
    };
    const options = __chatStateContextUsageTest.contextUsageRecallOptions('thread-1', 'resource-1', memoryConfig);

    expect(options).toEqual({
      threadId: 'thread-1',
      resourceId: 'resource-1',
      threadConfig: memoryConfig,
    });
    expect('perPage' in options).toBe(false);
    expect('orderBy' in options).toBe(false);
  });

  it('estimates context usage from Mastra assembled context when available', async () => {
    const memoryConfig = {
      observationalMemory: {
        model: 'openai/gpt-5-mini',
        scope: 'thread',
      },
    };
    const memory = {
      estimateTokens: (text: string) => text.length,
      getContext: async (args: unknown) => {
        expect(args).toEqual({
          threadId: 'thread-1',
          resourceId: 'resource-1',
          memoryConfig,
        });
        return {
          systemMessage: 'observed context',
          messages: [
            {
              content: {
                parts: [{ type: 'text', text: 'current message' }],
              },
            },
          ],
        };
      },
    };

    await expect(__chatStateContextUsageTest.estimateMemoryContextTokens(memory, {
      threadId: 'thread-1',
      resourceId: 'resource-1',
      memoryConfig,
    })).resolves.toBe('observed context'.length + 'current message'.length);
  });
});
