export type ThreadContextUsageSnapshot = {
  threadId: string;
  resourceId?: string;
  usedTokens: number;
  totalProcessedTokens?: number;
  maxTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  updatedAt: string;
  source: 'provider';
};

type ProviderTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
};

export type ThreadContextUsageListener = (snapshot: ThreadContextUsageSnapshot) => void;

const snapshots = new Map<string, ThreadContextUsageSnapshot>();
const listeners = new Map<string, Set<ThreadContextUsageListener>>();

const keyFor = (threadId: string, resourceId?: string) => `${resourceId ?? ''}::${threadId}`;

const positiveFinite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const contextUsageFromProviderUsage = (usage: ProviderTokenUsage) => {
  if (!positiveFinite(usage.inputTokens)) return undefined;

  const outputTokens = finiteNumber(usage.outputTokens) ? usage.outputTokens : undefined;
  const totalProcessedTokens = positiveFinite(usage.totalTokens)
    ? usage.totalTokens
    : usage.inputTokens + (outputTokens ?? 0);

  return {
    usedTokens: usage.inputTokens,
    totalProcessedTokens,
    inputTokens: usage.inputTokens,
    ...(finiteNumber(usage.cachedInputTokens) ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
};

export const recordThreadContextUsage = (snapshot: Omit<ThreadContextUsageSnapshot, 'updatedAt' | 'source'>) => {
  if (!positiveFinite(snapshot.usedTokens) || !positiveFinite(snapshot.inputTokens)) return;

  const recorded: ThreadContextUsageSnapshot = {
    ...snapshot,
    updatedAt: new Date().toISOString(),
    source: 'provider',
  };
  snapshots.set(keyFor(snapshot.threadId, snapshot.resourceId), recorded);

  const notifyKeys = new Set([keyFor(snapshot.threadId, snapshot.resourceId)]);
  if (snapshot.resourceId) notifyKeys.add(keyFor(snapshot.threadId));

  for (const key of notifyKeys) {
    for (const listener of listeners.get(key) ?? []) {
      try {
        listener(recorded);
      } catch (error) {
        console.error('[context-usage] listener failed', error);
      }
    }
  }
};

export const getThreadContextUsageSnapshot = (threadId: string, resourceId?: string) =>
  snapshots.get(keyFor(threadId, resourceId)) ?? snapshots.get(keyFor(threadId));

export const subscribeThreadContextUsage = (
  threadId: string,
  resourceId: string | undefined,
  listener: ThreadContextUsageListener,
) => {
  const key = keyFor(threadId, resourceId);
  const keyedListeners = listeners.get(key) ?? new Set<ThreadContextUsageListener>();
  keyedListeners.add(listener);
  listeners.set(key, keyedListeners);

  return () => {
    const currentListeners = listeners.get(key);
    if (!currentListeners) return;
    currentListeners.delete(listener);
    if (currentListeners.size === 0) listeners.delete(key);
  };
};
