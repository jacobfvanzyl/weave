import { LibsqlServiceBindingRepository } from './bindings.ts';
import { ServiceError } from './types.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const assertRejectsServiceError = async (operation: () => unknown | Promise<unknown>, code: string) => {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    assertEquals(error.code, code);
    return error;
  }
  throw new Error('Expected operation to reject.');
};

const createFakeClient = () => {
  const bindings = new Map<string, Record<string, unknown>>();
  return {
    async execute(statement: { sql: string; args?: unknown[] }) {
      const sql = statement.sql;
      const args = statement.args ?? [];

      if (sql.includes('DELETE FROM weave_service_bindings')) {
        const deleted = bindings.delete(`${args[0]}:${args[1]}`);
        return { rows: [], rowsAffected: deleted ? 1 : 0 };
      }

      if (sql.includes('FROM weave_service_bindings') && sql.includes('WHERE owner_id = ? AND binding_id = ?')) {
        const row = bindings.get(`${args[0]}:${args[1]}`);
        return { rows: row ? [row] : [] };
      }

      if (sql.includes('FROM weave_service_bindings') && sql.includes('WHERE owner_id = ?')) {
        return {
          rows: [...bindings.values()]
            .filter((row) => row.owner_id === args[0])
            .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at))),
        };
      }

      if (sql.includes('INSERT INTO weave_service_bindings')) {
        const [ownerId, bindingId, providerKind, scopeKind, data, createdAt, updatedAt] = args;
        const key = `${ownerId}:${bindingId}`;
        const existing = bindings.get(key);
        bindings.set(key, {
          owner_id: ownerId,
          binding_id: bindingId,
          provider_kind: providerKind,
          scope_kind: scopeKind,
          data,
          created_at: existing?.created_at ?? createdAt,
          updated_at: updatedAt,
        });
        return { rows: [], rowsAffected: 1 };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
};

Deno.test('LibsqlServiceBindingRepository isolates bindings by owner', async () => {
  const client = createFakeClient();
  const repository = new LibsqlServiceBindingRepository(async () => client as never);

  await repository.upsert({
    ownerId: 'owner-1',
    bindingId: 'workspace-binding',
    providerKind: 'portal',
    scopeKind: 'portal-target',
    data: { portalId: 'portal-1', workspacePath: '/repo-a' },
  });
  await repository.upsert({
    ownerId: 'owner-2',
    bindingId: 'workspace-binding',
    providerKind: 'portal',
    scopeKind: 'portal-target',
    data: { portalId: 'portal-2', workspacePath: '/repo-b' },
  });

  assertEquals(
    (await repository.get({ ownerId: 'owner-1' }, 'workspace-binding'))?.data,
    { portalId: 'portal-1', workspacePath: '/repo-a' },
  );
  assertEquals(
    (await repository.get({ ownerId: 'owner-2' }, 'workspace-binding'))?.data,
    { portalId: 'portal-2', workspacePath: '/repo-b' },
  );
  assertEquals(await repository.get({ ownerId: 'owner-3' }, 'workspace-binding'), undefined);
  assertEquals((await repository.list('owner-1')).map((binding) => binding.ownerId), ['owner-1']);

  assertEquals(await repository.delete({ ownerId: 'owner-2' }, 'workspace-binding'), true);
  assertEquals(await repository.get({ ownerId: 'owner-2' }, 'workspace-binding'), undefined);
  assertEquals((await repository.get({ ownerId: 'owner-1' }, 'workspace-binding'))?.ownerId, 'owner-1');
});

Deno.test('LibsqlServiceBindingRepository validates binding inputs', async () => {
  const client = createFakeClient();
  const repository = new LibsqlServiceBindingRepository(async () => client as never);

  await assertRejectsServiceError(
    () =>
      repository.upsert({
        ownerId: ' ',
        providerKind: 'portal',
        scopeKind: 'portal-target',
        data: {},
      }),
    'invalid_scope',
  );

  await assertRejectsServiceError(
    () =>
      repository.upsert({
        ownerId: 'owner-1',
        providerKind: 'unknown' as never,
        scopeKind: 'portal-target',
        data: {},
      }),
    'invalid_scope',
  );

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await assertRejectsServiceError(
    () =>
      repository.upsert({
        ownerId: 'owner-1',
        providerKind: 'portal',
        scopeKind: 'portal-target',
        data: cyclic as never,
      }),
    'invalid_scope',
  );

  await assertRejectsServiceError(
    () =>
      repository.upsert({
        ownerId: 'owner-1',
        providerKind: 'portal',
        scopeKind: 'portal-target',
        data: new Date() as never,
      }),
    'invalid_scope',
  );
});
