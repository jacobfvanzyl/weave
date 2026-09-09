import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseWorkspaceComposition, parseWorkspaceTabs, type CompositionErrorData, type WorkspaceComposition, type WorkspaceTab } from '@weave/product-protocol';

export class CompositionError extends Error {
  constructor(readonly data: CompositionErrorData) {
    super(data.code === 'STALE_REVISION' ? 'The workspace arrangement changed. Reload it before editing.' : 'The terminal target is unavailable in this Workspace.');
  }
}

// The Host owns only the shared arrangement. Client focus/open sets never enter
// this store, and removing a reference never controls its terminal process.
export class CompositionStore {
  readonly #directory: string;
  readonly #pending = new Map<string, Promise<unknown>>();
  constructor(stateDirectory: string) { this.#directory = join(stateDirectory, 'compositions'); }
  #path(workspaceId: string) { return join(this.#directory, `${createHash('sha256').update(workspaceId).digest('hex')}.json`); }
  async get(workspaceId: string): Promise<WorkspaceComposition> {
    try {
      const composition = parseWorkspaceComposition(JSON.parse(await readFile(this.#path(workspaceId), 'utf8')));
      if (composition.workspaceId !== workspaceId) throw new Error('Composition ownership mismatch.');
      return composition;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { schemaVersion: 1, workspaceId, revision: 0, tabs: [] };
    }
  }
  async replace(workspaceId: string, expectedRevision: number, tabs: WorkspaceTab[], validate: (current: WorkspaceComposition, tabs: WorkspaceTab[]) => Promise<void>) {
    const validTabs = parseWorkspaceTabs(tabs);
    const operation = (this.#pending.get(workspaceId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const current = await this.get(workspaceId);
      if (current.revision !== expectedRevision) throw new CompositionError({ domain: 'composition', code: 'STALE_REVISION', currentRevision: current.revision });
      await validate(current, validTabs);
      const next = parseWorkspaceComposition({ ...current, revision: current.revision + 1, tabs: validTabs });
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.#path(workspaceId)}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.#path(workspaceId));
      } finally { await rm(temporary, { force: true }); }
      return next;
    });
    this.#pending.set(workspaceId, operation);
    try { return await operation; }
    finally { if (this.#pending.get(workspaceId) === operation) this.#pending.delete(workspaceId); }
  }
}
