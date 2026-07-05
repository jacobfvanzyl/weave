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
];

export const getWeaveDb = async () => {
  if (client) return client;
  if (!initPromise) {
    initPromise = (async () => {
      const nextClient = createWeaveDbClient();
      await nextClient.batch(migrations, 'write');
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
