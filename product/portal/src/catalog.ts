import { chmod, mkdir, readText, rename, writeText } from './host-files.ts';
import { isFsError } from './host-files.ts';
import { parseThreadSummary, type ThreadSummary } from '@weave/product-protocol';
import { dirname, join } from 'node:path';

type StoredCatalog = { version: 3; threads: ThreadSummary[] };

export class ThreadCatalog {
  readonly #path: string;
  readonly #threads = new Map<string, ThreadSummary>();
  #mutationQueue = Promise.resolve();

  constructor(stateDirectory: string) {
    this.#path = join(stateDirectory, 'threads.json');
  }

  async load(resolveWorkspace?: (executionContextId: string, preferredId?: string, assignedIds?: string[]) => Promise<string>) {
    try {
      const value = JSON.parse(await readText(this.#path));
      if (![1, 2, 3].includes(value.version) || !Array.isArray(value.threads)) throw new Error('Thread catalog version is unsupported.');
      const previousVersion = value.version;
      const records = value.threads.map((thread: any) => previousVersion === 1
        ? { ...thread, executionContextId: thread.workspaceId, workspaceId: undefined, membershipRevision: 0 }
        : thread);
      const threads: ThreadSummary[] = [];
      for (const record of records) {
        if (previousVersion < 3) {
          if (!resolveWorkspace) throw new Error('Thread membership migration requires a Workspace resolver.');
          const assignedIds = records.filter((other: any) => other.executionContextId === record.executionContextId && typeof other.workspaceId === 'string').map((other: any) => other.workspaceId);
          const workspaceId = await resolveWorkspace(record.executionContextId, record.workspaceId ?? undefined, assignedIds);
          threads.push(parseThreadSummary({ ...record, workspaceId, membershipRevision: (record.membershipRevision ?? 0) + (record.workspaceId === workspaceId ? 0 : 1) }));
        } else threads.push(parseThreadSummary(record));
      }
      for (const thread of threads) this.#threads.set(thread.threadId, thread);
      if (previousVersion < 3) await this.#persist();
    } catch (cause) {
      if (isFsError(cause, 'ENOENT')) return;
      throw cause;
    }
  }

  list(status: 'active' | 'archived' | 'all' = 'all') {
    return [...this.#threads.values()]
      .filter((thread) => status === 'all' || thread.status === status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(threadId: string) {
    return this.#threads.get(threadId);
  }

  async put(thread: ThreadSummary) {
    parseThreadSummary(thread);
    await this.#mutate(() => {
      const current = this.#threads.get(thread.threadId);
      // Runtime snapshots own execution, never organizational membership.
      this.#threads.set(thread.threadId, current ? { ...thread, workspaceId: current.workspaceId, membershipRevision: current.membershipRevision } : { ...thread });
    });
  }

  async assign(threadId: string, workspaceId: string, expectedRevision: number) {
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new Error('A Workspace is required.');
    let changed: ThreadSummary | undefined;
    await this.#mutate(() => {
      const current = this.#threads.get(threadId);
      if (!current) throw new Error('Thread is unavailable.');
      if (current.membershipRevision !== expectedRevision) throw new ThreadMembershipError();
      changed = { ...current, workspaceId, membershipRevision: current.membershipRevision + 1 };
      this.#threads.set(threadId, changed);
    });
    return changed!;
  }

  async archiveWorkspace(workspaceId: string) {
    const archived: ThreadSummary[] = [];
    await this.#mutate(() => {
      const now = new Date().toISOString();
      for (const current of this.#threads.values()) if (current.workspaceId === workspaceId && current.status === 'active') {
        const thread = { ...current, status: 'archived' as const, updatedAt: now, archivedAt: now };
        this.#threads.set(thread.threadId, thread);
        archived.push(thread);
      }
    });
    return archived;
  }

  async setArchived(threadId: string, archived: boolean) {
    let changed: ThreadSummary | undefined;
    await this.#mutate(() => {
      const current = this.#threads.get(threadId);
      if (!current) return;
      const status = archived ? 'archived' as const : 'active' as const;
      if (current.status === status) {
        changed = current;
        return;
      }
      const now = new Date().toISOString();
      changed = {
        ...current,
        status,
        updatedAt: now,
        ...(archived ? { archivedAt: now } : { archivedAt: undefined }),
      };
      this.#threads.set(threadId, changed);
    });
    return changed;
  }

  async #mutate(operation: () => void) {
    const result = this.#mutationQueue.then(async () => {
      const previous = new Map(this.#threads);
      try { operation(); await this.#persist(); }
      catch (cause) { this.#threads.clear(); for (const [id, thread] of previous) this.#threads.set(id, thread); throw cause; }
    });
    this.#mutationQueue = result.then(() => undefined, () => undefined);
    await result;
  }

  async #persist() {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    await writeText(temporary, `${JSON.stringify({ version: 3, threads: this.list() }, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.#path);
    await chmod(this.#path, 0o600);
  }
}

export class ThreadMembershipError extends Error {
  readonly data = { domain: 'thread-membership', code: 'STALE_REVISION' };
  constructor() { super('Thread assignment changed. Refresh before moving it.'); }
}
