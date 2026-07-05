import { isJsonValue, type JsonValue } from '../services/types';
import type { EventService } from '../services/event-service';
import { eventService as defaultEventService } from '../services/event-service';
import { cancelDbosWorkflowExecution, getDbosWorkflowStatus, startDbosWorkflowExecution } from './dbos-runtime';
import { validateWorkflowDefinition, type WorkflowDefinition, type WorkflowRunInput } from './definition';
import { createWorkflowRunnerEventRecorder, recordWorkflowRunEvent, workflowRunEventId } from './events';
import { executeWorkflowDefinition, type WorkflowRunnerEventHandler } from './runner';
import {
  type StoredWorkflowDefinition,
  type WorkflowRepository,
  workflowRepository,
  type WorkflowRunBackend,
  type WorkflowRunEventRecord,
  type WorkflowRunRecord,
} from './repository';

export type WorkflowControlErrorCode = 'invalid_input' | 'not_found' | 'execution_failed';

export class WorkflowControlError extends Error {
  constructor(
    readonly code: WorkflowControlErrorCode,
    message: string,
    readonly status = 500,
    readonly details?: JsonValue,
  ) {
    super(message);
    this.name = 'WorkflowControlError';
  }
}

export type WorkflowExecutionStart = {
  backend: Exclude<WorkflowRunBackend, 'pending'>;
  externalRunId?: string;
  result: Promise<JsonValue>;
};

export type WorkflowExecutionStatus =
  | { status: 'running' }
  | { status: 'completed'; output: JsonValue }
  | { status: 'failed'; error: JsonValue }
  | { status: 'cancelled'; error?: JsonValue };

export interface WorkflowRunExecutor {
  start(input: WorkflowRunInput, hooks?: { onEvent?: WorkflowRunnerEventHandler }): Promise<WorkflowExecutionStart>;
  getStatus?(run: WorkflowRunRecord): Promise<WorkflowExecutionStatus | undefined>;
  cancel?(run: WorkflowRunRecord): Promise<WorkflowExecutionStatus | undefined>;
}

export type WorkflowControlServiceDeps = {
  repository?: WorkflowRepository;
  executor?: WorkflowRunExecutor;
  events?: EventService;
};

export class DefaultWorkflowRunExecutor implements WorkflowRunExecutor {
  async start(
    input: WorkflowRunInput,
    hooks: { onEvent?: WorkflowRunnerEventHandler } = {},
  ): Promise<WorkflowExecutionStart> {
    const dbos = await startDbosWorkflowExecution(input);
    if (dbos) {
      return {
        backend: 'dbos',
        externalRunId: dbos.workflowID,
        result: dbos.result,
      };
    }

    return {
      backend: 'direct',
      result: new Promise<JsonValue>((resolve, reject) => {
        setTimeout(() => {
          executeWorkflowDefinition(input, { onEvent: hooks.onEvent }).then(resolve, reject);
        }, 0);
      }),
    };
  }

  async getStatus(run: WorkflowRunRecord): Promise<WorkflowExecutionStatus | undefined> {
    if (run.backend !== 'dbos' || !run.externalRunId) return undefined;
    const status = await getDbosWorkflowStatus(run.externalRunId);
    return status ? dbosStatusToWorkflowExecutionStatus(status.status, status.output, status.error) : undefined;
  }

  async cancel(run: WorkflowRunRecord): Promise<WorkflowExecutionStatus | undefined> {
    if (run.backend !== 'dbos' || !run.externalRunId) return undefined;
    await cancelDbosWorkflowExecution(run.externalRunId);
    const status = await this.getStatus(run);
    return status?.status === 'completed' || status?.status === 'failed' ? status : {
      status: 'cancelled',
      error: { message: 'Workflow run was cancelled.' },
    };
  }
}

export class WorkflowControlService {
  constructor(
    private readonly repository: WorkflowRepository = workflowRepository,
    private readonly executor: WorkflowRunExecutor = new DefaultWorkflowRunExecutor(),
    private readonly events: EventService = defaultEventService,
  ) {}

  saveDefinition(ownerId: string, definition: WorkflowDefinition) {
    validateWorkflowDefinition(definition);
    return this.repository.saveDefinition(ownerId, definition);
  }

