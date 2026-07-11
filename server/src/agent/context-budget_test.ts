import { getContextBudgetPercentages, resolveModelContextBudget } from './context-budget.ts';

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const assertThrows = (fn: () => unknown, text: string) => {
  try {
    fn();
  } catch (error) {
    if (String(error).includes(text)) return;
    throw error;
  }
  throw new Error(`Expected an error containing ${text}`);
};

Deno.test('Luna context budget is derived from its advertised window', () => {
  assertEquals(resolveModelContextBudget('openai/gpt-5.6-luna', 372_000, {} as NodeJS.ProcessEnv), {
    modelId: 'openai/gpt-5.6-luna',
    advertisedContextTokens: 372_000,
    contextLimitPercent: 80,
    contextLimitTokens: 297_600,
    recentTailTokens: 18_600,
    summaryOutputTokens: 7_440,
    retryDeltaTokens: 9_300,
  });
});

Deno.test('context budgets scale across differently sized models', () => {
  assertEquals(resolveModelContextBudget('test/small', 100_000, {} as NodeJS.ProcessEnv).contextLimitTokens, 80_000);
  assertEquals(resolveModelContextBudget('test/large', 1_000_000, {} as NodeJS.ProcessEnv).contextLimitTokens, 800_000);
});

Deno.test('context budget percentages are validated and legacy absolute configuration is rejected', () => {
  assertEquals(
    getContextBudgetPercentages({ WEAVE_CONTEXT_LIMIT_PERCENT: '95' } as NodeJS.ProcessEnv).contextLimitPercent,
    95,
  );
  assertThrows(
    () => getContextBudgetPercentages({ WEAVE_CONTEXT_LIMIT_PERCENT: '96' } as NodeJS.ProcessEnv),
    'no greater than 95',
  );
  assertThrows(
    () => getContextBudgetPercentages({ WEAVE_CONTEXT_TOKEN_LIMIT: '120000' } as NodeJS.ProcessEnv),
    'was removed',
  );
});
