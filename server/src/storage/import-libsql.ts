import { createClient } from '@libsql/client';
import pg from 'pg';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireWeaveDatabaseUrl } from './database-url';

const { Pool } = pg;

type Args = {
  dryRun: boolean;
  reindexMastra: boolean;
  sourceWeave: string;
  sourceMastra: string[];
};

type CopyMapping = {
  source: string;
  destination: string;
  columns: string[];
  conflictColumns: string[];
  jsonColumns?: string[];
};

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const defaultWeaveSource = join(serverRoot, '.data', 'weave.db');
const defaultMastraSources = [
  join(serverRoot, '.data', 'mastra.db'),
  join(serverRoot, 'src', 'mastra', 'public', '.data', 'mastra.db'),
];

const activeWeaveMappings: CopyMapping[] = [
  {
    source: 'weave_product_projects',
    destination: 'weave.product_projects',
    columns: ['owner_id', 'product', 'project_id', 'project_kind', 'name', 'sort_order', 'created_at', 'updated_at', 'data'],
    conflictColumns: ['owner_id', 'product', 'project_id'],
    jsonColumns: ['data'],
  },
  {
    source: 'weave_service_bindings',
    destination: 'weave.service_bindings',
    columns: ['owner_id', 'binding_id', 'provider_kind', 'scope_kind', 'data', 'created_at', 'updated_at'],
    conflictColumns: ['owner_id', 'binding_id'],
    jsonColumns: ['data'],
  },
  {
    source: 'weave_portal_settings',
    destination: 'weave.portal_settings',
    columns: ['owner_id', 'primary_portal_id', 'created_at', 'updated_at'],
    conflictColumns: ['owner_id'],
  },
  {
    source: 'weave_portal_tokens',
    destination: 'weave.portal_tokens',
    columns: ['owner_id', 'portal_id', 'token', 'status', 'created_at', 'updated_at'],
    conflictColumns: ['owner_id', 'portal_id'],
  },
  {
    source: 'weave_workflow_definitions',
    destination: 'weave.workflow_definitions',
    columns: ['owner_id', 'workflow_id', 'version', 'name', 'created_at', 'updated_at', 'definition'],
    conflictColumns: ['owner_id', 'workflow_id'],
    jsonColumns: ['definition'],
  },
  {
    source: 'weave_workflow_runs',
    destination: 'weave.workflow_runs',
    columns: [
      'owner_id',
      'run_id',
      'workflow_id',
      'workflow_version',
      'status',
      'backend',
      'external_run_id',
      'request_id',
      'input',
      'output',
      'error',
      'definition',
      'created_at',
      'updated_at',
      'started_at',
      'finished_at',
    ],
    conflictColumns: ['owner_id', 'run_id'],
    jsonColumns: ['input', 'output', 'error', 'definition'],
  },
  {
    source: 'weave_workflow_run_events',
    destination: 'weave.workflow_run_events',
    columns: ['owner_id', 'run_id', 'event_id', 'sequence', 'type', 'data', 'created_at'],
    conflictColumns: ['owner_id', 'run_id', 'event_id'],
    jsonColumns: ['data'],
  },
];

const activeWeaveSourceTables = new Set(activeWeaveMappings.map((mapping) => mapping.source));
const ignoredLegacyTables = new Set(['weave_migrations']);
const mastraCoreTables = [
  'mastra_threads',
  'mastra_messages',
  'mastra_resources',
  'mastra_thread_state',
  'mastra_observational_memory',
];

const parseArgs = (rawArgs: string[]): Args => {
  const args: Args = {
    dryRun: false,
    reindexMastra: false,
    sourceWeave: defaultWeaveSource,
    sourceMastra: [],
  };
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--reindex-mastra') args.reindexMastra = true;
    else if (arg === '--source-weave') args.sourceWeave = requireNext(rawArgs, ++i, arg);
    else if (arg === '--source-mastra') args.sourceMastra.push(requireNext(rawArgs, ++i, arg));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.sourceMastra.length === 0) args.sourceMastra = defaultMastraSources;
  return args;
};

const requireNext = (args: string[], index: number, flag: string) => {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
};

