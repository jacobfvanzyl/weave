type CacheEntry<T> = {
  createdAt: number;
  promise: Promise<T>;
};

/**
 * Collapses concurrent retries and retains their settled result long enough for
 * a reconnecting server to retrieve it without executing the tool again.
 */
export class IdempotentExecutionCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs = 60 * 60 * 1_000,
    private readonly maxEntries = 2_000,
  ) {}

  execute(key: string | undefined, operation: () => Promise<T>): Promise<T> {
    if (!key) return operation();
    this.prune();

    const existing = this.entries.get(key);
    if (existing) return existing.promise;

    const entry = { createdAt: Date.now(), promise: operation() };
    this.entries.set(key, entry);
    return entry.promise;
  }

  private prune() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.createdAt < cutoff || this.entries.size > this.maxEntries) this.entries.delete(key);
    }
  }
}
