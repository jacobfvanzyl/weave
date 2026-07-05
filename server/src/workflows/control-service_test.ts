import { WorkflowControlService, type WorkflowExecutionStart, type WorkflowRunExecutor } from './control-service.ts';
import type { WorkflowDefinition, WorkflowRunInput } from './definition.ts';
import { LibsqlWorkflowRepository } from './repository.ts';
import type { EventService } from '../services/event-service.ts';
import type { JsonValue } from '../services/types.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
};

const definition = (): WorkflowDefinition => ({
  id: 'workflow-1',
  version: '1',
  name: 'Workflow',
  initialStateId: 'end',
  grants: [],
  states: {
    end: { type: 'end', result: { $ref: 'input.result' } },
  },
});

const createFakeClient = () => {
  const definitions = new Map<string, Record<string, unknown>>();
  const runs = new Map<string, Record<string, unknown>>();
  const events: Record<string, unknown>[] = [];
  return {
    execute(statement: { sql: string; args?: unknown[] }) {
      const sql = statement.sql;
      const args = statement.args ?? [];

      if (sql.includes('INSERT INTO weave_workflow_definitions')) {
        const [ownerId, workflowId, version, name, createdAt, updatedAt, rawDefinition] = args;
        definitions.set(`${ownerId}:${workflowId}`, {
          owner_id: ownerId,
          workflow_id: workflowId,
          version,
          name,
          created_at: createdAt,
          updated_at: updatedAt,
          definition: rawDefinition,
        });
        return { rows: [], rowsAffected: 1 };
      }

      if (sql.includes('FROM weave_workflow_definitions') && sql.includes('workflow_id = ?')) {
        const row = definitions.get(`${args[0]}:${args[1]}`);
        return { rows: row ? [row] : [] };
      }

      if (sql.includes('FROM weave_workflow_definitions') && sql.includes('WHERE owner_id = ?')) {
        return { rows: [...definitions.values()].filter((row) => row.owner_id === args[0]) };
      }

      if (sql.includes('DELETE FROM weave_workflow_definitions')) {
        const deleted = definitions.delete(`${args[0]}:${args[1]}`);
        return { rows: [], rowsAffected: deleted ? 1 : 0 };
      }

      if (sql.includes('INSERT INTO weave_workflow_runs')) {
        const [
          ownerId,
          runId,
          workflowId,
          workflowVersion,
          status,
          backend,
          externalRunId,
          requestId,
          input,
          rawDefinition,
          createdAt,
          updatedAt,
        ] = args;
        runs.set(`${ownerId}:${runId}`, {
          owner_id: ownerId,
          run_id: runId,
          workflow_id: workflowId,
          workflow_version: workflowVersion,
          status,
          backend,
          external_run_id: externalRunId,
          request_id: requestId,
          input,
          output: null,
          error: null,
          definition: rawDefinition,
          created_at: createdAt,
          updated_at: updatedAt,
          started_at: null,
          finished_at: null,
        });
        return { rows: [], rowsAffected: 1 };
      }

      if (sql.includes('UPDATE weave_workflow_runs') && sql.includes('SET backend = ?')) {
        const [backend, externalRunId, startedAt, updatedAt, ownerId, runId] = args;
        const row = runs.get(`${ownerId}:${runId}`);
        if (row) {
          row.backend = backend;
          row.external_run_id = externalRunId;
          row.started_at = row.started_at ?? startedAt;
          row.updated_at = updatedAt;
        }
        return { rows: [], rowsAffected: row ? 1 : 0 };
      }

      if (sql.includes('UPDATE weave_workflow_runs') && sql.includes('SET status = ?')) {
        const [status, output, error, finishedAt, updatedAt, ownerId, runId] = args;
        const row = runs.get(`${ownerId}:${runId}`);
        if (row && row.status === 'running') {
          row.status = status;
          row.output = output;
          row.error = error;
          row.finished_at = finishedAt;
          row.updated_at = updatedAt;
        }
        return { rows: [], rowsAffected: row?.status === status ? 1 : 0 };
      }

      if (sql.includes('INSERT INTO weave_workflow_run_events')) {
        const [ownerId, runId, eventId, sequenceOwnerId, sequenceRunId, type, data, createdAt] = args;
        const existing = events.find((row) =>
          row.owner_id === ownerId && row.run_id === runId && row.event_id === eventId
        );
        if (!existing) {
          const sequence = events
            .filter((row) => row.owner_id === sequenceOwnerId && row.run_id === sequenceRunId)
            .reduce((max, row) => Math.max(max, Number(row.sequence)), 0) + 1;
          events.push({
            owner_id: ownerId,
            run_id: runId,
            event_id: eventId,
            sequence,
            type,
            data,
            created_at: createdAt,
          });
        }
        return { rows: [], rowsAffected: existing ? 0 : 1 };
      }

      if (sql.includes('FROM weave_workflow_run_events') && sql.includes('event_id = ?')) {
        const row = events.find((event) =>
          event.owner_id === args[0] && event.run_id === args[1] && event.event_id === args[2]
        );
        return { rows: row ? [row] : [] };
      }

      if (sql.includes('FROM weave_workflow_run_events') && sql.includes('sequence > ?')) {
        return {
          rows: events
            .filter((event) =>
              event.owner_id === args[0] && event.run_id === args[1] && Number(event.sequence) > Number(args[2])
            )
            .sort((left, right) => Number(left.sequence) - Number(right.sequence))
            .slice(0, Number(args[3])),
        };
      }

      if (sql.includes('FROM weave_workflow_runs') && sql.includes('run_id = ?')) {
        const row = runs.get(`${args[0]}:${args[1]}`);
        return { rows: row ? [row] : [] };
      }

      if (sql.includes('FROM weave_workflow_runs') && sql.includes('workflow_id = ?')) {
        return { rows: [...runs.values()].filter((row) => row.owner_id === args[0] && row.workflow_id === args[1]) };
      }

      if (sql.includes('FROM weave_workflow_runs') && sql.includes('WHERE owner_id = ?')) {
        return { rows: [...runs.values()].filter((row) => row.owner_id === args[0]) };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
};

const createEventService = () =>
  ({
    publishRunEvent: () =>
      Promise.resolve({
        id: 'evt-1',
        ownerId: 'owner-1',
        stream: 'workflow-run:run-1',
        type: 'workflow.run.event',
        data: {},
        createdAt: 'now',
        sequence: 1,
      }),
  }) as unknown as EventService;

Deno.test('WorkflowControlService starts and settles workflow runs through the executor', async () => {
  const client = createFakeClient();
  const repository = new LibsqlWorkflowRepository(() => Promise.resolve(client as never));
  const deferred = createDeferred<JsonValue>();
  let executionInput: WorkflowRunInput | undefined;
  const executor: WorkflowRunExecutor = {
    start(input): Promise<WorkflowExecutionStart> {
      executionInput = input;
      return Promise.resolve({
        backend: 'direct',
        result: deferred.promise,
      });
    },
  };
  const service = new WorkflowControlService(repository, executor, createEventService());
  await service.saveDefinition('owner-1', definition());

  const run = await service.startRun({
    ownerId: 'owner-1',
    workflowId: 'workflow-1',
    runId: 'run-1',
    requestId: 'request-1',
    input: { result: 'done' },
  });
  assertEquals(run.status, 'running');
  assertEquals(run.backend, 'direct');
  assertEquals(executionInput?.workflowRunId, 'run-1');
  assertEquals(executionInput?.input, { result: 'done' });

  deferred.resolve('done');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const completed = await service.getRun('owner-1', 'run-1');
  assertEquals(completed?.status, 'completed');
  assertEquals(completed?.output, 'done');
  assertEquals((await service.listRunEvents('owner-1', 'run-1')).map((event) => event.type), [
    'workflow.run.created',
    'workflow.run.started',
    'workflow.run.completed',
  ]);
});

Deno.test('WorkflowControlService marks runs failed when execution rejects', async () => {
  const client = createFakeClient();
  const repository = new LibsqlWorkflowRepository(() => Promise.resolve(client as never));
  const executor: WorkflowRunExecutor = {
    start(): Promise<WorkflowExecutionStart> {
      return Promise.resolve({
        backend: 'direct',
        result: Promise.reject(new Error('executor failed')),
      });
    },
  };
  const service = new WorkflowControlService(repository, executor, createEventService());
  await service.saveDefinition('owner-1', definition());

  await service.startRun({ ownerId: 'owner-1', workflowId: 'workflow-1', runId: 'run-1' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const failed = await service.getRun('owner-1', 'run-1');
  assertEquals(failed?.status, 'failed');
  assertEquals((failed?.error as { message?: string })?.message, 'executor failed');
});

Deno.test('WorkflowControlService reconciles DBOS-backed running runs on read', async () => {
  const client = createFakeClient();
  const repository = new LibsqlWorkflowRepository(() => Promise.resolve(client as never));
  const executor: WorkflowRunExecutor = {
    start(): Promise<WorkflowExecutionStart> {
      return Promise.resolve({
        backend: 'dbos',
        externalRunId: 'dbos-run-1',
        result: new Promise(() => undefined),
      });
    },
    getStatus: () => Promise.resolve({ status: 'completed', output: { ok: true } }),
  };
  const service = new WorkflowControlService(repository, executor, createEventService());
  await service.saveDefinition('owner-1', definition());
  await service.startRun({ ownerId: 'owner-1', workflowId: 'workflow-1', runId: 'run-1' });

  const reconciled = await service.getRun('owner-1', 'run-1');
  assertEquals(reconciled?.status, 'completed');
  assertEquals(reconciled?.output, { ok: true });
  assertEquals((await service.listRunEvents('owner-1', 'run-1')).map((event) => event.type), [
    'workflow.run.created',
    'workflow.run.started',
    'workflow.run.completed',
  ]);
});

Deno.test('WorkflowControlService cancels running runs and ignores late direct completion', async () => {
  const client = createFakeClient();
  const repository = new LibsqlWorkflowRepository(() => Promise.resolve(client as never));
  const deferred = createDeferred<JsonValue>();
  const executor: WorkflowRunExecutor = {
    start(): Promise<WorkflowExecutionStart> {
      return Promise.resolve({
        backend: 'direct',
        result: deferred.promise,
      });
    },
  };
  const service = new WorkflowControlService(repository, executor, createEventService());
  await service.saveDefinition('owner-1', definition());
  await service.startRun({ ownerId: 'owner-1', workflowId: 'workflow-1', runId: 'run-1' });

  const cancelled = await service.cancelRun('owner-1', 'run-1');
  assertEquals(cancelled.status, 'cancelled');

  deferred.resolve('late output');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stillCancelled = await service.getRun('owner-1', 'run-1');
  assertEquals(stillCancelled?.status, 'cancelled');
  assertEquals(stillCancelled?.output, undefined);
  assertEquals((await service.listRunEvents('owner-1', 'run-1')).map((event) => event.type), [
    'workflow.run.created',
    'workflow.run.started',
    'workflow.run.cancelled',
  ]);
});

Deno.test('WorkflowControlService uses executor cancellation status for DBOS-backed runs', async () => {
  const client = createFakeClient();
  const repository = new LibsqlWorkflowRepository(() => Promise.resolve(client as never));
  let cancelledRunId: string | undefined;
  const executor: WorkflowRunExecutor = {
    start(): Promise<WorkflowExecutionStart> {
      return Promise.resolve({
        backend: 'dbos',
        externalRunId: 'dbos-run-1',
        result: new Promise(() => undefined),
      });
    },
    cancel: (run) => {
      cancelledRunId = run.externalRunId;
      return Promise.resolve({ status: 'cancelled', error: { message: 'cancelled in DBOS' } });
    },
  };
  const service = new WorkflowControlService(repository, executor, createEventService());
  await service.saveDefinition('owner-1', definition());
  await service.startRun({ ownerId: 'owner-1', workflowId: 'workflow-1', runId: 'run-1' });

  const cancelled = await service.cancelRun('owner-1', 'run-1');
  assertEquals(cancelledRunId, 'dbos-run-1');
  assertEquals(cancelled.status, 'cancelled');
  assertEquals(cancelled.error, { message: 'cancelled in DBOS' });
});
