const defaultToolHistoryFullSteps = 16;

const positiveInteger = (value: unknown) => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number >= 0 ? number : undefined;
};

export const getToolHistoryFullSteps = (env: NodeJS.ProcessEnv = process.env) =>
  positiveInteger(env.WEAVE_TOOL_HISTORY_FULL_STEPS) ??
    positiveInteger(env.WEAVE_TOOL_HISTORY_FULL_CALLS) ??
    defaultToolHistoryFullSteps;
