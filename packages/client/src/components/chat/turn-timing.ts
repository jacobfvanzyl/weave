export type AssistantRunTiming = {
  runId?: string;
  status?: 'running' | 'completed' | 'cancelled' | 'error';
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getMetadataRecord = (metadata: unknown) => {
  if (!isRecord(metadata)) return undefined;
  const custom = isRecord(metadata.custom) ? metadata.custom : undefined;
  return isRecord(custom?.weaveRunTiming)
    ? custom.weaveRunTiming
    : isRecord(metadata.weaveRunTiming)
    ? metadata.weaveRunTiming
    : undefined;
};

const optionalString = (value: unknown) => typeof value === 'string' ? value : undefined;

const optionalStatus = (value: unknown): AssistantRunTiming['status'] | undefined =>
  value === 'running' || value === 'completed' || value === 'cancelled' || value === 'error'
    ? value
    : undefined;

const optionalDurationMs = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export const getAssistantRunTiming = (metadata: unknown): AssistantRunTiming | null => {
  const record = getMetadataRecord(metadata);
  if (!record) return null;

  const runId = optionalString(record.runId);
  const status = optionalStatus(record.status);
  const startedAt = optionalString(record.startedAt);
  const completedAt = optionalString(record.completedAt);
  const durationMs = optionalDurationMs(record.durationMs);
  const timing: AssistantRunTiming = {
    ...(runId ? { runId } : {}),
    ...(status ? { status } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };

  return timing.startedAt || timing.durationMs !== undefined ? timing : null;
};

const durationFromTimestamps = (startedAt: string | undefined, completedAt: string | undefined, nowMs?: number) => {
  if (!startedAt) return undefined;
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return undefined;
  const endMs = completedAt ? Date.parse(completedAt) : nowMs;
  if (endMs === undefined || !Number.isFinite(endMs)) return undefined;
  return Math.max(0, endMs - startMs);
};

export const formatWorkDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
};

export const getWorkedForLabel = (metadata: unknown) => {
  const timing = getAssistantRunTiming(metadata);
  if (!timing) return null;
  if (timing.status === 'running') return null;
  const durationMs = timing.durationMs ?? durationFromTimestamps(timing.startedAt, timing.completedAt);
  return durationMs === undefined ? null : `Worked for ${formatWorkDuration(durationMs)}`;
};

export const getWorkingForLabel = (startedAt: string | undefined, nowMs = Date.now()) => {
  const durationMs = durationFromTimestamps(startedAt, undefined, nowMs);
  return durationMs === undefined ? 'Working...' : `Working for ${formatWorkDuration(durationMs)}`;
};
