import { type Client, createClient, type InStatement } from '@libsql/client';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const serverRoot = process.cwd();
const defaultDataDir = join(serverRoot, '.data');

export const weaveDataDir = process.env.WEAVE_DATA_DIR ??
  process.env.MASTRA_LOCAL_DATA_DIR ??
  defaultDataDir;

mkdirSync(weaveDataDir, { recursive: true });

export const weaveDbUrl = process.env.WEAVE_METADATA_DATABASE_URL ??
  pathToFileURL(join(weaveDataDir, 'weave.db')).href;

export const weaveDbAuthToken = process.env.WEAVE_METADATA_AUTH_TOKEN;

let client: Client | undefined;
let initPromise: Promise<Client> | undefined;

const createWeaveDbClient = () =>
  createClient({
    url: weaveDbUrl,
    authToken: weaveDbAuthToken,
  });

const workflowMigrations: InStatement[] = [
  `CREATE TABLE IF NOT EXISTS weave_workflow_definitions (
    owner_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    version TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    definition TEXT NOT NULL,
    PRIMARY KEY (owner_id, workflow_id)
  )`,
  `CREATE INDEX IF NOT EXISTS weave_workflow_definitions_owner_updated_idx
    ON weave_workflow_definitions(owner_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS weave_workflow_runs (
    owner_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    workflow_version TEXT NOT NULL,
    status TEXT NOT NULL,
    backend TEXT NOT NULL,
    external_run_id TEXT,
    request_id TEXT,
    input TEXT NOT NULL,
    output TEXT,
    error TEXT,
    definition TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    PRIMARY KEY (owner_id, run_id)
  )`,
  `CREATE INDEX IF NOT EXISTS weave_workflow_runs_owner_updated_idx
    ON weave_workflow_runs(owner_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS weave_workflow_runs_owner_workflow_idx
    ON weave_workflow_runs(owner_id, workflow_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS weave_workflow_run_events (
    owner_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, run_id, sequence),
    UNIQUE (owner_id, run_id, event_id)
  )`,
  `CREATE INDEX IF NOT EXISTS weave_workflow_run_events_owner_run_created_idx
    ON weave_workflow_run_events(owner_id, run_id, created_at)`,
];

const migrations: InStatement[] = [
  `CREATE TABLE IF NOT EXISTS weave_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS weave_product_projects (
    owner_id TEXT NOT NULL,
    product TEXT NOT NULL,
    project_id TEXT NOT NULL,
    project_kind TEXT NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (owner_id, product, project_id)
  )`,
  `CREATE INDEX IF NOT EXISTS weave_product_projects_owner_product_updated_idx
    ON weave_product_projects(owner_id, product, updated_at)`,
  `CREATE INDEX IF NOT EXISTS weave_product_projects_owner_project_idx
    ON weave_product_projects(owner_id, project_id)`,
  `CREATE TABLE IF NOT EXISTS weave_service_bindings (
    owner_id TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    provider_kind TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, binding_id)
  )`,
  `CREATE INDEX IF NOT EXISTS weave_service_bindings_owner_provider_idx
    ON weave_service_bindings(owner_id, provider_kind, updated_at)`,
  `CREATE TABLE IF NOT EXISTS weave_portal_settings (
    owner_id TEXT PRIMARY KEY,
    primary_portal_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS weave_portal_tokens (
    owner_id TEXT NOT NULL,
    portal_id TEXT NOT NULL,
    token TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, portal_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS weave_portal_tokens_token_idx
    ON weave_portal_tokens(token)`,
  ...workflowMigrations,
];

const tableColumns = async (db: Client, table: string) => {
  const result = await db.execute(`PRAGMA table_info(${table})`);
  return new Set(result.rows.map((row) => String((row as Record<string, unknown>).name)));
};

const renameLegacyTable = async (db: Client, table: string) => {
  const suffix = new Date().toISOString().replace(/\D/g, '');
  await db.execute(`ALTER TABLE ${table} RENAME TO ${table}_legacy_${suffix}`);
};

const ensureWorkflowSchema = async (db: Client) => {
  const expectedColumns = new Map<string, { required: string[]; legacy: string[] }>([
    ['weave_workflow_definitions', {
      required: ['owner_id', 'workflow_id', 'version', 'name', 'definition'],
      legacy: ['active_version_id', 'data'],
    }],
    [
      'weave_workflow_runs',
      {
        required: ['owner_id', 'run_id', 'workflow_id', 'workflow_version', 'status', 'backend', 'input', 'definition'],
        legacy: ['version_id', 'source', 'context', 'trigger_run_id', 'completed_at'],
      },
    ],
    [
      'weave_workflow_run_events',
      {
        required: ['owner_id', 'run_id', 'event_id', 'sequence', 'type', 'data', 'created_at'],
        legacy: ['state_id', 'payload'],
      },
    ],
  ]);

  let renamedLegacyWorkflowTable = false;
  for (const [table, columnsSpec] of expectedColumns) {
    const columns = await tableColumns(db, table);
    if (columns.size === 0) continue;
    const hasRequiredColumns = columnsSpec.required.every((column) => columns.has(column));
    const hasLegacyColumns = columnsSpec.legacy.some((column) => columns.has(column));
    if (hasRequiredColumns && !hasLegacyColumns) continue;
    await renameLegacyTable(db, table);
    renamedLegacyWorkflowTable = true;
  }

  if (renamedLegacyWorkflowTable) await db.batch(workflowMigrations, 'write');
};

export const getWeaveDb = () => {
  if (client) return Promise.resolve(client);
  if (!initPromise) {
    initPromise = (async () => {
      const nextClient = createWeaveDbClient();
      await nextClient.batch(migrations, 'write');
      await ensureWorkflowSchema(nextClient);
      client = nextClient;
      return nextClient;
    })();
  }
  return initPromise;
};

export const __weaveDbTest = {
  createWeaveDbClient,
  defaultDataDir,
  existsSync,
};
