import type { Client } from '@libsql/client';
import { getWeaveDb } from '../storage/weave-db';
import type { JsonValue, ServiceCaller } from './types';
import { optionalString, ServiceError } from './types';

export type ServiceProviderKind = 'portal' | 'client' | 'server' | 'external';

export type ServiceBinding = {
  ownerId: string;
  bindingId: string;
  providerKind: ServiceProviderKind;
  scopeKind: string;
  data: JsonValue;
  createdAt: string;
  updatedAt: string;
};

export type UpsertServiceBindingInput = {
  ownerId: string;
  bindingId?: string;
  providerKind: ServiceProviderKind;
  scopeKind: string;
  data: JsonValue;
};

export interface ServiceBindingRepository {
  get(caller: Pick<ServiceCaller, 'ownerId'>, bindingId: string): Promise<ServiceBinding | undefined>;
  list(ownerId: string): Promise<ServiceBinding[]>;
  upsert(input: UpsertServiceBindingInput): Promise<ServiceBinding>;
  delete(caller: Pick<ServiceCaller, 'ownerId'>, bindingId: string): Promise<boolean>;
}

const parseBinding = (row: Record<string, unknown>): ServiceBinding => ({
  ownerId: String(row.owner_id),
  bindingId: String(row.binding_id),
  providerKind: String(row.provider_kind) as ServiceProviderKind,
  scopeKind: String(row.scope_kind),
  data: JSON.parse(String(row.data)) as JsonValue,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

export class LibsqlServiceBindingRepository implements ServiceBindingRepository {
  constructor(private readonly getClient: () => Promise<Client> = getWeaveDb) {}

  async get(caller: Pick<ServiceCaller, 'ownerId'>, bindingId: string) {
    const normalizedBindingId = optionalString(bindingId);
    if (!normalizedBindingId) throw new ServiceError('invalid_scope', 'bindingId is required.', 400);

    const db = await this.getClient();
    const result = await db.execute({
      sql: `SELECT owner_id, binding_id, provider_kind, scope_kind, data, created_at, updated_at
        FROM weave_service_bindings
        WHERE owner_id = ? AND binding_id = ?`,
      args: [caller.ownerId, normalizedBindingId],
    });
    const row = result.rows[0];
    return row ? parseBinding(row as Record<string, unknown>) : undefined;
  }

  async list(ownerId: string) {
    const db = await this.getClient();
    const result = await db.execute({
      sql: `SELECT owner_id, binding_id, provider_kind, scope_kind, data, created_at, updated_at
        FROM weave_service_bindings
        WHERE owner_id = ?
        ORDER BY updated_at DESC`,
      args: [ownerId],
    });
    return result.rows.map((row) => parseBinding(row as Record<string, unknown>));
  }

  async upsert(input: UpsertServiceBindingInput) {
    const bindingId = optionalString(input.bindingId) ?? `binding_${crypto.randomUUID()}`;
    const at = new Date().toISOString();
    const db = await this.getClient();
    await db.execute({
      sql: `INSERT INTO weave_service_bindings (
          owner_id, binding_id, provider_kind, scope_kind, data, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, binding_id) DO UPDATE SET
          provider_kind = excluded.provider_kind,
          scope_kind = excluded.scope_kind,
          data = excluded.data,
          updated_at = excluded.updated_at`,
      args: [
        input.ownerId,
        bindingId,
        input.providerKind,
        input.scopeKind,
        JSON.stringify(input.data),
        at,
        at,
      ],
    });
    return {
      ownerId: input.ownerId,
      bindingId,
      providerKind: input.providerKind,
      scopeKind: input.scopeKind,
      data: input.data,
      createdAt: at,
      updatedAt: at,
    };
  }

  async delete(caller: Pick<ServiceCaller, 'ownerId'>, bindingId: string) {
    const db = await this.getClient();
    const result = await db.execute({
      sql: `DELETE FROM weave_service_bindings WHERE owner_id = ? AND binding_id = ?`,
      args: [caller.ownerId, bindingId],
    });
    return Number(result.rowsAffected ?? 0) > 0;
  }
}
