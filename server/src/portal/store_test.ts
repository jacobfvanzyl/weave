import { PortalRepository } from './store.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const createFakeClient = () => {
  const settings = new Map<string, Record<string, unknown>>();
  const tokens = new Map<string, Record<string, unknown>>();
  return {
    async execute(statement: { sql: string; args?: unknown[] }) {
      const sql = statement.sql;
      const args = statement.args ?? [];

      if (sql.includes('FROM weave_portal_settings')) {
        return { rows: settings.has(String(args[0])) ? [settings.get(String(args[0]))!] : [] };
      }

      if (sql.includes('INSERT INTO weave_portal_settings')) {
        const [ownerId, primaryPortalId, createdAt, updatedAt] = args;
        const existing = settings.get(String(ownerId));
        settings.set(String(ownerId), {
          owner_id: ownerId,
          primary_portal_id: primaryPortalId,
          created_at: existing?.created_at ?? createdAt,
          updated_at: updatedAt,
        });
        return { rows: [], rowsAffected: 1 };
      }

      if (sql.includes('FROM weave_portal_tokens') && sql.includes('WHERE owner_id = ? AND portal_id = ?')) {
        const row = tokens.get(`${args[0]}:${args[1]}`);
        return { rows: row ? [row] : [] };
      }

      if (sql.includes('FROM weave_portal_tokens') && sql.includes('WHERE portal_id = ? AND token = ?')) {
        const row = [...tokens.values()].find((item) =>
          item.portal_id === args[0] && item.token === args[1] && item.status === 'issued'
        );
        return { rows: row ? [row] : [] };
      }

      if (sql.includes('INSERT INTO weave_portal_tokens')) {
        const [ownerId, portalId, token, status, createdAt, updatedAt] = args;
        const key = `${ownerId}:${portalId}`;
        const existing = tokens.get(key);
        tokens.set(key, {
          owner_id: ownerId,
          portal_id: portalId,
          token,
          status,
          created_at: existing?.created_at ?? createdAt,
          updated_at: updatedAt,
        });
        return { rows: [], rowsAffected: 1 };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
};

Deno.test('PortalRepository stores primary Portal selection', async () => {
  const client = createFakeClient();
  const repository = new PortalRepository(async () => client as never);

  assertEquals(await repository.getPrimaryPortalId('owner-1'), undefined);

  await repository.setPrimaryPortalId('owner-1', 'portal-1');
  assertEquals(await repository.getPrimaryPortalId('owner-1'), 'portal-1');

  await repository.setPrimaryPortalId('owner-1', 'portal-2');
  assertEquals(await repository.getPrimaryPortalId('owner-1'), 'portal-2');
});

Deno.test('PortalRepository stores and validates issued Portal tokens', async () => {
  const client = createFakeClient();
  const repository = new PortalRepository(async () => client as never);

  await repository.saveToken({
    ownerId: 'owner-1',
    portalId: 'portal-1',
    token: 'token-1',
  });

  const token = await repository.getToken('owner-1', 'portal-1');
  assertEquals({
    ownerId: token?.ownerId,
    portalId: token?.portalId,
    token: token?.token,
    status: token?.status,
    createdAt: typeof token?.createdAt,
    updatedAt: typeof token?.updatedAt,
  }, {
    ownerId: 'owner-1',
    portalId: 'portal-1',
    token: 'token-1',
    status: 'issued',
    createdAt: 'string',
    updatedAt: 'string',
  });
  assertEquals((await repository.findToken('portal-1', 'token-1'))?.ownerId, 'owner-1');

  await repository.saveToken({
    ownerId: 'owner-1',
    portalId: 'portal-1',
    token: 'token-2',
    status: 'revoked',
  });
  assertEquals(await repository.findToken('portal-1', 'token-2'), undefined);
});
