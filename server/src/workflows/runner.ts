import type { ServerNotificationInput } from '../modules/notifications/types';
import type { JsonValue, ServiceScope } from '../services/types';
import {
  type WorkflowAgentRunInput,
  type WorkflowServiceContext,
  type WorkflowServiceRuntime,
  workflowServiceRuntime,
} from './service-runtime';
import {
  validateWorkflowDefinition,
  type WorkflowDefinition,
  WorkflowDefinitionError,
  type WorkflowRunInput,
  type WorkflowState,
} from './definition';

export type WorkflowStepRunner = <T>(name: string, operation: () => Promise<T>) => Promise<T>;

export type WorkflowRunnerEvent = {
  eventId: string;
  type: string;
  data: JsonValue;
};

export type WorkflowRunnerEventHandler = (event: WorkflowRunnerEvent) => Promise<void> | void;

export type WorkflowRunnerOptions = {
  runtime?: WorkflowServiceRuntime;
  runStep?: WorkflowStepRunner;
  onEvent?: WorkflowRunnerEventHandler;
  maxTransitions?: number;
};

export type WorkflowExecutionContext = WorkflowServiceContext & {
  input: JsonValue;
  outputs: Record<string, JsonValue>;
};

type ServiceStepResult = { ok: true; value: JsonValue } | { ok: false; error: JsonValue };

const defaultMaxTransitions = 1000;

export class WorkflowExecutionError extends Error {
  constructor(message: string, readonly details?: JsonValue) {
    super(message);
    this.name = 'WorkflowExecutionError';
  }
}

export const executeWorkflowDefinition = async (
  input: WorkflowRunInput,
  options: WorkflowRunnerOptions = {},
): Promise<JsonValue> => {
  validateWorkflowDefinition(input.definition);

  const runtime = options.runtime ?? workflowServiceRuntime;
  const runStep = options.runStep ?? directStepRunner;
  const onEvent = options.onEvent;
  const context: WorkflowExecutionContext = {
    ownerId: input.ownerId,
    workflowRunId: input.workflowRunId,
    requestId: input.requestId,
    grants: input.definition.grants,
    input: input.input ?? null,
    outputs: {},
  };

  let stateId = input.definition.initialStateId;
  let transitions = 0;

  await emitRunnerEvent(input.workflowRunId, onEvent, 'execution.started', 'workflow.execution.started', {
    workflowId: input.definition.id,
    workflowVersion: input.definition.version,
  });

  while (transitions < (options.maxTransitions ?? defaultMaxTransitions)) {
    transitions += 1;
    const state = input.definition.states[stateId];
    if (!state) throw new WorkflowExecutionError(`Workflow state was not found: ${stateId}`);

    await emitRunnerEvent(
      input.workflowRunId,
      onEvent,
      `${transitions}:state.entered`,
      'workflow.state.entered',
      {
        transition: transitions,
        stateId,
        stateType: state.type,
      },
    );

    if (state.type === 'end') {
      const output = resolveJsonValue(input.definition, context, state.result ?? null);
      await emitRunnerEvent(
        input.workflowRunId,
        onEvent,
        `${transitions}:execution.completed`,
        'workflow.execution.completed',
        {
          transition: transitions,
          stateId,
          output,
        },
      );
      return output;
    }
    if (state.type === 'condition') {
      const evaluation = evaluateConditionState(input.definition, context, stateId, state);
      await emitRunnerEvent(
        input.workflowRunId,
        onEvent,
        `${transitions}:condition.evaluated`,
        'workflow.condition.evaluated',
        {
          transition: transitions,
          stateId,
          matchedCaseIndex: evaluation.matchedCaseIndex ?? null,
          nextStateId: evaluation.nextStateId,
        },
      );
      stateId = evaluation.nextStateId;
      continue;
    }

    const result = await runStep(
      `state:${stateId}:${state.type}`,
      () => executeServiceState(input.definition, runtime, context, state),
    );
    if (result.ok) {
      context.outputs[stateId] = result.value;
      await emitRunnerEvent(
        input.workflowRunId,
        onEvent,
        `${transitions}:state.succeeded`,
        'workflow.state.succeeded',
        {
          transition: transitions,
          stateId,
          stateType: state.type,
          output: result.value,
          nextStateId: state.on.success!,
        },
      );
      stateId = state.on.success!;
      continue;
    }

    context.outputs[stateId] = { ok: false, error: result.error };
    await emitRunnerEvent(
      input.workflowRunId,
      onEvent,
      `${transitions}:state.failed`,
      'workflow.state.failed',
      {
        transition: transitions,
        stateId,
        stateType: state.type,
        error: result.error,
        nextStateId: state.on.failure ?? null,
      },
    );
    if (state.on.failure) {
      stateId = state.on.failure;
      continue;
    }
    throw new WorkflowExecutionError(`Workflow state failed: ${stateId}`, result.error);
  }

  throw new WorkflowExecutionError('Workflow exceeded the maximum transition limit.', {
    maxTransitions: options.maxTransitions ?? defaultMaxTransitions,
  });
};

