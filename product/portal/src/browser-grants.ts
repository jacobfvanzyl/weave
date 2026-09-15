import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { browserProfileId, parseBrowserThreadGrants, type BrowserThreadGrants } from '@weave/product-protocol';

/** Durable explicit Thread grants. No inheritance from the human pairing or Workspace. */
export class BrowserGrantStore {
  #records = new Map<string, BrowserThreadGrants>();
  #writes: Promise<unknown> = Promise.resolve();
  #listeners = new Set<(threadId: string) => void>();
  private constructor(private path: string) {}
  static async open(stateDirectory: string) {
    const store = new BrowserGrantStore(join(stateDirectory, 'browser-thread-grants.json'));
    try {
      const file = JSON.parse(await readFile(store.path, 'utf8'));
      if (file.version !== 1 || !Array.isArray(file.grants)) throw new Error('Invalid Browser grant store');
      for (const raw of file.grants) { const grant = parseBrowserThreadGrants(raw); if (store.#records.has(grant.threadId)) throw new Error('Duplicate Thread grant'); store.#records.set(grant.threadId, grant); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return store;
  }
  get(threadId: string): BrowserThreadGrants { return structuredClone(this.#records.get(browserProfileId(threadId)) ?? { threadId, profileIds: [], revision: 0 }); }
  assert(threadId: string, profileId: string) { if (!this.get(threadId).profileIds.includes(profileId)) throw new Error('This Thread has no grant for that Browser Profile'); }
  subscribe(listener: (threadId: string) => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  set(threadId: string, profileIds: string[], expectedRevision: number, authorize: () => Promise<void>) {
    const next = this.#writes.catch(() => {}).then(async () => {
      if (this.get(threadId).revision !== expectedRevision) throw new Error('Browser grants changed; refresh before saving');
      const grant = parseBrowserThreadGrants({ threadId, profileIds, revision: expectedRevision + 1 });
      await authorize();
      const records = new Map(this.#records); records.set(threadId, grant);
      const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify({ version: 1, grants: [...records.values()] }) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, this.path); }
      finally { await rm(temporary, { force: true }); }
      this.#records = records;
      for (const listener of this.#listeners) listener(threadId);
      return this.get(threadId);
    });
    this.#writes = next; return next;
  }
}
