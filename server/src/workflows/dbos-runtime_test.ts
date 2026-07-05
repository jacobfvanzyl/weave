import {
  cancelDbosWorkflowExecution,
  type DbosAdapter,
  getDbosWorkflowStatus,
  maybeLaunchDbosWorkflowRuntime,
  resetDbosWorkflowRuntimeForTests,
  weaveDbosWorkflowName,
} from './dbos-runtime.ts';
import type { WorkflowDefinition } from './definition.ts';
import type { WorkflowServiceRuntime } from './service-runtime.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const assertRejects = async (operation: () => unknown | Promise<unknown>, expectedMessage: string) => {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expectedMessage)) {
      throw new Error(`Expected error message to include ${expectedMessage}, received ${message}`);
    }
    return;
  }
  throw new Error('Expected operation to reject.');
};

const minimalDefinition = (): WorkflowDefinition => ({
  id: 'workflow-1',
  version: '1',
  name: 'Workflow',
  initialStateId: 'agent',
  grants: [],
  states: {
    agent: {
      type: 'agent',
      input: { prompt: { $ref: 'input.prompt' } },
      on: { success: 'end' },
    },
    end: { type: 'end', result: { $ref: 'outputs.agent.text' } },
  },
});

const fakeRuntime = (): WorkflowServiceRuntime =>
  ({
    runAgentPrompt: (
      _context: Parameters<WorkflowServiceRuntime['runAgentPrompt']>[0],
      input: Parameters<WorkflowServiceRuntime['runAgentPrompt']>[1],
    ) => Promise.resolve({ text: `done:${(input.input as { prompt?: string }).prompt}` }),
  }) as unknown as WorkflowServiceRuntime;

Deno.test('maybeLaunchDbosWorkflowRuntime is disabled by default and does not load DBOS', async () => {
  resetDbosWorkflowRuntimeForTests();
  const result = await maybeLaunchDbosWorkflowRuntime({
    env: {},
    loadAdapter: () => Promise.reject(new Error('adapter should not load')),
  });

  assertEquals(result, { enabled: false, launched: false });
});

Deno.test('maybeLaunchDbosWorkflowRuntime requires Postgres URL when enabled', async () => {
  resetDbosWorkflowRuntimeForTests();
  await assertRejects(
    () => maybeLaunchDbosWorkflowRuntime({ env: { WEAVE_DBOS_ENABLED: '1' } }),
    'WEAVE_DATABASE_URL or DBOS_SYSTEM_DATABASE_URL',
  );
});

Deno.test('maybeLaunchDbosWorkflowRuntime defaults DBOS database URL to WEAVE_DATABASE_URL', async () => {
  resetDbosWorkflowRuntimeForTests();
  const calls: string[] = [];
  const adapter: DbosAdapter = {
    setConfig: (config) => calls.push(`config:${config.systemDatabaseUrl}`),
    registerWorkflow: (fn) => fn,
    runStep: async (operation) => await operation(),
    launch: () => Promise.resolve(),
  };

  await maybeLaunchDbosWorkflowRuntime({
    env: {
      WEAVE_DBOS_ENABLED: '1',
      WEAVE_DATABASE_URL: 'postgres://user:pass@localhost:5432/weave',
    },
    adapter,
    runtime: fakeRuntime(),
    createRunnerEventHandler: () => undefined,
  });

  assertEquals(calls, ['config:postgres://user:pass@localhost:5432/weave']);
});

