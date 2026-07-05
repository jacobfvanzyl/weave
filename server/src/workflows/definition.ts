import type { JsonValue, ServiceGrant, ServiceScope } from '../services/types';
import type { WorkflowAgentRunInput } from './service-runtime';

export type WorkflowDefinition = {
  id: string;
  version: string;
  name: string;
  initialStateId: string;
  states: Record<string, WorkflowState>;
  grants: ServiceGrant[];
};

export type WorkflowRunInput = {
  ownerId: string;
  workflowRunId: string;
  requestId?: string;
  definition: WorkflowDefinition;
  input?: JsonValue;
};

export type WorkflowTransitionMap = {
  success?: string;
  failure?: string;
};

export type WorkflowAgentState = {
  type: 'agent';
  agentId?: string;
  input: JsonValue;
  model?: string;
  maxSteps?: number;
  memory?: WorkflowAgentRunInput['memory'];
  scope?: WorkflowAgentRunInput['scope'];
  on: WorkflowTransitionMap;
};

export type WorkflowToolState = {
  type: 'tool';
  toolId: string;
  scope?: ServiceScope;
  input?: JsonValue;
  timeoutMs?: number;
  on: WorkflowTransitionMap;
};

export type WorkflowNotifyState = {
  type: 'notify';
  input: JsonValue;
  on: WorkflowTransitionMap;
};

export type WorkflowResourceState =
  | {
    type: 'resource';
    action: 'getAttachment';
    attachmentId: JsonValue;
    on: WorkflowTransitionMap;
  }
  | {
    type: 'resource';
    action: 'findAttachmentsByThread';
    threadId: JsonValue;
    on: WorkflowTransitionMap;
  }
  | {
    type: 'resource';
    action: 'findAttachmentsByOriginalName';
    originalName: JsonValue;
    mimeType?: JsonValue;
    on: WorkflowTransitionMap;
  }
  | {
    type: 'resource';
    action: 'deleteAttachment';
    attachmentId: JsonValue;
    on: WorkflowTransitionMap;
  };

export type WorkflowConditionCase = {
  ref: string;
  equals: JsonValue;
  to: string;
};

export type WorkflowConditionState = {
  type: 'condition';
  cases: WorkflowConditionCase[];
  default: string;
};

export type WorkflowEndState = {
  type: 'end';
  result?: JsonValue;
};

export type WorkflowState =
  | WorkflowAgentState
  | WorkflowToolState
  | WorkflowNotifyState
  | WorkflowResourceState
  | WorkflowConditionState
  | WorkflowEndState;

export class WorkflowDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowDefinitionError';
  }
}

export const validateWorkflowDefinition = (definition: WorkflowDefinition) => {
  const errors: string[] = [];

  if (!isNonEmptyString(definition.id)) errors.push('Workflow id is required.');
  if (!isNonEmptyString(definition.version)) errors.push('Workflow version is required.');
  if (!isNonEmptyString(definition.name)) errors.push('Workflow name is required.');
  if (!isRecord(definition.states)) {
    errors.push('Workflow states must be an object.');
  } else if (!definition.states[definition.initialStateId]) {
    errors.push(`Initial state was not found: ${definition.initialStateId}`);
  }
  if (!Array.isArray(definition.grants)) errors.push('Workflow grants must be an array.');

  const stateIds = new Set(Object.keys(isRecord(definition.states) ? definition.states : {}));
  for (const [stateId, state] of Object.entries(isRecord(definition.states) ? definition.states : {})) {
    validateState(definition, stateIds, stateId, state, errors);
  }

  if (errors.length > 0) throw new WorkflowDefinitionError(errors.join(' '));
};

const validateState = (
  definition: WorkflowDefinition,
  stateIds: Set<string>,
  stateId: string,
  state: unknown,
  errors: string[],
) => {
  if (!isRecord(state)) {
    errors.push(`State ${stateId} must be an object.`);
    return;
  }
  const type = state.type;
  if (!isNonEmptyString(type)) {
    errors.push(`State ${stateId} is missing a type.`);
    return;
  }

  switch (type) {
    case 'agent':
      if (state.input === undefined) errors.push(`State ${stateId} input is required.`);
      requireObjectField(state, 'on', stateId, errors);
      requireSuccessTarget(state.on, stateIds, stateId, errors);
      validateFailureTarget(state.on, stateIds, stateId, errors);
      validateReferences(definition, state.input, `states.${stateId}.input`, errors);
      break;
    case 'tool':
      if (!isNonEmptyString(state.toolId)) errors.push(`State ${stateId} toolId is required.`);
      requireObjectField(state, 'on', stateId, errors);
      requireSuccessTarget(state.on, stateIds, stateId, errors);
      validateFailureTarget(state.on, stateIds, stateId, errors);
      validateReferences(definition, state.input, `states.${stateId}.input`, errors);
      validateReferences(definition, state.scope, `states.${stateId}.scope`, errors);
      break;
    case 'notify':
      if (state.input === undefined) errors.push(`State ${stateId} input is required.`);
      requireObjectField(state, 'on', stateId, errors);
      requireSuccessTarget(state.on, stateIds, stateId, errors);
      validateFailureTarget(state.on, stateIds, stateId, errors);
      validateReferences(definition, state.input, `states.${stateId}.input`, errors);
      break;
    case 'resource':
      validateResourceState(definition, state, stateId, stateIds, errors);
      break;
    case 'condition':
      validateConditionState(definition, state, stateId, stateIds, errors);
      break;
    case 'end':
      validateReferences(definition, state.result, `states.${stateId}.result`, errors);
      break;
    default:
      errors.push(`State ${stateId} has unsupported type: ${String(type)}`);
      break;
  }
};

