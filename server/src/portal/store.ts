import { getWeaveDb } from '../storage/weave-db';
import type { Client } from '@libsql/client';

export type PortalOwnerSettings = {
  ownerId: string;
  primaryPortalId?: string;
  createdAt: string;
  updatedAt: string;
};

export type PortalTokenRecord = {
  ownerId: string;
  portalId: string;
  token: string;
  status: 'issued' | 'revoked';
  createdAt: string;
  updatedAt: string;
};

const nowIso = () => new Date().toISOString();

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const portalSettingsFromRow = (row: Record<string, unknown>): PortalOwnerSettings => ({
  ownerId: String(row.owner_id),
  ...(optionalString(row.primary_portal_id) ? { primaryPortalId: optionalString(row.primary_portal_id) } : {}),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

const portalTokenFromRow = (row: Record<string, unknown>): PortalTokenRecord => ({
  ownerId: String(row.owner_id),
  portalId: String(row.portal_id),
  token: String(row.token),
  status: row.status === 'revoked' ? 'revoked' : 'issued',
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

export class PortalRepository {
  constructor(private readonly getClient: () => Promise<Client> = getWeaveDb) {}

  async getSettings(ownerId: string) {
    const db = await this.getClient();
    const result = await db.execute({
      sql: `SELECT owner_id, primary_portal_id, created_at, updated_at
        FROM weave_portal_settings
        WHERE owner_id = ?
        LIMIT 1`,
      args: [ownerId],
    });
    const row = result.rows[0];
    return row ? portalSettingsFromRow(row as Record<string, unknown>) : undefined;
  }

  async getPrimaryPortalId(ownerId: string) {
    return (await this.getSettings(ownerId))?.primaryPortalId;
  }

  async setPrimaryPortalId(ownerId: string, portalId: string) {
    const at = nowIso();
    const db = await this.getClient();
    await db.execute({
      sql: `INSERT INTO weave_portal_settings (
          owner_id, primary_portal_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(owner_id) DO UPDATE SET
          primary_portal_id = excluded.primary_portal_id,
          updated_at = excluded.updated_at`,
      args: [ownerId, portalId, at, at],
    });
    return {
      ownerId,
      primaryPortalId: portalId,
      createdAt: at,
      updatedAt: at,
    } satisfies PortalOwnerSettings;
  }

  async saveToken(input: {
    ownerId: string;
    portalId: string;
    token: string;
    status?: PortalTokenRecord['status'];
  }) {
    const at = nowIso();
    const status = input.status ?? 'issued';
    const db = await this.getClient();
    await db.execute({
      sql: `INSERT INTO weave_portal_tokens (
          owner_id, portal_id, token, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, portal_id) DO UPDATE SET
          token = excluded.token,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      args: [input.ownerId, input.portalId, input.token, status, at, at],
    });
    return {
      ownerId: input.ownerId,
      portalId: input.portalId,
      token: input.token,
      status,
      createdAt: at,
      updatedAt: at,
    } satisfies PortalTokenRecord;
  }

  async getToken(ownerId: string, portalId: string) {
    const db = await this.getClient();
    const result = await db.execute({
      sql: `SELECT owner_id, portal_id, token, status, created_at, updated_at
        FROM weave_portal_tokens
        WHERE owner_id = ? AND portal_id = ?
        LIMIT 1`,
      args: [ownerId, portalId],
    });
    const row = result.rows[0];
    return row ? portalTokenFromRow(row as Record<string, unknown>) : undefined;
  }

  async findToken(portalId: string, token: string) {
    const db = await this.getClient();
    const result = await db.execute({
      sql: `SELECT owner_id, portal_id, token, status, created_at, updated_at
        FROM weave_portal_tokens
        WHERE portal_id = ? AND token = ? AND status = 'issued'
        LIMIT 1`,
      args: [portalId, token],
    });
    const row = result.rows[0];
    return row ? portalTokenFromRow(row as Record<string, unknown>) : undefined;
  }
}

export const portalRepository = new PortalRepository();
