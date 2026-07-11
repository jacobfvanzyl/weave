export type ModelContextBudget = {
  modelId: string;
  advertisedContextTokens: number;
  contextLimitPercent: number;
  contextLimitTokens: number;
  recentTailTokens: number;
  summaryOutputTokens: number;
  retryDeltaTokens: number;
};

const modelContextBudgetKey = 'weave:model-context-budget';

export const putModelContextBudget = (requestContext: any, budget: ModelContextBudget) => {
  requestContext?.set?.(modelContextBudgetKey, budget);
};

export const getModelContextBudget = (requestContext: any): ModelContextBudget | undefined => {
  const value = requestContext?.get?.(modelContextBudgetKey);
  if (!value || typeof value !== 'object') return undefined;
  const budget = value as ModelContextBudget;
  return Number.isFinite(budget.contextLimitTokens) ? budget : undefined;
};

const defaultContextLimitPercent = 80;
const defaultRecentPercent = 5;
const defaultSummaryOutputPercent = 2;
const defaultRetryDeltaPercent = 2.5;
const maxConfiguredPercent = 95;

const percentage = (value: unknown, fallback: number, name: string) => {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  const resolved = parsed === undefined ? fallback : parsed;
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved <= 0 || resolved > maxConfiguredPercent) {
    throw new Error(`${name} must be a number greater than 0 and no greater than ${maxConfiguredPercent}.`);
  }
  return resolved;
};

export const getContextBudgetPercentages = (env: NodeJS.ProcessEnv = process.env) => {
  if (typeof env.WEAVE_CONTEXT_TOKEN_LIMIT === 'string' && env.WEAVE_CONTEXT_TOKEN_LIMIT.trim()) {
    throw new Error(
      'WEAVE_CONTEXT_TOKEN_LIMIT was removed. Configure WEAVE_CONTEXT_LIMIT_PERCENT (default 80) instead.',
    );
  }

  return {
    contextLimitPercent: percentage(
      env.WEAVE_CONTEXT_LIMIT_PERCENT,
      defaultContextLimitPercent,
      'WEAVE_CONTEXT_LIMIT_PERCENT',
    ),
    recentPercent: percentage(
      env.WEAVE_COMPACTION_RECENT_PERCENT,
      defaultRecentPercent,
      'WEAVE_COMPACTION_RECENT_PERCENT',
    ),
    summaryOutputPercent: percentage(
      env.WEAVE_COMPACTION_SUMMARY_OUTPUT_PERCENT,
      defaultSummaryOutputPercent,
      'WEAVE_COMPACTION_SUMMARY_OUTPUT_PERCENT',
    ),
    retryDeltaPercent: defaultRetryDeltaPercent,
  };
};

export const resolveModelContextBudget = (
  modelId: string,
  advertisedContextTokens: number,
  env: NodeJS.ProcessEnv = process.env,
): ModelContextBudget => {
  if (!modelId.trim()) throw new Error('A selected model is required to resolve its context budget.');
  if (!Number.isFinite(advertisedContextTokens) || advertisedContextTokens <= 0) {
    throw new Error(`Model ${modelId} does not advertise a valid context window.`);
  }

  const percentages = getContextBudgetPercentages(env);
  const budget = {
    modelId,
    advertisedContextTokens: Math.floor(advertisedContextTokens),
    contextLimitPercent: percentages.contextLimitPercent,
    contextLimitTokens: Math.floor(advertisedContextTokens * percentages.contextLimitPercent / 100),
    recentTailTokens: Math.floor(advertisedContextTokens * percentages.recentPercent / 100),
    summaryOutputTokens: Math.floor(advertisedContextTokens * percentages.summaryOutputPercent / 100),
    retryDeltaTokens: Math.floor(advertisedContextTokens * percentages.retryDeltaPercent / 100),
  };
  if (
    budget.contextLimitTokens <= 0 || budget.recentTailTokens <= 0 || budget.summaryOutputTokens <= 0 ||
    budget.retryDeltaTokens <= 0
  ) {
    throw new Error(`Model ${modelId} advertises too little context to derive Weave's percentage budgets.`);
  }
  return budget;
};

export const __contextBudgetTest = {
  defaultContextLimitPercent,
  defaultRecentPercent,
  defaultSummaryOutputPercent,
};
