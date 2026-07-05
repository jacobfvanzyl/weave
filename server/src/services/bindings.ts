import { getWeaveDb, type WeaveDbClient } from '../storage/postgres';
import type { JsonValue, ServiceCaller } from './types';
import { isJsonValue, optionalString, ServiceError } from './types';

export type ServiceProviderKind = 'portal' | 'client' | 'server' | 'external';
const serviceProviderKinds = new Set<ServiceProviderKind>(['portal', 'client', 'server', 'external']);

export const isServiceProviderKind = (value: unknown): value is ServiceProviderKind =>
  typeof value === 'string' && serviceProviderKinds.has(value as ServiceProviderKind);

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

const parseBinding = (row: Record<string, unknown>): ServiceBinding => {
  const providerKind = String(row.provider_kind);
  if (!isServiceProviderKind(providerKind)) {
    throw new ServiceError('provider_not_found', `Unknown service binding provider: ${providerKind}.`, 500);
  }

  let data: unknown;
  try {
    data = JSON.parse(String(row.data));
  } catch {
    throw new ServiceError('operation_failed', 'Service binding data is not valid JSON.', 500);
  }
  if (!isJsonValue(data)) throw new ServiceError('operation_failed', 'Service binding data is not JSON-safe.', 500);

  return {
    ownerId: String(row.owner_id),
    bindingId: String(row.binding_id),
    providerKind,
    scopeKind: String(row.scope_kind),
    data,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
};

const requireBindingInput = (input: UpsertServiceBindingInput) => {
  const ownerId = optionalString(input.ownerId);
  if (!ownerId) throw new ServiceError('invalid_scope', 'ownerId is required for service bindings.', 400);
  const providerKind = input.providerKind;
  if (!isServiceProviderKind(providerKind)) {
    throw new ServiceError('invalid_scope', 'providerKind is not supported for service bindings.', 400);
  }
  const scopeKind = optionalString(input.scopeKind);
  if (!scopeKind) throw new ServiceError('invalid_scope', 'scopeKind is required for service bindings.', 400);
  if (!isJsonValue(input.data)) throw new ServiceError('invalid_scope', 'Service binding data must be JSON-safe.', 400);
  return {
    ownerId,
    bindingId: optionalString(input.bindingId) ?? `binding_${crypto.randomUUID()}`,
    providerKind,
    scopeKind,
    data: input.data,
  };
};

export class PostgresServiceBindingRepository implements ServiceBindingRepository {
  constructor(private readonly getClient: () => Promise<WeaveDbClient> = getWeaveDb) {}

  async get(caller: Pick<ServiceCaller, 'ownerId'>, bindingId: string) {
    const ownerId = optionalString(caller.ownerId);
    if (!ownerId) throw new ServiceError('invalid_scope', 'ownerId is required.', 400);
    const normalizedBindingId = optionalString(bindingId);
    if (!normalizedBindingId) throw new ServiceError('invalid_scope', 'bindingId is required.', 400);

    const db = await this.getClient();
    const result = await db.execute({
      sql: `SELECT owner_id, binding_id, provider_kind, scope_kind, data, created_at, updated_at
        FROM service_bindings
        WHERE owner_id = ? AND binding_id = ?`,
      args: [ownerId, normalizedBindingId],
    });
    const row = result.rows[0];
    return row ? parseBinding(row as Record<string, unknown>) : undefined;
  }

  async list(ownerId: string) {
    const normalizedOwnerId = optionalString(ownerId);
    if (!normalizedOwnerId) throw new ServiceError('invalid_scope', 'ownerId is required.', 400);

    const db = await this.getClient();
    const result = await db.execute({
      sql: `SELECT owner_id, binding_id, provider_kind, scope_kind, data, created_at, updated_at
        FROM service_bindings
        WHERE owner_id = ?
        ORDER BY updated_at DESC`,
      args: [normalizedOwnerId],
    });
    return result.rows.map((row) => parseBinding(row as Record<string, unknown>));
  }

  async upsert(input: UpsertServiceBindingInput) {
    const normalized = requireBindingInput(input);
    const at = new Date().toISOString();
    const db = await this.getClient();
    await db.execute({
      sql: `INSERT INTO service_bindings (
          owner_id, binding_id, provider_kind, scope_kind, data, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, binding_id) DO UPDATE SET
          provider_kind = excluded.provider_kind,
          scope_kind = excluded.scope_kind,
          data = excluded.data,
          updated_at = excluded.updated_at`,
      args: [
        normalized.ownerId,
        normalized.bindingId,
        normalized.providerKind,
        normalized.scopeKind,
        JSON.stringify(normalized.data),
        at,
        at,
      ],
    });
    return {
      ownerId: normalized.ownerId,
      bindingId: normalized.bindingId,
      providerKind: normalized.providerKind,
      scopeKind: normalized.scopeKind,
      data: normalized.data,
      createdAt: at,
      updatedAt: at,
    };
  }

  async delete(caller: Pick<ServiceCaller, 'ownerId'>, bindingId: string) {
    const ownerId = optionalString(caller.ownerId);
    if (!ownerId) throw new ServiceError('invalid_scope', 'ownerId is required.', 400);
    const normalizedBindingId = optionalString(bindingId);
    if (!normalizedBindingId) throw new ServiceError('invalid_scope', 'bindingId is required.', 400);

    const db = await this.getClient();
    const result = await db.execute({
      sql: `DELETE FROM service_bindings WHERE owner_id = ? AND binding_id = ?`,
      args: [ownerId, normalizedBindingId],
    });
    return Number(result.rowsAffected ?? 0) > 0;
  }
}
