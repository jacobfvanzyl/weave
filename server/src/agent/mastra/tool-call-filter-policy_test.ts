import { getToolHistoryFullSteps } from './tool-call-filter-policy.ts';

const assertEquals = (actual: unknown, expected: unknown) => {
  if (actual !== expected) throw new Error(`Expected ${String(actual)} to equal ${String(expected)}`);
};

Deno.test('tool history policy treats blank Compose values as unset', () => {
  assertEquals(getToolHistoryFullSteps({ WEAVE_TOOL_HISTORY_FULL_STEPS: '' } as NodeJS.ProcessEnv), 8);
  assertEquals(
    getToolHistoryFullSteps({
      WEAVE_TOOL_HISTORY_FULL_STEPS: '   ',
      WEAVE_TOOL_HISTORY_FULL_CALLS: '',
    } as NodeJS.ProcessEnv),
    8,
  );
});

Deno.test('tool history policy preserves an explicit zero and configured fallback', () => {
  assertEquals(getToolHistoryFullSteps({ WEAVE_TOOL_HISTORY_FULL_STEPS: '0' } as NodeJS.ProcessEnv), 0);
  assertEquals(getToolHistoryFullSteps({ WEAVE_TOOL_HISTORY_FULL_CALLS: '12' } as NodeJS.ProcessEnv), 12);
});
