import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresStore } from '@mastra/pg';
import pg from 'pg';
import { getMemoryCapabilities } from '../agent/mastra/memory-policy';
import { getMastraPostgresConfig } from '../agent/mastra/storage-config';
import { requireWeaveDatabaseUrl } from './database-url';

const { Pool } = pg;

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const drizzleDir = join(serverRoot, 'drizzle');

const checksum = (value: string) => createHash('sha256').update(value).digest('hex');

const listMigrationFiles = async () => {
  const files: string[] = [];
  for await (const entry of Deno.readDir(drizzleDir)) {
    if (entry.isFile && entry.name.endsWith('.sql')) files.push(entry.name);
  }
  return files.sort();
};

const createVectorExtension = async (pool: pg.Pool) => {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    return { ok: true } as const;
  } catch (error) {
    const capabilities = getMemoryCapabilities();
    if (capabilities.semanticRecall) {
      throw new Error(
        `Semantic recall is enabled but pgvector could not be installed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    console.warn(
      `[db:migrate] pgvector extension not available; semantic recall must remain disabled. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ok: false } as const;
  }
};

const runWeaveMigrations = async (pool: pg.Pool) => {
  await pool.query('CREATE SCHEMA IF NOT EXISTS weave');
  await pool.query(`CREATE TABLE IF NOT EXISTS weave.schema_migrations (
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const appliedResult = await pool.query<{ id: string; checksum: string }>(
    'SELECT id, checksum FROM weave.schema_migrations',
  );
  const applied = new Map(appliedResult.rows.map((row) => [row.id, row.checksum]));

  for (const file of await listMigrationFiles()) {
    const sql = await Deno.readTextFile(join(drizzleDir, file));
    const fileChecksum = checksum(sql);
    const existingChecksum = applied.get(file);
    if (existingChecksum) {
      if (existingChecksum !== fileChecksum) {
        throw new Error(`Migration ${file} checksum changed after it was applied.`);
      }
      console.info(`[db:migrate] ${file} already applied`);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO weave.schema_migrations (id, checksum) VALUES ($1, $2)',
        [file, fileChecksum],
      );
      await client.query('COMMIT');
      console.info(`[db:migrate] applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
};

const initializeMastraStorage = async () => {
  const store = new PostgresStore({
    id: 'mastra-storage-migrator',
    ...getMastraPostgresConfig(),
  });
  try {
    await store.init();
    console.info('[db:migrate] initialized Mastra Postgres storage');
  } finally {
    await store.close();
  }
};

const main = async () => {
  const databaseUrl = requireWeaveDatabaseUrl();
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query('CREATE SCHEMA IF NOT EXISTS weave');
    await pool.query('CREATE SCHEMA IF NOT EXISTS mastra');
    await pool.query('CREATE SCHEMA IF NOT EXISTS dbos');
    await createVectorExtension(pool);
    await runWeaveMigrations(pool);
    await initializeMastraStorage();
  } finally {
    await pool.end();
  }
};

if (import.meta.main) {
  await main();
}
