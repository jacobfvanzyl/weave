import {
  clampAgentMaxSteps,
  getAgentMaxSteps,
  RunQualityProcessor,
  summarizeRunQuality,
} from './run-quality-processor.ts';

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const options = {
  maxSteps: 64,
  repeatedFailureLimit: 3,
  totalFailureLimit: 8,
};

const failedStep = (id: string) => ({
  toolCalls: [{
    payload: {
      toolCallId: id,
      toolName: 'edit',
      args: { path: 'src/example.ts', edits: [{ oldText: 'before', newText: 'after' }] },
    },
  }],
  toolResults: [{
    payload: {
      toolCallId: id,
      toolName: 'edit',
      result: { ok: false, error: 'Could not find exact text in src/example.ts' },
    },
  }],
});

Deno.test('agent max-step policy defaults to 64 and enforces the hard cap', () => {
  assertEquals(getAgentMaxSteps({} as NodeJS.ProcessEnv), 64);
  assertEquals(getAgentMaxSteps({ WEAVE_AGENT_MAX_STEPS: '72' } as NodeJS.ProcessEnv), 72);
  assertEquals(getAgentMaxSteps({ WEAVE_AGENT_MAX_STEPS: '1000' } as NodeJS.ProcessEnv), 96);
  assertEquals(clampAgentMaxSteps(12, {} as NodeJS.ProcessEnv), 12);
  assertEquals(clampAgentMaxSteps(1000, {} as NodeJS.ProcessEnv), 96);
});

Deno.test('run-quality summary records failures, redundancy, restores, validation, and steering', () => {
  const steps = [
    failedStep('call-1'),
    failedStep('call-2'),
    {
      toolCalls: [{
        payload: {
          toolCallId: 'call-3',
          toolName: 'bash',
          args: { command: 'git restore src/example.ts; fvm flutter analyze' },
        },
      }],
      toolResults: [{
        payload: {
          toolCallId: 'call-3',
          toolName: 'bash',
          result: { ok: false, exitCode: 1, stderr: 'error: analysis failed' },
        },
      }],
    },
  ];
  const snapshot = summarizeRunQuality(steps, [{ role: 'signal' }, { role: 'signal' }], options);

  assertEquals(snapshot.steps, 3);
  assertEquals(snapshot.toolCalls, 3);
  assertEquals(snapshot.toolFailures, 3);
  assertEquals(snapshot.maxRepeatedFailure, 2);
  assertEquals(snapshot.redundantToolCalls, 1);
  assertEquals(snapshot.validationCalls, 1);
  assertEquals(snapshot.validationFailures, 1);
  assertEquals(snapshot.restoreCommands, 1);
  assertEquals(snapshot.steeringMessages, 2);
  assertEquals(snapshot.evaluation, 'fail');
});

Deno.test('run-quality processor finalizes after three repeated tool failures', async () => {
  const processor = new RunQualityProcessor(options);
  const signals: unknown[] = [];
  const state: Record<string, unknown> = {};
  const result = await processor.processInputStep({
    stepNumber: 3,
    steps: [failedStep('call-1'), failedStep('call-2'), failedStep('call-3')],
    messages: [],
    state,
    sendSignal: (signal: unknown) => {
      signals.push(signal);
      return Promise.resolve(signal as never);
    },
  } as any);

  assertEquals(result, { toolChoice: 'none', activeTools: [] });
  assertEquals(state.circuitBreakerReason, 'repeated_tool_failure');
  assertEquals(signals.length, 1);
  assert(String((signals[0] as any).contents).includes('circuit breaker'), 'expected finalization signal');
});

Deno.test('run-quality processor reserves the last bounded step for a final response', async () => {
  const processor = new RunQualityProcessor(options);
  const state: Record<string, unknown> = {};
  const result = await processor.processInputStep({
    stepNumber: 63,
    steps: [],
    messages: [],
    state,
    sendSignal: () => Promise.resolve({} as never),
  } as any);

  assertEquals(result, { toolChoice: 'none', activeTools: [] });
  assertEquals(state.circuitBreakerReason, 'max_steps');
});

Deno.test('run-quality processor emits one structured final evaluation', async () => {
  const processor = new RunQualityProcessor(options);
  const chunks: unknown[] = [];
  const messages = [{ role: 'user', content: 'do work' }];
  const originalInfo = console.info;
  console.info = () => undefined;
  try {
    const result = await processor.processOutputResult({
      state: {},
      messages,
      result: {
        steps: [{ toolCalls: [], toolResults: [] }],
      },
      writer: {
        custom: (chunk: unknown) => {
          chunks.push(chunk);
          return Promise.resolve();
        },
      },
    } as any);

    assertEquals(result, messages);
    assertEquals(chunks.length, 1);
    assertEquals((chunks[0] as any).type, 'data-run-quality');
    assertEquals((chunks[0] as any).data.evaluation, 'pass');
  } finally {
    console.info = originalInfo;
  }
});
