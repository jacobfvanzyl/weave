import { type WorkspaceComposition, workspaceCompositionSchema } from '@weave/protocol';
import { getWeaveDb, type WeaveDbClient, type WeaveDbResult } from '../../storage/postgres.ts';

type WorkspaceCompositionRepositoryOptions = {
  createId?: (kind: 'tab' | 'layout') => string;
  now?: () => string;
};

const parseComposition = (row: WeaveDbResult['rows'][number]) => {
  if (typeof row.document !== 'string') throw new Error('Workspace Composition document is invalid.');
  return workspaceCompositionSchema.parse(JSON.parse(row.document));
};

const defaultComposition = (
  workspaceId: string,
  createId: NonNullable<WorkspaceCompositionRepositoryOptions['createId']>,
): WorkspaceComposition => ({
  workspaceId,
  schemaVersion: 1,
  revision: 1,
  defaultPaneType: 'editor',
  tabs: [{
    tabId: createId('tab'),
    name: 'New Tab',
    layout: { kind: 'empty', layoutId: createId('layout') },
    panes: [],
  }],
});

export class WorkspaceCompositionRepository {
  private readonly createId: NonNullable<WorkspaceCompositionRepositoryOptions['createId']>;
  private readonly now: NonNullable<WorkspaceCompositionRepositoryOptions['now']>;

  constructor(
    private readonly getClient: () => Promise<WeaveDbClient> = getWeaveDb,
    options: WorkspaceCompositionRepositoryOptions = {},
  ) {
    this.createId = options.createId ?? ((kind) => `${kind}_${crypto.randomUUID()}`);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async get(ownerId: string, workspaceId: string) {
    const db = await this.getClient();
    const result = await db.execute({
      sql: `SELECT document FROM workspace_compositions
        WHERE owner_id = ? AND workspace_id = ? LIMIT 1`,
      args: [ownerId, workspaceId],
    });
    const row = result.rows[0];
    return row ? parseComposition(row) : undefined;
  }

  async getOrCreate(ownerId: string, workspaceId: string) {
    const existing = await this.get(ownerId, workspaceId);
    if (existing) return existing;

    const composition = defaultComposition(workspaceId, this.createId);
    const timestamp = this.now();
    const db = await this.getClient();
    const inserted = await db.execute({
      sql: `INSERT INTO workspace_compositions (
          owner_id, workspace_id, schema_version, revision, document, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, workspace_id) DO NOTHING
        RETURNING document`,
      args: [
        ownerId,
        workspaceId,
        composition.schemaVersion,
        composition.revision,
        JSON.stringify(composition),
        timestamp,
        timestamp,
      ],
    });
    const insertedRow = inserted.rows[0];
    if (insertedRow) return parseComposition(insertedRow);

    const concurrent = await this.get(ownerId, workspaceId);
    if (!concurrent) throw new Error('Workspace Composition was not persisted.');
    return concurrent;
  }
}

export const workspaceCompositionRepository = new WorkspaceCompositionRepository();
