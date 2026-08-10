import type { WeaveDbClient, WeaveDbResult, WeaveDbStatement } from '../../storage/postgres.ts';
import { WorkspaceCompositionRepository } from './repository.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

class MemoryCompositionDb implements WeaveDbClient {
  private readonly rows = new Map<string, Record<string, unknown>>();

  async execute(statement: WeaveDbStatement): Promise<WeaveDbResult> {
    if (typeof statement === 'string') throw new Error(`Unexpected SQL: ${statement}`);
    const args = statement.args ?? [];
    const key = `${args[0]}:${args[1]}`;

    if (statement.sql.includes('INSERT INTO workspace_compositions')) {
      if (this.rows.has(key)) return { rows: [], rowsAffected: 0 };
      const row = {
        owner_id: args[0],
        workspace_id: args[1],
        schema_version: args[2],
        revision: args[3],
        document: args[4],
        created_at: args[5],
        updated_at: args[5],
      };
      this.rows.set(key, row);
      return { rows: [row], rowsAffected: 1 };
    }

    if (statement.sql.includes('FROM workspace_compositions')) {
      const row = this.rows.get(key);
      return { rows: row ? [row] : [], rowsAffected: 0 };
    }

    throw new Error(`Unexpected SQL: ${statement.sql}`);
  }

  async batch(statements: WeaveDbStatement[]): Promise<WeaveDbResult[]> {
    return await Promise.all(statements.map((statement) => this.execute(statement)));
  }
}

Deno.test('WorkspaceCompositionRepository persists one stable New Tab across clients and restarts', async () => {
  const db = new MemoryCompositionDb();
  let nextId = 0;
  const createRepository = () =>
    new WorkspaceCompositionRepository(
      () => Promise.resolve(db),
      {
        createId: (kind) => `${kind}-${++nextId}`,
        now: () => '2026-08-10T12:00:00.000Z',
      },
    );

  const firstClient = await createRepository().getOrCreate('owner-1', 'workspace-1');
  const secondClient = await createRepository().getOrCreate('owner-1', 'workspace-1');

  assertEquals(firstClient, {
    workspaceId: 'workspace-1',
    schemaVersion: 1,
    revision: 1,
    defaultPaneType: 'editor',
    tabs: [{
      tabId: 'tab-1',
      name: 'New Tab',
      layout: { kind: 'empty', layoutId: 'layout-2' },
      panes: [],
    }],
  });
  assertEquals(secondClient, firstClient);
});

Deno.test('WorkspaceCompositionRepository isolates the same Workspace identity by owner', async () => {
  const db = new MemoryCompositionDb();
  let nextId = 0;
  const repository = new WorkspaceCompositionRepository(
    () => Promise.resolve(db),
    { createId: (kind) => `${kind}-${++nextId}` },
  );

  const firstOwner = await repository.getOrCreate('owner-1', 'workspace-1');
  const secondOwner = await repository.getOrCreate('owner-2', 'workspace-1');

  if (firstOwner.tabs[0]?.tabId === secondOwner.tabs[0]?.tabId) {
    throw new Error('expected owner-scoped composition identities');
  }
});
