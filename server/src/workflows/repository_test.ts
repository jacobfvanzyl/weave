import { PostgresWorkflowRepository } from './repository.ts';
import type { WorkflowDefinition } from './definition.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const definition = (id = 'workflow-1'): WorkflowDefinition => ({
  id,
  version: '1',
  name: 'Workflow',
  initialStateId: 'end',
  grants: [],
  states: {
    end: { type: 'end', result: 'done' },
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

      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowsAffected: 0 };
      }

      if (sql.includes('INSERT INTO workflow_definitions')) {
        const [ownerId, workflowId, version, name, createdAt, updatedAt, rawDefinition] = args;
        const key = `${ownerId}:${workflowId}`;
        const existing = definitions.get(key);
        definitions.set(key, {
          owner_id: ownerId,
          workflow_id: workflowId,
          version,
          name,
          created_at: existing?.created_at ?? createdAt,
          updated_at: updatedAt,
          definition: rawDefinition,
        });
        return { rows: [], rowsAffected: 1 };
      }

      if (sql.includes('DELETE FROM workflow_definitions')) {
        const deleted = definitions.delete(`${args[0]}:${args[1]}`);
        return { rows: [], rowsAffected: deleted ? 1 : 0 };
      }

      if (sql.includes('FROM workflow_definitions') && sql.includes('workflow_id = ?')) {
        const row = definitions.get(`${args[0]}:${args[1]}`);
        return { rows: row ? [row] : [] };
      }

      if (sql.includes('FROM workflow_definitions') && sql.includes('WHERE owner_id = ?')) {
        return {
          rows: [...definitions.values()]
            .filter((row) => row.owner_id === args[0])
            .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at))),
        };
      }

      if (sql.includes('INSERT INTO workflow_runs')) {
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

      if (sql.includes('UPDATE workflow_runs') && sql.includes('SET backend = ?')) {
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

      if (sql.includes('UPDATE workflow_runs') && sql.includes('SET status = ?')) {
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

      if (sql.includes('INSERT INTO workflow_run_events')) {
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

      if (sql.includes('FROM workflow_run_events') && sql.includes('event_id = ?')) {
        const row = events.find((event) =>
          event.owner_id === args[0] && event.run_id === args[1] && event.event_id === args[2]
        );
        return { rows: row ? [row] : [] };
      }

      if (sql.includes('FROM workflow_run_events') && sql.includes('sequence > ?')) {
        return {
          rows: events
            .filter((event) =>
              event.owner_id === args[0] && event.run_id === args[1] && Number(event.sequence) > Number(args[2])
            )
            .sort((left, right) => Number(left.sequence) - Number(right.sequence))
            .slice(0, Number(args[3])),
        };
      }

      if (sql.includes('FROM workflow_runs') && sql.includes('run_id = ?')) {
        const row = runs.get(`${args[0]}:${args[1]}`);
        return { rows: row ? [row] : [] };
      }

      if (sql.includes('FROM workflow_runs') && sql.includes('workflow_id = ?')) {
        return {
          rows: [...runs.values()]
            .filter((row) => row.owner_id === args[0] && row.workflow_id === args[1])
            .slice(0, Number(args[2])),
        };
      }

      if (sql.includes('FROM workflow_runs') && sql.includes('WHERE owner_id = ?')) {
        return {
          rows: [...runs.values()]
            .filter((row) => row.owner_id === args[0])
            .slice(0, Number(args[1])),
        };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
    batch(statements: { sql: string; args?: unknown[] }[]) {
      return Promise.all(statements.map((statement) => this.execute(statement)));
    },
  };
};

Deno.test('PostgresWorkflowRepository stores owner-scoped workflow definitions', async () => {
  const client = createFakeClient();
  const repository = new PostgresWorkflowRepository(() => Promise.resolve(client as never));
  await repository.saveDefinition('owner-1', definition());
  await repository.saveDefinition('owner-2', definition());

  assertEquals((await repository.getDefinition('owner-1', 'workflow-1'))?.ownerId, 'owner-1');
  assertEquals((await repository.getDefinition('owner-2', 'workflow-1'))?.ownerId, 'owner-2');
  assertEquals((await repository.listDefinitions('owner-1')).length, 1);

  assertEquals(await repository.deleteDefinition('owner-1', 'workflow-1'), true);
  assertEquals(await repository.getDefinition('owner-1', 'workflow-1'), undefined);
  assertEquals((await repository.getDefinition('owner-2', 'workflow-1'))?.ownerId, 'owner-2');
});

Deno.test('PostgresWorkflowRepository stores and updates workflow run records', async () => {
  const client = createFakeClient();
  const repository = new PostgresWorkflowRepository(() => Promise.resolve(client as never));
  const run = await repository.createRun({
    ownerId: 'owner-1',
    runId: 'run-1',
    requestId: 'request-1',
    definition: definition(),
    input: { prompt: 'Hello' },
  });

  assertEquals(run.status, 'running');
  assertEquals(run.backend, 'pending');

  await repository.updateRunStarted('owner-1', 'run-1', { backend: 'dbos', externalRunId: 'dbos-run-1' });
  await repository.completeRun('owner-1', 'run-1', { ok: true });

  const completed = await repository.getRun('owner-1', 'run-1');
  assertEquals(completed?.status, 'completed');
  assertEquals(completed?.backend, 'dbos');
  assertEquals(completed?.externalRunId, 'dbos-run-1');
  assertEquals(completed?.output, { ok: true });
  assertEquals((await repository.listRuns('owner-1', { workflowId: 'workflow-1' })).map((item) => item.runId), [
    'run-1',
  ]);
});

Deno.test('PostgresWorkflowRepository marks running workflow runs cancelled without overwriting terminal runs', async () => {
  const client = createFakeClient();
  const repository = new PostgresWorkflowRepository(() => Promise.resolve(client as never));
  await repository.createRun({
    ownerId: 'owner-1',
    runId: 'run-1',
    definition: definition(),
    input: null,
  });

  const cancelled = await repository.cancelRun('owner-1', 'run-1');
  assertEquals(cancelled?.status, 'cancelled');
  assertEquals(cancelled?.error, { message: 'Workflow run was cancelled.' });

  await repository.completeRun('owner-1', 'run-1', 'late output');
  assertEquals((await repository.getRun('owner-1', 'run-1'))?.status, 'cancelled');
});

Deno.test('PostgresWorkflowRepository appends and replays workflow run events', async () => {
  const client = createFakeClient();
  const repository = new PostgresWorkflowRepository(() => Promise.resolve(client as never));

  const first = await repository.appendRunEvent({
    ownerId: 'owner-1',
    runId: 'run-1',
    eventId: 'event-1',
    type: 'workflow.run.started',
    data: { backend: 'direct' },
  });
  const duplicate = await repository.appendRunEvent({
    ownerId: 'owner-1',
    runId: 'run-1',
    eventId: 'event-1',
    type: 'workflow.run.started',
    data: { backend: 'direct' },
  });
  const second = await repository.appendRunEvent({
    ownerId: 'owner-1',
    runId: 'run-1',
    eventId: 'event-2',
    type: 'workflow.run.completed',
    data: 'done',
  });

  assertEquals(first.sequence, 1);
  assertEquals(duplicate.sequence, 1);
  assertEquals(second.sequence, 2);
  assertEquals((await repository.listRunEvents('owner-1', 'run-1')).map((event) => event.type), [
    'workflow.run.started',
    'workflow.run.completed',
  ]);
  assertEquals((await repository.listRunEvents('owner-1', 'run-1', { afterSequence: 1 })).map((event) => event.type), [
    'workflow.run.completed',
  ]);
});
