import { describe, expect, it } from 'vitest';
import {
  contextUsageFromProviderUsage,
  getThreadContextUsageSnapshot,
  recordThreadContextUsage,
} from '../../server/src/mastra/context-usage';
import { __chatStateContextUsageTest } from '../../server/src/mastra/routes/chat-state';

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

  it('uses profile memory config for estimated context recall', () => {
    const options = __chatStateContextUsageTest.contextUsageRecallOptions('thread-1', 'resource-1', {
      lastMessages: 10,
    });

    expect(options).toEqual({
      threadId: 'thread-1',
      resourceId: 'resource-1',
      threadConfig: { lastMessages: 10 },
    });
    expect(options).not.toHaveProperty('perPage');
    expect(options).not.toHaveProperty('orderBy');
  });
});
