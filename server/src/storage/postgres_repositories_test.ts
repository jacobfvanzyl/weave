import pg from 'pg';
import { ProductProjectRepository } from '../products/project-repository';
import { PostgresServiceBindingRepository } from '../services/bindings';
import { PortalRepository } from '../portal/store';
import { PostgresWorkflowRepository } from '../workflows/repository';
import type { WorkflowDefinition } from '../workflows/definition';
import { PgWeaveDbClient } from './postgres';
import { WorkspaceCompositionRepository } from '../modules/workspace-composition/repository.ts';

const { Pool } = pg;

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const workflowDefinition = (): WorkflowDefinition => ({
  id: 'postgres-smoke-workflow',
  version: '1',
  name: 'Postgres Smoke Workflow',
  initialStateId: 'end',
  grants: [],
  states: {
    end: { type: 'end', result: { ok: true } },
  },
});

const migrateWeaveSchema = async (pool: pg.Pool) => {
  for (const migration of ['0000_initial_weave.sql', '0006_workspace_compositions.sql']) {
    const sql = await Deno.readTextFile(new URL(`../../drizzle/${migration}`, import.meta.url));
    await pool.query(sql);
  }
};

const cleanupOwner = async (pool: pg.Pool, ownerId: string) => {
  await pool.query('DELETE FROM weave.workspace_compositions WHERE owner_id = $1', [ownerId]);
  await pool.query('DELETE FROM weave.workflow_run_events WHERE owner_id = $1', [ownerId]);
  await pool.query('DELETE FROM weave.workflow_runs WHERE owner_id = $1', [ownerId]);
  await pool.query('DELETE FROM weave.workflow_definitions WHERE owner_id = $1', [ownerId]);
  await pool.query('DELETE FROM weave.portal_tokens WHERE owner_id = $1', [ownerId]);
  await pool.query('DELETE FROM weave.portal_settings WHERE owner_id = $1', [ownerId]);
  await pool.query('DELETE FROM weave.service_bindings WHERE owner_id = $1', [ownerId]);
  await pool.query('DELETE FROM weave.product_projects WHERE owner_id = $1', [ownerId]);
};

Deno.test('Postgres repositories exercise Weave-owned schema', async () => {
  const databaseUrl = process.env.WEAVE_POSTGRES_TEST_DATABASE_URL;
  if (!databaseUrl) return;

  const pool = new Pool({
    connectionString: databaseUrl,
    options: '-c search_path=weave,public',
  });
  const ownerId = `owner-${crypto.randomUUID()}`;
  const client = new PgWeaveDbClient(pool);
  const getClient = () => Promise.resolve(client);

  try {
    await migrateWeaveSchema(pool);
    await cleanupOwner(pool, ownerId);

    const now = new Date().toISOString();
    const projects = new ProductProjectRepository(getClient);
    await projects.save({
      id: 'project-1',
      userId: ownerId,
      name: 'Project 1',
      projectKind: 'git',
      repoPath: '/tmp/project-1',
      workspaces: [{
        id: 'workspace-1',
        projectId: 'project-1',
        workspaceKind: 'primary',
        name: 'Workspace 1',
        status: 'ready',
        createdAt: now,
        updatedAt: now,
      }],
      createdAt: now,
      updatedAt: now,
    });
    assertEquals((await projects.get(ownerId, 'project-1', 'code'))?.name, 'Project 1');

    const composition = await new WorkspaceCompositionRepository(getClient).getOrCreate(ownerId, 'workspace-1');
    const restartedComposition = await new WorkspaceCompositionRepository(getClient).getOrCreate(
      ownerId,
      'workspace-1',
    );
    assertEquals(composition.tabs[0]?.name, 'New Tab');
    assertEquals(restartedComposition, composition);

    const bindings = new PostgresServiceBindingRepository(getClient);
    const binding = await bindings.upsert({
      ownerId,
      bindingId: 'binding-1',
      providerKind: 'portal',
      scopeKind: 'portal-target',
      data: { portalId: 'portal-1', workspacePath: '/tmp/project-1' },
    });
    assertEquals(binding.data, { portalId: 'portal-1', workspacePath: '/tmp/project-1' });
    assertEquals((await bindings.list(ownerId)).length, 1);

    const portals = new PortalRepository(getClient);
    await portals.setPrimaryPortalId(ownerId, 'portal-1');
    await portals.saveToken({ ownerId, portalId: 'portal-1', token: `token-${ownerId}` });
    assertEquals(await portals.getPrimaryPortalId(ownerId), 'portal-1');
    assertEquals((await portals.findToken('portal-1', `token-${ownerId}`))?.ownerId, ownerId);

    const workflows = new PostgresWorkflowRepository(getClient);
    await workflows.saveDefinition(ownerId, workflowDefinition());
    const run = await workflows.createRun({
      ownerId,
      runId: 'run-1',
      definition: workflowDefinition(),
      input: { prompt: 'hello' },
    });
    assertEquals(run.status, 'running');

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        workflows.appendRunEvent({
          ownerId,
          runId: 'run-1',
          eventId: `event-${index}`,
          type: 'workflow.run.event',
          data: { index },
        })),
    );
    assertEquals((await workflows.listRunEvents(ownerId, 'run-1')).map((event) => event.sequence), [
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
    ]);
  } finally {
    await cleanupOwner(pool, ownerId).catch(() => undefined);
    await pool.end();
  }
});