const directStepRunner: WorkflowStepRunner = (_name, operation) => operation();

const emitRunnerEvent = async (
  workflowRunId: string,
  onEvent: WorkflowRunnerEventHandler | undefined,
  eventKey: string,
  type: string,
  data: JsonValue,
) => {
  if (!onEvent) return;
  await onEvent({
    eventId: `runner:${workflowRunId}:${eventKey}`,
    type,
    data,
  });
};

const executeServiceState = async (
  definition: WorkflowDefinition,
  runtime: WorkflowServiceRuntime,
  context: WorkflowExecutionContext,
  state: Exclude<WorkflowState, { type: 'condition' | 'end' }>,
): Promise<ServiceStepResult> => {
  try {
    const value = await executeServiceStateValue(definition, runtime, context, state);
    return { ok: true, value: toJsonValue(value) };
  } catch (error) {
    return { ok: false, error: errorToJson(error) };
  }
};

const executeServiceStateValue = (
  definition: WorkflowDefinition,
  runtime: WorkflowServiceRuntime,
  context: WorkflowExecutionContext,
  state: Exclude<WorkflowState, { type: 'condition' | 'end' }>,
): Promise<unknown> | unknown => {
  switch (state.type) {
    case 'agent':
      return runtime.runAgentPrompt(
        context,
        {
          agentId: state.agentId,
          input: resolveJsonValue(definition, context, state.input),
          model: state.model,
          maxSteps: state.maxSteps,
          memory: state.memory,
          scope: state.scope,
        } satisfies WorkflowAgentRunInput,
      );
    case 'tool':
      return runtime.invokeTool(context, {
        toolId: state.toolId,
        scope: state.scope
          ? expectServiceScope(resolveUnknown(definition, context, state.scope), 'tool scope')
          : undefined,
        input: resolveUnknown(definition, context, state.input ?? {}),
        timeoutMs: state.timeoutMs,
      });
    case 'notify':
      return runtime.publishNotification(
        context,
        resolveUnknown(definition, context, state.input) as ServerNotificationInput,
      );
    case 'resource':
      return executeResourceState(definition, runtime, context, state);
  }
};

const executeResourceState = async (
  definition: WorkflowDefinition,
  runtime: WorkflowServiceRuntime,
  context: WorkflowExecutionContext,
  state: Extract<WorkflowState, { type: 'resource' }>,
) => {
  switch (state.action) {
    case 'getAttachment':
      return runtime.getAttachment(
        context,
        expectString(resolveUnknown(definition, context, state.attachmentId), 'attachmentId'),
      );
    case 'findAttachmentsByThread':
      return runtime.findAttachmentsByThread(
        context,
        expectString(resolveUnknown(definition, context, state.threadId), 'threadId'),
      );
    case 'findAttachmentsByOriginalName':
      return runtime.findAttachmentsByOriginalName(
        context,
        expectString(resolveUnknown(definition, context, state.originalName), 'originalName'),
        state.mimeType === undefined
          ? undefined
          : expectString(resolveUnknown(definition, context, state.mimeType), 'mimeType'),
      );
    case 'deleteAttachment':
      await runtime.deleteAttachment(
        context,
        expectString(resolveUnknown(definition, context, state.attachmentId), 'attachmentId'),
      );
      return null;
  }
};

