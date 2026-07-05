import { callerForOwner, isJsonValue, type JsonValue } from '../services/types';
import type { EventService } from '../services/event-service';
import { eventService as defaultEventService } from '../services/event-service';
import { startDbosWorkflowExecution } from './dbos-runtime';
import { validateWorkflowDefinition, type WorkflowDefinition, type WorkflowRunInput } from './definition';
import { executeWorkflowDefinition } from './runner';
import {
  type StoredWorkflowDefinition,
  type WorkflowRepository,
  workflowRepository,
  type WorkflowRunBackend,
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

export interface WorkflowRunExecutor {
  start(input: WorkflowRunInput): Promise<WorkflowExecutionStart>;
}

export type WorkflowControlServiceDeps = {
  repository?: WorkflowRepository;
  executor?: WorkflowRunExecutor;
  events?: EventService;
};

export class DefaultWorkflowRunExecutor implements WorkflowRunExecutor {
  async start(input: WorkflowRunInput): Promise<WorkflowExecutionStart> {
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
      result: executeWorkflowDefinition(input),
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

  getRun(ownerId: string, runId: string) {
    return this.repository.getRun(ownerId, runId);
  }

  listRuns(ownerId: string, options?: { workflowId?: string; limit?: number }) {
    return this.repository.listRuns(ownerId, options);
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
      const execution = await this.executor.start({
        ownerId: input.ownerId,
        workflowRunId: run.runId,
        requestId: input.requestId,
        definition: storedDefinition.definition,
        input: runInput,
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

  private async settleRun(ownerId: string, runId: string, resultPromise: Promise<JsonValue>) {
    try {
      const output = await resultPromise;
      await this.repository.completeRun(ownerId, runId, output);
      await this.publishRunEvent(ownerId, runId, 'workflow.run.completed', output);
    } catch (error) {
      const failure = errorToJson(error);
      await this.repository.failRun(ownerId, runId, failure);
      await this.publishRunEvent(ownerId, runId, 'workflow.run.failed', failure);
    }
  }

  private publishRunEvent(ownerId: string, runId: string, type: string, data: JsonValue) {
    return this.events.publishRunEvent(callerForOwner(ownerId, 'system'), {
      runKind: 'workflow',
      runId,
      type,
      data,
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