Deno.test('maybeLaunchDbosWorkflowRuntime configures, registers, and launches in order', async () => {
  resetDbosWorkflowRuntimeForTests();
  const calls: string[] = [];
  const adapter: DbosAdapter = {
    setConfig: (config) => calls.push(`config:${config.name}:${config.systemDatabaseUrl}`),
    registerWorkflow: (fn, config) => {
      calls.push(`register:${config.name}`);
      return fn;
    },
    runStep: async (operation, config) => {
      calls.push(`step:${config.name}`);
      return await operation();
    },
    launch: () => {
      calls.push('launch');
      return Promise.resolve();
    },
  };

  const result = await maybeLaunchDbosWorkflowRuntime({
    env: {
      WEAVE_DBOS_ENABLED: '1',
      WEAVE_DBOS_APP_NAME: 'weave-test',
      DBOS_SYSTEM_DATABASE_URL: 'postgres://user:pass@localhost:5432/dbos',
    },
    adapter,
    runtime: fakeRuntime(),
    createRunnerEventHandler: () => undefined,
  });

  assertEquals(result.enabled, true);
  if (!result.enabled) throw new Error('Expected DBOS runtime to launch.');
  assertEquals(result.workflowName, weaveDbosWorkflowName);
  assertEquals(calls, [
    'config:weave-test:postgres://user:pass@localhost:5432/dbos',
    `register:${weaveDbosWorkflowName}`,
    'launch',
  ]);

  const output = await result.workflow({
    ownerId: 'owner-1',
    workflowRunId: 'workflow-run-1',
    definition: minimalDefinition(),
    input: { prompt: 'prompt' },
  });
  assertEquals(output, 'done:prompt');
  assertEquals(calls.at(-1), 'step:state:agent:agent');
});

Deno.test('DBOS status and cancel helpers use the launched adapter when enabled', async () => {
  resetDbosWorkflowRuntimeForTests();
  const calls: string[] = [];
  const adapter: DbosAdapter = {
    setConfig: () => undefined,
    registerWorkflow: (fn) => fn,
    runStep: async (operation) => await operation(),
    getWorkflowStatus: (workflowID) => {
      calls.push(`status:${workflowID}`);
      return Promise.resolve({
        workflowID,
        status: 'SUCCESS',
        output: { ok: true },
      });
    },
    cancelWorkflow: (workflowID, options) => {
      calls.push(`cancel:${workflowID}:${options?.cancelChildren === true}`);
      return Promise.resolve();
    },
    launch: () => Promise.resolve(),
  };

  const status = await getDbosWorkflowStatus('workflow-run-1', {
    env: {
      WEAVE_DBOS_ENABLED: '1',
      DBOS_SYSTEM_DATABASE_URL: 'postgres://user:pass@localhost:5432/dbos',
    },
    adapter,
    runtime: fakeRuntime(),
    createRunnerEventHandler: () => undefined,
  });
  const cancelled = await cancelDbosWorkflowExecution('workflow-run-1', {
    env: {
      WEAVE_DBOS_ENABLED: '1',
      DBOS_SYSTEM_DATABASE_URL: 'postgres://user:pass@localhost:5432/dbos',
    },
    adapter,
    runtime: fakeRuntime(),
    createRunnerEventHandler: () => undefined,
  });

  assertEquals(status?.status, 'SUCCESS');
  assertEquals(status?.output, { ok: true });
  assertEquals(cancelled, true);
  assertEquals(calls, ['status:workflow-run-1', 'cancel:workflow-run-1:true']);
});

Deno.test('DBOS integration smoke runs only when explicitly configured', async () => {
  if (process.env.WEAVE_DBOS_INTEGRATION !== '1' || !(process.env.DBOS_SYSTEM_DATABASE_URL || process.env.WEAVE_DATABASE_URL)) return;

  resetDbosWorkflowRuntimeForTests();
  const { DBOS } = await import('@dbos-inc/dbos-sdk');
  const launch = await maybeLaunchDbosWorkflowRuntime({ runtime: fakeRuntime() });
  if (!launch.enabled) throw new Error('Expected DBOS integration launch to be enabled.');

  try {
    const workflowId = `weave-smoke-${crypto.randomUUID()}`;
    const handle = await DBOS.startWorkflow(launch.workflow, { workflowID: workflowId })({
      ownerId: 'owner-1',
      workflowRunId: workflowId,
      definition: minimalDefinition(),
      input: { prompt: 'integration' },
    });
    assertEquals(await handle.getResult(), 'done:integration');
    const status = await handle.getStatus();
    assertEquals(status?.workflowID, workflowId);
  } finally {
    await DBOS.shutdown({ deregister: true });
    resetDbosWorkflowRuntimeForTests();
  }
});