const evaluateConditionState = (
  definition: WorkflowDefinition,
  context: WorkflowExecutionContext,
  stateId: string,
  state: Extract<WorkflowState, { type: 'condition' }>,
) => {
  for (const [index, conditionCase] of state.cases.entries()) {
    const value = resolveReference(definition, context, conditionCase.ref);
    if (jsonEquals(value, conditionCase.equals)) {
      return { nextStateId: conditionCase.to, matchedCaseIndex: index };
    }
  }
  if (!state.default) throw new WorkflowDefinitionError(`State ${stateId} condition default is required.`);
  return { nextStateId: state.default };
};

export const resolveJsonValue = (
  definition: WorkflowDefinition,
  context: WorkflowExecutionContext,
  value: JsonValue,
): JsonValue => toJsonValue(resolveUnknown(definition, context, value));

export const resolveUnknown = (
  definition: WorkflowDefinition,
  context: WorkflowExecutionContext,
  value: unknown,
): unknown => {
  if (isReferenceEnvelope(value)) return resolveReference(definition, context, value.$ref);
  if (Array.isArray(value)) return value.map((item) => resolveUnknown(definition, context, item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, resolveUnknown(definition, context, nested)]),
    );
  }
  return value;
};

const resolveReference = (
  definition: WorkflowDefinition,
  context: WorkflowExecutionContext,
  ref: string,
): unknown => {
  const segments = ref.split('.');
  let cursor: unknown;
  if (segments[0] === 'input') {
    cursor = context.input;
    segments.shift();
  } else if (segments[0] === 'outputs' && segments[1]) {
    const stateId = segments[1];
    if (!definition.states[stateId]) throw new WorkflowExecutionError(`Reference points to unknown state: ${ref}`);
    cursor = context.outputs[stateId];
    segments.splice(0, 2);
  } else {
    throw new WorkflowExecutionError(`Invalid workflow reference: ${ref}`);
  }

  for (const segment of segments) {
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        throw new WorkflowExecutionError(`Workflow reference was not found: ${ref}`);
      }
      cursor = cursor[index];
      continue;
    }
    if (!isRecord(cursor) || !(segment in cursor)) {
      throw new WorkflowExecutionError(`Workflow reference was not found: ${ref}`);
    }
    cursor = cursor[segment];
  }
  if (cursor === undefined) throw new WorkflowExecutionError(`Workflow reference resolved to undefined: ${ref}`);
  return cursor;
};

const expectString = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkflowExecutionError(`${label} must resolve to a non-empty string.`);
  }
  return value.trim();
};

const expectServiceScope = (value: unknown, label: string): ServiceScope => {
  if (!isRecord(value) || !isRecord(value.ref) || typeof value.ref.kind !== 'string') {
    throw new WorkflowExecutionError(`${label} must resolve to a service scope.`);
  }
  return value as ServiceScope;
};

const isReferenceEnvelope = (value: unknown): value is { $ref: string } =>
  isRecord(value) && Object.keys(value).length === 1 && typeof value.$ref === 'string' && value.$ref.trim().length > 0;

const errorToJson = (error: unknown): JsonValue => {
  if (error instanceof Error) {
    const details = 'details' in error ? (error as { details?: unknown }).details : undefined;
    return toJsonValue({
      name: error.name,
      message: error.message,
      ...(details !== undefined ? { details } : {}),
    });
  }
  return toJsonValue({ message: String(error) });
};

const toJsonValue = (value: unknown): JsonValue => {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  return JSON.parse(serialized) as JsonValue;
};

const jsonEquals = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonEquals(item, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return jsonEquals(leftKeys, rightKeys) && leftKeys.every((key) => jsonEquals(left[key], right[key]));
  }
  return false;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