  listDefinitions(ownerId: string) {
    return this.repository.listDefinitions(ownerId);
  }

  async getDefinition(ownerId: string, workflowId: string) {
    const definition = await this.repository.getDefinition(ownerId, workflowId);
    if (!definition) throw new WorkflowControlError('not_found', 'Workflow definition was not found.', 404);
    return definition;
  }

  deleteDefinition(ownerId: string, workflowId: string) {
    return this.repository.deleteDefinition(ownerId, workflowId);
  }

  async getRun(ownerId: string, runId: string) {
    const run = await this.repository.getRun(ownerId, runId);
    return run ? await this.reconcileRun(run) : undefined;
  }

  async listRuns(ownerId: string, options?: { workflowId?: string; limit?: number }) {
    const runs = await this.repository.listRuns(ownerId, options);
    return Promise.all(runs.map((run) => this.reconcileRun(run)));
  }

  async listRunEvents(ownerId: string, runId: string, options?: { afterSequence?: number; limit?: number }) {
    const run = await this.getRun(ownerId, runId);
    if (!run) throw new WorkflowControlError('not_found', 'Workflow run was not found.', 404);
    return this.repository.listRunEvents(ownerId, runId, options);
  }

  async startRun(input: {
    ownerId: string;
    workflowId: string;
    requestId?: string;
    runId?: string;
    input?: JsonValue;
  }) {
    const storedDefinition = await this.getDefinition(input.ownerId, input.workflowId);
    const runInput = input.input ?? null;
    if (!isJsonValue(runInput)) {
      throw new WorkflowControlError('invalid_input', 'Workflow run input must be JSON-safe.', 400);
    }

    const run = await this.repository.createRun({
      ownerId: input.ownerId,
      runId: input.runId,
      requestId: input.requestId,
      definition: storedDefinition.definition,
      input: runInput,
    });

    await this.publishRunEvent(input.ownerId, run.runId, 'workflow.run.created', {
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
    });

    try {
      const executionInput: WorkflowRunInput = {
        ownerId: input.ownerId,
        workflowRunId: run.runId,
        requestId: input.requestId,
        definition: storedDefinition.definition,
        input: runInput,
      };
      const execution = await this.executor.start(executionInput, {
        onEvent: createWorkflowRunnerEventRecorder(executionInput, {
          repository: this.repository,
          events: this.events,
        }),
      });
      const startedRun = await this.repository.updateRunStarted(input.ownerId, run.runId, {
        backend: execution.backend,
        externalRunId: execution.externalRunId,
      }) ?? run;
      await this.publishRunEvent(input.ownerId, run.runId, 'workflow.run.started', {
        workflowId: run.workflowId,
        backend: execution.backend,
        ...(execution.externalRunId ? { externalRunId: execution.externalRunId } : {}),
      });
      void this.settleRun(input.ownerId, run.runId, execution.result);
      return startedRun;
    } catch (error) {
      const failure = errorToJson(error);
      await this.repository.failRun(input.ownerId, run.runId, failure);
      await this.publishRunEvent(input.ownerId, run.runId, 'workflow.run.failed', failure);
      throw new WorkflowControlError('execution_failed', 'Workflow run failed to start.', 500, failure);
    }
  }

  async cancelRun(ownerId: string, runId: string) {
    const run = await this.repository.getRun(ownerId, runId);
    if (!run) throw new WorkflowControlError('not_found', 'Workflow run was not found.', 404);
    if (run.status !== 'running') return run;

    const executionStatus = await this.executor.cancel?.(run);
    const cancelled = await this.applyExecutionStatus(
      run,
      executionStatus ?? {
        status: 'cancelled',
        error: { message: 'Workflow run was cancelled.' },
      },
    );
    return cancelled;
  }

  async reconcileRun(run: WorkflowRunRecord) {
    if (run.status !== 'running') return run;
    const executionStatus = await this.executor.getStatus?.(run);
    return this.applyExecutionStatus(run, executionStatus);
  }

  private async settleRun(ownerId: string, runId: string, resultPromise: Promise<JsonValue>) {
    try {
      const output = await resultPromise;
      const current = await this.repository.getRun(ownerId, runId);
      if (!current || current.status !== 'running') return;
      await this.applyExecutionStatus(current, { status: 'completed', output });
    } catch (error) {
      const current = await this.repository.getRun(ownerId, runId);
      if (!current || current.status !== 'running') return;
      const failure = errorToJson(error);
      await this.applyExecutionStatus(current, { status: 'failed', error: failure });
    }
  }

