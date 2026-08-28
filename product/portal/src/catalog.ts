import type { ThreadSummary } from '@weave/product-protocol';
import { dirname, join } from 'jsr:@std/path@1.1.2';

type StoredCatalog = { version: 1; threads: ThreadSummary[] };

export class ThreadCatalog {
  readonly #path: string;
  readonly #threads = new Map<string, ThreadSummary>();
  #mutationQueue = Promise.resolve();

  constructor(stateDirectory: string) {
    this.#path = join(stateDirectory, 'threads.json');
  }

  async load() {
    try {
      const value = JSON.parse(await Deno.readTextFile(this.#path)) as StoredCatalog;
      if (value.version !== 1 || !Array.isArray(value.threads)) {
        throw new Error('Thread catalog version is unsupported.');
      }
      for (const thread of value.threads) this.#threads.set(thread.threadId, thread);
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) return;
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
    await this.#mutate(() => this.#threads.set(thread.threadId, thread));
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
      operation();
      await this.#persist();
    });
    this.#mutationQueue = result.then(() => undefined, () => undefined);
    await result;
  }

  async #persist() {
    await Deno.mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(temporary, `${JSON.stringify({ version: 1, threads: this.list() }, null, 2)}\n`, {
      mode: 0o600,
    });
    await Deno.rename(temporary, this.#path);
    await Deno.chmod(this.#path, 0o600);
  }
}
