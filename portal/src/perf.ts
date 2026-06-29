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

const truthy = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value?.trim() ?? '');

const fileUrlToPath = (url: URL) => {
  const path = decodeURIComponent(url.pathname);
  return Deno.build.os === 'windows' && /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
};

const defaultPerfDir = () => fileUrlToPath(new URL('../../.weave-perf/', import.meta.url));

const normalizeTimestamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-');

const resolvePerfDir = () => {
  const configured = Deno.env.get('WEAVE_PERF_DIR')?.trim();
  if (configured) return configured;
  return defaultPerfDir();
};

const resolveIntervalMs = () => {
  const parsed = Number(Deno.env.get('WEAVE_PERF_INTERVAL_MS')?.trim() ?? '');
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
      pid: Deno.pid,
      event,
      ...fields,
    });
    this.writeQueue = this.writeQueue
      .then(async () => {
        await Deno.mkdir(dirname(this.logPath), { recursive: true });
        await Deno.writeTextFile(this.logPath, line, {
          append: true,
          create: true,
        });
      })
      .catch((error) => {
        this.failed = true;
        console.warn(
          '[perf:portal] disabled after write failure',
          error instanceof Error ? error.message : String(error),
        );
      });
  }
}

let activeLogger: PerfLogger | undefined;

export const isPortalPerfEnabled = () => truthy(Deno.env.get('WEAVE_PERF_LOG'));

const getDenoRuntimeMemorySnapshot = (): RuntimeMemorySnapshot => {
  const memory = Deno.memoryUsage() as ReturnType<typeof Deno.memoryUsage> & {
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
    const runtime = Deno as typeof Deno & { systemMemoryInfo?: () => unknown };
    return runtime.systemMemoryInfo?.();
  } catch {
    return undefined;
  }
};

const getLoadAverage = () => {
  try {
    const runtime = Deno as typeof Deno & { loadavg?: () => number[] };
    return runtime.loadavg?.();
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

export const logPortalPerfEvent = (
  event: string,
  fields: Record<string, unknown> = {},
) => {
  activeLogger?.log(event, fields);
};

export const startPortalPerfSampler = (
  options: {
    sample?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  } = {},
): PerfSampler => {
  if (!isPortalPerfEnabled()) return { stop: () => undefined };

  const intervalMs = resolveIntervalMs();
  const logPath = `${resolvePerfDir().replace(/\/+$/, '')}/portal-${normalizeTimestamp()}-${Deno.pid}.jsonl`;
  const logger = new JsonlPerfLogger('portal', logPath);
  activeLogger = logger;
  console.info(`[perf:portal] writing ${logPath}`);

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