const validateResourceState = (
  definition: WorkflowDefinition,
  state: Record<string, unknown>,
  stateId: string,
  stateIds: Set<string>,
  errors: string[],
) => {
  const action = state.action;
  if (
    action !== 'getAttachment' &&
    action !== 'findAttachmentsByThread' &&
    action !== 'findAttachmentsByOriginalName' &&
    action !== 'deleteAttachment'
  ) {
    errors.push(`State ${stateId} has unsupported resource action: ${String(action)}`);
  }

  requireObjectField(state, 'on', stateId, errors);
  requireSuccessTarget(state.on, stateIds, stateId, errors);
  validateFailureTarget(state.on, stateIds, stateId, errors);
  validateReferences(definition, state.attachmentId, `states.${stateId}.attachmentId`, errors);
  validateReferences(definition, state.threadId, `states.${stateId}.threadId`, errors);
  validateReferences(definition, state.originalName, `states.${stateId}.originalName`, errors);
  validateReferences(definition, state.mimeType, `states.${stateId}.mimeType`, errors);
};

const validateConditionState = (
  definition: WorkflowDefinition,
  state: Record<string, unknown>,
  stateId: string,
  stateIds: Set<string>,
  errors: string[],
) => {
  if (!Array.isArray(state.cases)) {
    errors.push(`State ${stateId} condition cases must be an array.`);
  } else {
    state.cases.forEach((conditionCase, index) => {
      if (!isRecord(conditionCase)) {
        errors.push(`State ${stateId} condition case ${index} must be an object.`);
        return;
      }
      validateReference(definition, conditionCase.ref, `states.${stateId}.cases.${index}.ref`, errors);
      validateTarget(conditionCase.to, stateIds, `State ${stateId} condition case ${index}`, errors);
    });
  }
  validateTarget(state.default, stateIds, `State ${stateId} condition default`, errors);
};

const requireObjectField = (state: Record<string, unknown>, field: string, stateId: string, errors: string[]) => {
  if (!isRecord(state[field])) errors.push(`State ${stateId} ${field} must be an object.`);
};

const requireSuccessTarget = (
  on: unknown,
  stateIds: Set<string>,
  stateId: string,
  errors: string[],
) => {
  if (!isRecord(on) || !isNonEmptyString(on.success)) {
    errors.push(`State ${stateId} on.success is required.`);
    return;
  }
  validateTarget(on.success, stateIds, `State ${stateId} on.success`, errors);
};

const validateFailureTarget = (
  on: unknown,
  stateIds: Set<string>,
  stateId: string,
  errors: string[],
) => {
  if (!isRecord(on) || on.failure === undefined) return;
  validateTarget(on.failure, stateIds, `State ${stateId} on.failure`, errors);
};

const validateTarget = (
  target: unknown,
  stateIds: Set<string>,
  label: string,
  errors: string[],
) => {
  if (!isNonEmptyString(target)) {
    errors.push(`${label} target is required.`);
    return;
  }
  if (!stateIds.has(target)) errors.push(`${label} target was not found: ${target}`);
};

export const isReferenceEnvelope = (value: unknown): value is { $ref: string } =>
  isRecord(value) && Object.keys(value).length === 1 && isNonEmptyString(value.$ref);

export const validateReferences = (
  definition: WorkflowDefinition,
  value: unknown,
  label: string,
  errors: string[],
) => {
  if (value === undefined) return;
  if (isReferenceEnvelope(value)) {
    validateReference(definition, value.$ref, label, errors);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateReferences(definition, item, `${label}.${index}`, errors));
    return;
  }
  if (isRecord(value)) {
    if ('$ref' in value) {
      errors.push(`${label} has a malformed reference envelope.`);
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      validateReferences(definition, nested, `${label}.${key}`, errors);
    }
  }
};

export const validateReference = (
  definition: WorkflowDefinition,
  ref: unknown,
  label: string,
  errors: string[],
) => {
  if (!isNonEmptyString(ref)) {
    errors.push(`${label} reference must be a non-empty string.`);
    return;
  }
  const segments = ref.split('.');
  if (segments[0] === 'input') return;
  if (segments[0] === 'outputs' && isNonEmptyString(segments[1])) {
    if (!definition.states[segments[1]]) {
      errors.push(`${label} references unknown output state: ${segments[1]}`);
    }
    return;
  }
  errors.push(`${label} has invalid reference: ${ref}`);
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
