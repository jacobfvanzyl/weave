import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { requireWeaveDatabaseUrl } from './database-url';
import * as schema from './schema';

const { Pool } = pg;

export type WeaveDbStatement = string | {
  sql: string;
  args?: unknown[];
};

export type WeaveDbResult = {
  rows: Record<string, unknown>[];
  rowsAffected: number;
};

export interface WeaveDbClient {
  execute(statement: WeaveDbStatement): Promise<WeaveDbResult>;
  batch(statements: WeaveDbStatement[], mode?: 'read' | 'write'): Promise<WeaveDbResult[]>;
}

let pool: pg.Pool | undefined;
let client: WeaveDbClient | undefined;

export const getWeavePgPool = () => {
  if (!pool) {
    pool = new Pool({
      connectionString: requireWeaveDatabaseUrl(),
      options: '-c search_path=weave,public',
    });
  }
  return pool;
};

export const getWeaveDrizzle = () => drizzle(getWeavePgPool(), { schema });

export const getWeaveDb = (): Promise<WeaveDbClient> => {
  if (!client) client = new PgWeaveDbClient(getWeavePgPool());
  return Promise.resolve(client);
};

export const closeWeaveDb = async () => {
  const current = pool;
  pool = undefined;
  client = undefined;
  await current?.end();
};

export class PgWeaveDbClient implements WeaveDbClient {
  constructor(private readonly pool: pg.Pool) {}

  async execute(statement: WeaveDbStatement) {
    const normalized = normalizeStatement(statement);
    const result = await this.pool.query(translatePlaceholders(normalized.sql), normalized.args);
    return {
      rows: result.rows.map(normalizeRow),
      rowsAffected: result.rowCount ?? 0,
    };
  }

  async batch(statements: WeaveDbStatement[]) {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const results: WeaveDbResult[] = [];
      for (const statement of statements) {
        const normalized = normalizeStatement(statement);
        const result = await connection.query(translatePlaceholders(normalized.sql), normalized.args);
        results.push({
          rows: result.rows.map(normalizeRow),
          rowsAffected: result.rowCount ?? 0,
        });
      }
      await connection.query('COMMIT');
      return results;
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }
}

const normalizeStatement = (statement: WeaveDbStatement): { sql: string; args: unknown[] } =>
  typeof statement === 'string' ? { sql: statement, args: [] } : {
    sql: statement.sql,
    args: (statement.args ?? []).map((arg) => arg === undefined ? null : arg),
  };

const translatePlaceholders = (sql: string) => {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
};

const normalizeRow = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]));

const normalizeValue = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value;
};

export const __postgresTest = {
  translatePlaceholders,
  normalizeRow,
};
