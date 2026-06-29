type RuntimeMemorySnapshot = {
  rssBytes?: number;
  heapTotalBytes?: number;
  heapUsedBytes?: number;
  externalBytes?: number;
  arrayBuffersBytes?: number;
};

type PerfSampler = {
  logPath?: string;
  stop: () => void;
};

type PerfLogger = {
  log: (event: string, fields?: Record<string, unknown>) => void;
};

type DenoLike = {
  pid?: number;
  build?: { os?: string };
  env?: { get: (key: string) => string | undefined };
  mkdir?: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  writeTextFile?: (
    path: string,
    data: string,
    options?: { append?: boolean; create?: boolean },
  ) => Promise<void>;
  memoryUsage?: () => {
    rss?: number;
    heapTotal?: number;
    heapUsed?: number;
    external?: number;
    arrayBuffers?: number;
  };
  systemMemoryInfo?: () => unknown;
  loadavg?: () => number[];
};

type NodeLikeProcess = {
  pid?: number;
  env?: Record<string, string | undefined>;
  memoryUsage?: () => {
    rss?: number;
    heapTotal?: number;
    heapUsed?: number;
    external?: number;
    arrayBuffers?: number;
  };
};

const truthy = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value?.trim() ?? '');
const textEncoder = new TextEncoder();

const getDeno = () => (globalThis as typeof globalThis & { Deno?: DenoLike }).Deno;
const getProcess = () => (globalThis as typeof globalThis & { process?: NodeLikeProcess }).process;
const env = (key: string) => getDeno()?.env?.get(key) ?? getProcess()?.env?.[key];
const pid = () => getDeno()?.pid ?? getProcess()?.pid ?? 0;

const fileUrlToPath = (url: URL) => {
  const path = decodeURIComponent(url.pathname);
  return getDeno()?.build?.os === 'windows' && /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
};

const defaultPerfDir = () => fileUrlToPath(new URL('../../../.weave-perf/', import.meta.url));

const normalizeTimestamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-');

const resolvePerfDir = () => {
  const configured = env('WEAVE_PERF_DIR')?.trim();
  if (configured) return configured;
  return defaultPerfDir();
};

const resolveIntervalMs = () => {
  const parsed = Number(env('WEAVE_PERF_INTERVAL_MS')?.trim() ?? '');
  if (!Number.isFinite(parsed) || parsed <= 0) return 5_000;
  return Math.max(250, Math.floor(parsed));
};

const dirname = (path: string) => {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
};

const safeJsonLine = (value: unknown) =>
  `${
    JSON.stringify(value, (_key, entry) => {
      if (typeof entry === 'bigint') return Number(entry);
      if (entry instanceof Error) {
        return { name: entry.name, message: entry.message, stack: entry.stack };
      }
      return entry;
    })
  }\n`;

const byteLength = (value: string) => textEncoder.encode(value).byteLength;

class JsonlPerfLogger implements PerfLogger {
  private writeQueue = Promise.resolve();
  private failed = false;

  constructor(
    private readonly service: string,
    readonly logPath: string,
  ) {}

  log(event: string, fields: Record<string, unknown> = {}) {
    if (this.failed) return;
    const line = safeJsonLine({
      ts: new Date().toISOString(),
      service: this.service,
      pid: pid(),
      event,
      ...fields,
    });
    this.writeQueue = this.writeQueue
      .then(async () => {
        const deno = getDeno();
        if (!deno?.mkdir || !deno.writeTextFile) {
          throw new Error('Deno file APIs are unavailable.');
        }
        await deno.mkdir(dirname(this.logPath), { recursive: true });
        await deno.writeTextFile(this.logPath, line, {
          append: true,
          create: true,
        });
      })
      .catch((error) => {
        this.failed = true;
        console.warn(
          '[perf:server] disabled after write failure',
          error instanceof Error ? error.message : String(error),
        );
      });
  }
}

let activeLogger: PerfLogger | undefined;

export const isServerPerfEnabled = () => truthy(env('WEAVE_PERF_LOG'));

export const getDenoRuntimeMemorySnapshot = (): RuntimeMemorySnapshot => {
  const memory = (getDeno()?.memoryUsage?.() ?? getProcess()?.memoryUsage?.() ?? {}) as {
    rss?: number;
    heapTotal?: number;
    heapUsed?: number;
    external?: number;
    arrayBuffers?: number;
  };
  return {
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
};

const getSystemMemoryInfo = () => {
  try {
    return getDeno()?.systemMemoryInfo?.();
  } catch {
    return undefined;
  }
};

const getLoadAverage = () => {
  try {
    return getDeno()?.loadavg?.();
  } catch {
    return undefined;
  }
};

const runtimeSample = (eventLoopLagMs: number) => ({
  uptimeMs: Math.round(performance.now()),
  eventLoopLagMs,
  memory: getDenoRuntimeMemorySnapshot(),
  systemMemory: getSystemMemoryInfo(),
  loadAverage: getLoadAverage(),
});

export const estimateJsonByteLength = (value: unknown) => {
  try {
    return byteLength(JSON.stringify(value));
  } catch {
    return undefined;
  }
};

export const memoryDelta = (
  before: RuntimeMemorySnapshot | undefined,
  after: RuntimeMemorySnapshot,
) => {
  if (!before) return undefined;
  return {
    rssBytes: after.rssBytes !== undefined && before.rssBytes !== undefined
      ? after.rssBytes - before.rssBytes
      : undefined,
    heapUsedBytes: after.heapUsedBytes !== undefined && before.heapUsedBytes !== undefined
      ? after.heapUsedBytes - before.heapUsedBytes
      : undefined,
    heapTotalBytes: after.heapTotalBytes !== undefined && before.heapTotalBytes !== undefined
      ? after.heapTotalBytes - before.heapTotalBytes
      : undefined,
    externalBytes: after.externalBytes !== undefined && before.externalBytes !== undefined
      ? after.externalBytes - before.externalBytes
      : undefined,
    arrayBuffersBytes: after.arrayBuffersBytes !== undefined &&
        before.arrayBuffersBytes !== undefined
      ? after.arrayBuffersBytes - before.arrayBuffersBytes
      : undefined,
  };
};

export const logServerPerfEvent = (
  event: string,
  fields: Record<string, unknown> = {},
) => {
  activeLogger?.log(event, fields);
};

export const startServerPerfSampler = (
  options: {
    sample?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  } = {},
): PerfSampler => {
  if (!isServerPerfEnabled()) return { stop: () => undefined };

  const intervalMs = resolveIntervalMs();
  const logPath = `${resolvePerfDir().replace(/\/+$/, '')}/server-${normalizeTimestamp()}-${pid()}.jsonl`;
  const logger = new JsonlPerfLogger('server', logPath);
  activeLogger = logger;
  console.info(`[perf:server] writing ${logPath}`);

  let expectedAt = Date.now() + intervalMs;
  const writeSample = async (eventLoopLagMs = 0) => {
    let extra: Record<string, unknown> = {};
    try {
      extra = await options.sample?.() ?? {};
    } catch (error) {
      extra = {
        sampleError: error instanceof Error ? error.message : String(error),
      };
    }
    logger.log('runtime_sample', {
      ...runtimeSample(eventLoopLagMs),
      ...extra,
    });
  };

  void writeSample();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - expectedAt);
    expectedAt = now + intervalMs;
    void writeSample(lag);
  }, intervalMs);

  logger.log('sampler_started', { intervalMs, logPath });
  return {
    logPath,
    stop: () => {
      clearInterval(timer);
      logger.log('sampler_stopped');
      if (activeLogger === logger) activeLogger = undefined;
    },
  };
};
