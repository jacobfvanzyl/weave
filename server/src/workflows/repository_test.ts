import { LibsqlWorkflowRepository } from './repository.ts';
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
  return {
    execute(statement: { sql: string; args?: unknown[] }) {
      const sql = statement.sql;
      const args = statement.args ?? [];

      if (sql.includes('INSERT INTO weave_workflow_definitions')) {
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

      if (sql.includes('DELETE FROM weave_workflow_definitions')) {
        const deleted = definitions.delete(`${args[0]}:${args[1]}`);
        return { rows: [], rowsAffected: deleted ? 1 : 0 };
      }

      if (sql.includes('FROM weave_workflow_definitions') && sql.includes('workflow_id = ?')) {
        const row = definitions.get(`${args[0]}:${args[1]}`);
        return { rows: row ? [row] : [] };
      }

      if (sql.includes('FROM weave_workflow_definitions') && sql.includes('WHERE owner_id = ?')) {
        return {
          rows: [...definitions.values()]
            .filter((row) => row.owner_id === args[0])
            .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at))),
        };
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
        if (row) {
          row.status = status;
          row.output = output;
          row.error = error;
          row.finished_at = finishedAt;
          row.updated_at = updatedAt;
        }
        return { rows: [], rowsAffected: row ? 1 : 0 };
      }

      if (sql.includes('FROM weave_workflow_runs') && sql.includes('run_id = ?')) {
        const row = runs.get(`${args[0]}:${args[1]}`);
        return { rows: row ? [row] : [] };
      }

      if (sql.includes('FROM weave_workflow_runs') && sql.includes('workflow_id = ?')) {
        return {
          rows: [...runs.values()]
            .filter((row) => row.owner_id === args[0] && row.workflow_id === args[1])
            .slice(0, Number(args[2])),
        };
      }

      if (sql.includes('FROM weave_workflow_runs') && sql.includes('WHERE owner_id = ?')) {
        return {
          rows: [...runs.values()]
            .filter((row) => row.owner_id === args[0])
            .slice(0, Number(args[1])),
        };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
};

Deno.test('LibsqlWorkflowRepository stores owner-scoped workflow definitions', async () => {
  const client = createFakeClient();
  const repository = new LibsqlWorkflowRepository(() => Promise.resolve(client as never));
  await repository.saveDefinition('owner-1', definition());
  await repository.saveDefinition('owner-2', definition());

  assertEquals((await repository.getDefinition('owner-1', 'workflow-1'))?.ownerId, 'owner-1');
  assertEquals((await repository.getDefinition('owner-2', 'workflow-1'))?.ownerId, 'owner-2');
  assertEquals((await repository.listDefinitions('owner-1')).length, 1);

  assertEquals(await repository.deleteDefinition('owner-1', 'workflow-1'), true);
  assertEquals(await repository.getDefinition('owner-1', 'workflow-1'), undefined);
  assertEquals((await repository.getDefinition('owner-2', 'workflow-1'))?.ownerId, 'owner-2');
});

Deno.test('LibsqlWorkflowRepository stores and updates workflow run records', async () => {
  const client = createFakeClient();
  const repository = new LibsqlWorkflowRepository(() => Promise.resolve(client as never));
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
