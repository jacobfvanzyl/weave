import type { WorkflowDefinition } from './definition.ts';
import { executeWorkflowDefinition, WorkflowExecutionError, type WorkflowStepRunner } from './runner.ts';
import type { WorkflowServiceRuntime } from './service-runtime.ts';
import { type JsonValue, serviceLocatorScope } from '../services/types.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const assertRejectsExecutionError = async (operation: () => Promise<unknown>, expectedMessage: string) => {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof WorkflowExecutionError)) throw error;
    if (!error.message.includes(expectedMessage)) {
      throw new Error(`Expected message to include ${expectedMessage}, received ${error.message}`);
    }
    return;
  }
  throw new Error('Expected workflow execution to fail.');
};

const createRuntime = (runtime: Partial<WorkflowServiceRuntime>) => runtime as WorkflowServiceRuntime;

const createStepRecorder = (steps: string[]): WorkflowStepRunner => async (name, operation) => {
  steps.push(name);
  return await operation();
};

const runWorkflow = (
  definition: WorkflowDefinition,
  runtime: Partial<WorkflowServiceRuntime>,
  input: JsonValue = { prompt: 'Hello' },
) => {
  const steps: string[] = [];
  const result = executeWorkflowDefinition(
    {
      ownerId: 'owner-1',
      workflowRunId: 'workflow-run-1',
      requestId: 'request-1',
      definition,
      input,
    },
    { runtime: createRuntime(runtime), runStep: createStepRecorder(steps) },
  );
  return { result, steps };
};

Deno.test('executeWorkflowDefinition runs agent, condition, notify, and end states', async () => {
  const definition: WorkflowDefinition = {
    id: 'workflow-1',
    version: '1',
    name: 'Agent workflow',
    initialStateId: 'agent',
    grants: [],
    states: {
      agent: {
        type: 'agent',
        input: { prompt: { $ref: 'input.prompt' } },
        on: { success: 'condition' },
      },
      condition: {
        type: 'condition',
        cases: [{ ref: 'outputs.agent.text', equals: 'ready', to: 'notify' }],
        default: 'end',
      },
      notify: {
        type: 'notify',
        input: { kind: 'workflow.done', title: { $ref: 'outputs.agent.text' }, priority: 'normal' },
        on: { success: 'end' },
      },
      end: { type: 'end', result: { $ref: 'outputs.agent.text' } },
    },
  };
  const notifications: unknown[] = [];
  const { result, steps } = runWorkflow(definition, {
    runAgentPrompt: (_context, input) => Promise.resolve({ text: `ready`, prompt: input.input }),
    publishNotification: (_context, input) => {
      notifications.push(input);
      return Promise.resolve({
        sequence: 1,
        event: { ...input, id: 'notification-1', createdAt: 'now', source: 'server' } as never,
      });
    },
  });

  assertEquals(await result, 'ready');
  assertEquals(steps, ['state:agent:agent', 'state:notify:notify']);
  assertEquals(notifications, [{ kind: 'workflow.done', title: 'ready', priority: 'normal' }]);
});

Deno.test('executeWorkflowDefinition follows agent failure transitions with failure envelopes', async () => {
  const definition: WorkflowDefinition = {
    id: 'workflow-1',
    version: '1',
    name: 'Agent failure',
    initialStateId: 'agent',
    grants: [],
    states: {
      agent: {
        type: 'agent',
        input: 'run',
        on: { success: 'success', failure: 'failure' },
      },
      success: { type: 'end', result: 'success' },
      failure: { type: 'end', result: { $ref: 'outputs.agent.error.message' } },
    },
  };
  const { result } = runWorkflow(definition, {
    runAgentPrompt: () => Promise.reject(new Error('agent failed')),
  });

  assertEquals(await result, 'agent failed');
});