const statExists = async (path: string) => {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
};

const resolveLibsqlUrl = (source: string) =>
  /^[a-z][a-z0-9+.-]*:/i.test(source) ? source : pathToFileURL(source).href;

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

const tableExists = async (client: ReturnType<typeof createClient>, table: string) => {
  const result = await client.execute({
    sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    args: [table],
  });
  return result.rows.length > 0;
};

const sqliteTableColumns = async (client: ReturnType<typeof createClient>, table: string) => {
  const result = await client.execute(`PRAGMA table_info(${quoteIdentifier(table)})`);
  return result.rows.map((row) => String(row.name)).filter(Boolean);
};

const postgresTableColumns = async (pool: pg.Pool, schema: string, table: string) => {
  const result = await pool.query<{ column_name: string }>(
    `SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [schema, table],
  );
  return result.rows.map((row) => row.column_name);
};

const selectRows = async (client: ReturnType<typeof createClient>, table: string) => {
  const result = await client.execute(`SELECT rowid AS __rowid, * FROM ${quoteIdentifier(table)}`);
  return result.rows.map((row) => normalizeRow(row as Record<string, unknown>));
};

const normalizeRow = (row: Record<string, unknown>) => {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return normalized;
};

const jsonValue = (value: unknown) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const jsonParam = (value: unknown) => JSON.stringify(jsonValue(value));

const insertRows = async (
  pool: pg.Pool,
  mapping: CopyMapping,
  rows: Record<string, unknown>[],
  dryRun: boolean,
) => {
  if (dryRun || rows.length === 0) return rows.length;

  const jsonColumns = new Set(mapping.jsonColumns ?? []);
  const updateColumns = mapping.columns.filter((column) => !mapping.conflictColumns.includes(column));
  const placeholders = mapping.columns
    .map((column, index) => jsonColumns.has(column) ? `$${index + 1}::jsonb` : `$${index + 1}`)
    .join(', ');
  const sql = `INSERT INTO ${mapping.destination} (${mapping.columns.map(quoteIdentifier).join(', ')})
    VALUES (${placeholders})
    ON CONFLICT (${mapping.conflictColumns.map(quoteIdentifier).join(', ')}) DO UPDATE SET
      ${updateColumns.map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(', ')}`;

  for (const row of rows) {
    const values = mapping.columns.map((column) => jsonColumns.has(column) ? jsonParam(row[column]) : row[column] ?? null);
    await pool.query(sql, values);
  }
  return rows.length;
};

const importWeaveActiveTables = async (
  pool: pg.Pool,
  client: ReturnType<typeof createClient>,
  dryRun: boolean,
) => {
  const counts: Record<string, number> = {};
  for (const mapping of activeWeaveMappings) {
    if (!await tableExists(client, mapping.source)) {
      counts[mapping.source] = 0;
      continue;
    }
    const rows = await selectRows(client, mapping.source);
    counts[mapping.source] = await insertRows(pool, mapping, rows, dryRun);
  }
  return counts;
};

const listSqliteTables = async (client: ReturnType<typeof createClient>) => {
  const result = await client.execute(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`);
  return result.rows.map((row) => String(row.name)).filter(Boolean);
};

const archiveLegacyRows = async (
  pool: pg.Pool,
  client: ReturnType<typeof createClient>,
  dryRun: boolean,
) => {
  const tables = (await listSqliteTables(client))
    .filter((table) => table.startsWith('weave_'))
    .filter((table) => !activeWeaveSourceTables.has(table))
    .filter((table) => !ignoredLegacyTables.has(table));

  const counts: Record<string, number> = {};
  for (const table of tables) {
    const rows = await selectRows(client, table);
    counts[table] = rows.length;
    if (dryRun) continue;
    for (const row of rows) {
      const sourcePrimaryKey = String(row.__rowid ?? `${table}:${crypto.randomUUID()}`);
      const { __rowid: _rowid, ...rowData } = row;
      await pool.query(
        `INSERT INTO weave.legacy_libsql_rows (source_table, source_primary_key, row_data, imported_at)
          VALUES ($1, $2, $3::jsonb, now())
          ON CONFLICT (source_table, source_primary_key) DO UPDATE SET
            row_data = excluded.row_data,
            imported_at = excluded.imported_at`,
        [table, sourcePrimaryKey, JSON.stringify(rowData)],
      );
    }
  }
  return counts;
};

