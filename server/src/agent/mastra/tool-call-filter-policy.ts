const defaultToolHistoryFullSteps = 8;

const positiveInteger = (value: unknown) => {
  const normalized = typeof value === 'string' ? value.trim() : value;
  if (normalized === '') return undefined;
  const number = typeof normalized === 'string' ? Number(normalized) : normalized;
  return typeof number === 'number' && Number.isInteger(number) && number >= 0 ? number : undefined;
};

export const getToolHistoryFullSteps = (env: NodeJS.ProcessEnv = process.env) =>
  positiveInteger(env.WEAVE_TOOL_HISTORY_FULL_STEPS) ??
    positiveInteger(env.WEAVE_TOOL_HISTORY_FULL_CALLS) ??
    defaultToolHistoryFullSteps;
