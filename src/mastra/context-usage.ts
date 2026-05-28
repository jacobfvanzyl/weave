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

const snapshots = new Map<string, ThreadContextUsageSnapshot>();

const keyFor = (threadId: string, resourceId?: string) => `${resourceId ?? ''}::${threadId}`;

const positiveFinite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export const recordThreadContextUsage = (snapshot: Omit<ThreadContextUsageSnapshot, 'updatedAt' | 'source'>) => {
  if (!positiveFinite(snapshot.usedTokens)) return;

  snapshots.set(keyFor(snapshot.threadId, snapshot.resourceId), {
    ...snapshot,
    updatedAt: new Date().toISOString(),
    source: 'provider',
  });
};

export const getThreadContextUsageSnapshot = (threadId: string, resourceId?: string) =>
  snapshots.get(keyFor(threadId, resourceId)) ?? snapshots.get(keyFor(threadId));