  private async applyExecutionStatus(
    run: WorkflowRunRecord,
    executionStatus: WorkflowExecutionStatus | undefined,
  ): Promise<WorkflowRunRecord> {
    if (!executionStatus || executionStatus.status === 'running') return run;
    if (executionStatus.status === 'completed') {
      const completed = await this.repository.completeRun(run.ownerId, run.runId, executionStatus.output) ?? run;
      await this.publishRunEvent(run.ownerId, run.runId, 'workflow.run.completed', executionStatus.output);
      return completed;
    }
    if (executionStatus.status === 'failed') {
      const failed = await this.repository.failRun(run.ownerId, run.runId, executionStatus.error) ?? run;
      await this.publishRunEvent(run.ownerId, run.runId, 'workflow.run.failed', executionStatus.error);
      return failed;
    }
    const cancelled = await this.repository.cancelRun(run.ownerId, run.runId, executionStatus.error) ?? run;
    await this.publishRunEvent(run.ownerId, run.runId, 'workflow.run.cancelled', {
      workflowId: run.workflowId,
      externalRunId: run.externalRunId ?? null,
      ...(executionStatus.error === undefined ? {} : { error: executionStatus.error }),
    });
    return cancelled;
  }

  private publishRunEvent(ownerId: string, runId: string, type: string, data: JsonValue) {
    return recordWorkflowRunEvent({
      ownerId,
      runId,
      eventId: workflowRunEventId(runId, type),
      type,
      data,
    }, {
      repository: this.repository,
      events: this.events,
    }).catch(() => undefined);
  }
}

export const workflowControlService = new WorkflowControlService();

export const createWorkflowControlService = (deps: WorkflowControlServiceDeps = {}) =>
  new WorkflowControlService(deps.repository, deps.executor, deps.events);

export const workflowDefinitionResponse = (stored: StoredWorkflowDefinition) => ({
  ownerId: stored.ownerId,
  workflowId: stored.workflowId,
  version: stored.version,
  name: stored.name,
  createdAt: stored.createdAt,
  updatedAt: stored.updatedAt,
  definition: stored.definition,
});

export const workflowRunResponse = (run: WorkflowRunRecord) => ({
  ownerId: run.ownerId,
  runId: run.runId,
  workflowId: run.workflowId,
  workflowVersion: run.workflowVersion,
  status: run.status,
  backend: run.backend,
  externalRunId: run.externalRunId,
  requestId: run.requestId,
  input: run.input,
  output: run.output,
  error: run.error,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
});

export const workflowRunEventResponse = (event: WorkflowRunEventRecord) => ({
  ownerId: event.ownerId,
  runId: event.runId,
  eventId: event.eventId,
  sequence: event.sequence,
  type: event.type,
  data: event.data,
  createdAt: event.createdAt,
});

const errorToJson = (error: unknown): JsonValue => {
  if (error instanceof WorkflowControlError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      status: error.status,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: String(error) };
};

const unknownToJson = (value: unknown): JsonValue => {
  if (value === undefined) return null;
  if (value instanceof Error) return errorToJson(value);
  if (isJsonValue(value)) return value;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) return null;
    const parsed = JSON.parse(serialized);
    return isJsonValue(parsed) ? parsed : { message: String(value) };
  } catch {
    return { message: String(value) };
  }
};

const dbosStatusToWorkflowExecutionStatus = (
  status: string,
  output: unknown,
  error: unknown,
): WorkflowExecutionStatus => {
  if (status === 'SUCCESS') return { status: 'completed', output: unknownToJson(output) };
  if (status === 'ERROR' || status === 'MAX_RECOVERY_ATTEMPTS_EXCEEDED') {
    return {
      status: 'failed',
      error: unknownToJson(error ?? { message: `DBOS workflow ended with status ${status}.` }),
    };
  }
  if (status === 'CANCELLED') {
    return { status: 'cancelled', error: unknownToJson(error ?? { message: 'DBOS workflow was cancelled.' }) };
  }
  return { status: 'running' };
};