const conflictColumnsForMastra = (table: string, columns: string[]) => {
  const candidates: Record<string, string[][]> = {
    mastra_threads: [['id']],
    mastra_messages: [['id']],
    mastra_resources: [['id']],
    mastra_thread_state: [['thread_id', 'type'], ['threadId', 'type'], ['id']],
    mastra_observational_memory: [['id']],
  };
  return (candidates[table] ?? []).find((candidate) => candidate.every((column) => columns.includes(column)));
};

const importMastraCoreTables = async (
  pool: pg.Pool,
  source: string,
  dryRun: boolean,
) => {
  const client = createClient({ url: resolveLibsqlUrl(source) });
  const counts: Record<string, number> = {};
  try {
    for (const table of mastraCoreTables) {
      if (!await tableExists(client, table)) {
        counts[table] = 0;
        continue;
      }
      const destinationColumns = await postgresTableColumns(pool, 'mastra', table);
      if (destinationColumns.length === 0) {
        counts[table] = 0;
        continue;
      }
      const sourceColumns = await sqliteTableColumns(client, table);
      const columns = destinationColumns.filter((column) => sourceColumns.includes(column));
      const rows = (await selectRows(client, table)).map((row) => {
        const picked: Record<string, unknown> = {};
        for (const column of columns) picked[column] = row[column] ?? null;
        return picked;
      });
      counts[table] = rows.length;
      if (dryRun || rows.length === 0 || columns.length === 0) continue;

      const conflictColumns = conflictColumnsForMastra(table, columns);
      const updateColumns = conflictColumns
        ? columns.filter((column) => !conflictColumns.includes(column))
        : [];
      const sql = `INSERT INTO mastra.${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')})
        VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})
        ${conflictColumns
          ? `ON CONFLICT (${conflictColumns.map(quoteIdentifier).join(', ')}) DO UPDATE SET ${
            updateColumns.length
              ? updateColumns.map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(', ')
              : `${quoteIdentifier(conflictColumns[0])} = excluded.${quoteIdentifier(conflictColumns[0])}`
          }`
          : 'ON CONFLICT DO NOTHING'}`;
      for (const row of rows) await pool.query(sql, columns.map((column) => row[column]));
    }
  } finally {
    client.close();
  }
  return counts;
};

const printCounts = (label: string, counts: Record<string, number>) => {
  console.info(`[db:import-libsql] ${label}`);
  for (const [table, count] of Object.entries(counts)) console.info(`  ${table}: ${count}`);
};

const main = async () => {
  const args = parseArgs(Deno.args);
  const pool = new Pool({ connectionString: requireWeaveDatabaseUrl() });
  try {
    if (!await statExists(args.sourceWeave)) {
      console.warn(`[db:import-libsql] Weave source not found: ${args.sourceWeave}`);
    } else {
      const weaveClient = createClient({ url: resolveLibsqlUrl(args.sourceWeave) });
      try {
        printCounts('active Weave tables', await importWeaveActiveTables(pool, weaveClient, args.dryRun));
        printCounts('archived legacy Weave tables', await archiveLegacyRows(pool, weaveClient, args.dryRun));
      } finally {
        weaveClient.close();
      }
    }

    let importedMastra = false;
    for (const source of args.sourceMastra) {
      if (!await statExists(source)) continue;
      importedMastra = true;
      printCounts(`core Mastra memory tables from ${basename(source)}`, await importMastraCoreTables(pool, source, args.dryRun));
      break;
    }
    if (!importedMastra) {
      console.warn(`[db:import-libsql] Mastra source not found: ${args.sourceMastra.join(', ')}`);
    }
    if (args.reindexMastra) {
      console.warn('[db:import-libsql] --reindex-mastra requested; vector rows are not binary-copied. Re-embedding imported history is a follow-up job.');
    }
  } finally {
    await pool.end();
  }
};

if (import.meta.main) {
  await main();
}