Deno.test('executeWorkflowDefinition runs tool success and resolves nested references', async () => {
  const scope = serviceLocatorScope('portal-target', { portalId: 'portal-1' });
  const definition: WorkflowDefinition = {
    id: 'workflow-1',
    version: '1',
    name: 'Tool workflow',
    initialStateId: 'tool',
    grants: [],
    states: {
      tool: {
        type: 'tool',
        toolId: 'portal.fs.read',
        scope,
        input: { path: { $ref: 'input.path' } },
        on: { success: 'end' },
      },
      end: { type: 'end', result: { $ref: 'outputs.tool.content' } },
    },
  };
  let toolInput: unknown;
  const { result, steps } = runWorkflow(
    definition,
    {
      invokeTool: <T>(
        _context: Parameters<WorkflowServiceRuntime['invokeTool']>[0],
        input: Parameters<WorkflowServiceRuntime['invokeTool']>[1],
      ) => {
        toolInput = input;
        return Promise.resolve({ content: 'README' } as T);
      },
    },
    { path: 'README.md' },
  );

  assertEquals(await result, 'README');
  assertEquals((toolInput as { input?: unknown }).input, { path: 'README.md' });
  assertEquals((toolInput as { scope?: unknown }).scope, scope);
  assertEquals(steps, ['state:tool:tool']);
});

Deno.test('executeWorkflowDefinition converts tool failures and throws without failure transition', async () => {
  const definition: WorkflowDefinition = {
    id: 'workflow-1',
    version: '1',
    name: 'Tool failure',
    initialStateId: 'tool',
    grants: [],
    states: {
      tool: {
        type: 'tool',
        toolId: 'portal.fs.read',
        input: {},
        on: { success: 'end' },
      },
      end: { type: 'end', result: 'done' },
    },
  };
  const { result } = runWorkflow(definition, {
    invokeTool: () => Promise.reject(new Error('tool failed')),
  });

  await assertRejectsExecutionError(() => result, 'Workflow state failed: tool');
});

Deno.test('executeWorkflowDefinition runs resource lookup states', async () => {
  const definition: WorkflowDefinition = {
    id: 'workflow-1',
    version: '1',
    name: 'Resource workflow',
    initialStateId: 'resource',
    grants: [],
    states: {
      resource: {
        type: 'resource',
        action: 'findAttachmentsByThread',
        threadId: { $ref: 'input.threadId' },
        on: { success: 'end' },
      },
      end: { type: 'end', result: { $ref: 'outputs.resource.0.id' } },
    },
  };
  const { result } = runWorkflow(
    definition,
    {
      findAttachmentsByThread: (_context, threadId) => Promise.resolve([{ id: 'att-1', threadId } as never]),
    },
    { threadId: 'thread-1' },
  );

  assertEquals(await result, 'att-1');
});

Deno.test('executeWorkflowDefinition emits replayable runner events', async () => {
  const definition: WorkflowDefinition = {
    id: 'workflow-1',
    version: '1',
    name: 'Runner events',
    initialStateId: 'tool',
    grants: [],
    states: {
      tool: {
        type: 'tool',
        toolId: 'echo',
        input: { value: { $ref: 'input.value' } },
        on: { success: 'condition' },
      },
      condition: {
        type: 'condition',
        cases: [{ ref: 'outputs.tool.value', equals: 'yes', to: 'end' }],
        default: 'fallback',
      },
      fallback: { type: 'end', result: 'fallback' },
      end: { type: 'end', result: { $ref: 'outputs.tool.value' } },
    },
  };
  const events: { eventId: string; type: string; data: JsonValue }[] = [];

  const result = await executeWorkflowDefinition(
    {
      ownerId: 'owner-1',
      workflowRunId: 'workflow-run-1',
      requestId: 'request-1',
      definition,
      input: { value: 'yes' },
    },
    {
      runtime: createRuntime({
        invokeTool: <T>(
          _context: Parameters<WorkflowServiceRuntime['invokeTool']>[0],
          input: Parameters<WorkflowServiceRuntime['invokeTool']>[1],
        ) => Promise.resolve(input.input as T),
      }),
      onEvent: (event) => {
        events.push(event);
      },
    },
  );

  assertEquals(result, 'yes');
  assertEquals(events.map((event) => event.type), [
    'workflow.execution.started',
    'workflow.state.entered',
    'workflow.state.succeeded',
    'workflow.state.entered',
    'workflow.condition.evaluated',
    'workflow.state.entered',
    'workflow.execution.completed',
  ]);
  assertEquals(events[0].eventId, 'runner:workflow-run-1:execution.started');
  assertEquals(events[4].data, {
    transition: 2,
    stateId: 'condition',
    matchedCaseIndex: 0,
    nextStateId: 'end',
  });
});
