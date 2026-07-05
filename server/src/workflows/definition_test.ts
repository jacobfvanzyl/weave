import { validateWorkflowDefinition, type WorkflowDefinition, WorkflowDefinitionError } from './definition.ts';

const assertThrowsDefinitionError = (definition: unknown, expectedMessage: string) => {
  try {
    validateWorkflowDefinition(definition as WorkflowDefinition);
  } catch (error) {
    if (!(error instanceof WorkflowDefinitionError)) throw error;
    if (!error.message.includes(expectedMessage)) {
      throw new Error(`Expected message to include ${expectedMessage}, received ${error.message}`);
    }
    return;
  }
  throw new Error('Expected definition validation to fail.');
};

const validDefinition = (): WorkflowDefinition => ({
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
    end: {
      type: 'end',
      result: { $ref: 'outputs.agent.text' },
    },
  },
});

Deno.test('validateWorkflowDefinition accepts a minimal agent workflow', () => {
  validateWorkflowDefinition(validDefinition());
});

Deno.test('validateWorkflowDefinition rejects unknown state types', () => {
  const definition = validDefinition();
  definition.states.agent = { type: 'unknown', on: { success: 'end' } } as never;

  assertThrowsDefinitionError(definition, 'unsupported type');
});

Deno.test('validateWorkflowDefinition rejects missing initial state', () => {
  const definition = validDefinition();
  definition.initialStateId = 'missing';

  assertThrowsDefinitionError(definition, 'Initial state was not found');
});

Deno.test('validateWorkflowDefinition rejects bad transition targets', () => {
  const definition = validDefinition();
  definition.states.agent = {
    type: 'agent',
    input: 'hello',
    on: { success: 'missing' },
  };

  assertThrowsDefinitionError(definition, 'target was not found');
});

Deno.test('validateWorkflowDefinition rejects invalid refs', () => {
  const definition = validDefinition();
  definition.states.agent = {
    type: 'agent',
    input: { prompt: { $ref: 'bad.path' } },
    on: { success: 'end' },
  };

  assertThrowsDefinitionError(definition, 'invalid reference');
});

Deno.test('validateWorkflowDefinition rejects malformed ref envelopes', () => {
  const definition = validDefinition();
  definition.states.agent = {
    type: 'agent',
    input: { prompt: { $ref: 'input.prompt', extra: true } as never },
    on: { success: 'end' },
  };

  assertThrowsDefinitionError(definition, 'malformed reference envelope');
});

Deno.test('validateWorkflowDefinition rejects condition states without a default target', () => {
  const definition = validDefinition();
  definition.initialStateId = 'condition';
  definition.states.condition = {
    type: 'condition',
    cases: [{ ref: 'input.kind', equals: 'ok', to: 'end' }],
    default: '',
  };

  assertThrowsDefinitionError(definition, 'condition default target is required');
});

Deno.test('validateWorkflowDefinition rejects unsupported resource actions', () => {
  const definition = validDefinition();
  definition.initialStateId = 'resource';
  definition.states.resource = {
    type: 'resource',
    action: 'putAttachment',
    on: { success: 'end' },
  } as never;

  assertThrowsDefinitionError(definition, 'unsupported resource action');
});
