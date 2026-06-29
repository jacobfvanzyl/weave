import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';

type PerfSampler = {
  logPath?: string;
  stop: () => void;
};

type PerfLogger = {
  log: (event: string, fields?: Record<string, unknown>) => void;
};

const truthy = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value?.trim() ?? '');

const normalizeTimestamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-');

const resolvePerfDir = () => {
  const configured = process.env.WEAVE_PERF_DIR?.trim();
  if (configured) return path.resolve(configured);
  const cwd = process.cwd();
  return path.resolve(cwd.endsWith(`${path.sep}desktop`) ? path.join(cwd, '..') : cwd, '.weave-perf');
};

const resolveIntervalMs = () => {
  const parsed = Number(process.env.WEAVE_PERF_INTERVAL_MS?.trim() ?? '');
  if (!Number.isFinite(parsed) || parsed <= 0) return 5_000;
  return Math.max(250, Math.floor(parsed));
};

const safeJsonLine = (value: unknown) =>
  `${JSON.stringify(value, (_key, entry) => {
    if (typeof entry === 'bigint') return Number(entry);
    if (entry instanceof Error) return { name: entry.name, message: entry.message, stack: entry.stack };
    return entry;
  })}\n`;

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
      pid: process.pid,
      event,
      ...fields,
    });
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(path.dirname(this.logPath), { recursive: true });
        await writeFile(this.logPath, line, { flag: 'a' });
      })
      .catch((error) => {
        this.failed = true;
        console.warn('[perf:desktop] disabled after write failure', error instanceof Error ? error.message : String(error));
      });
  }
}

let activeLogger: PerfLogger | undefined;

export const isDesktopPerfEnabled = () => truthy(process.env.WEAVE_PERF_LOG);

const getMaybeProcessMemoryInfo = async () => {
  const electronProcess = process as NodeJS.Process & {
    getProcessMemoryInfo?: () => Promise<unknown>;
    getBlinkMemoryInfo?: () => unknown;
  };
  try {
    return await electronProcess.getProcessMemoryInfo?.();
  } catch {
    return undefined;
  }
};

const getMaybeBlinkMemoryInfo = () => {
  const electronProcess = process as NodeJS.Process & {
    getBlinkMemoryInfo?: () => unknown;
  };
  try {
    return electronProcess.getBlinkMemoryInfo?.();
  } catch {
    return undefined;
  }
};

const getWindowMetrics = () =>
  BrowserWindow.getAllWindows().map((window) => ({
    id: window.id,
    destroyed: window.isDestroyed(),
    visible: window.isVisible(),
    title: window.getTitle(),
    bounds: window.getBounds(),
    webContentsId: window.webContents.id,
    webContentsDestroyed: window.webContents.isDestroyed(),
    rendererPid: window.webContents.getOSProcessId(),
    url: window.webContents.getURL(),
  }));

export const logDesktopPerfEvent = (event: string, fields: Record<string, unknown> = {}) => {
  activeLogger?.log(event, fields);
};

export const startDesktopPerfSampler = (
  options: { sample?: () => Record<string, unknown> | Promise<Record<string, unknown>> } = {},
): PerfSampler => {
  if (!isDesktopPerfEnabled()) return { stop: () => undefined };

  const intervalMs = resolveIntervalMs();
  const logPath = path.join(resolvePerfDir(), `desktop-${normalizeTimestamp()}-${process.pid}.jsonl`);
  const logger = new JsonlPerfLogger('desktop', logPath);
  activeLogger = logger;
  console.info(`[perf:desktop] writing ${logPath}`);

  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  let previousEventLoopUtilization = performance.eventLoopUtilization();

  const writeSample = async () => {
    const eventLoopUtilization = performance.eventLoopUtilization(previousEventLoopUtilization);
    previousEventLoopUtilization = performance.eventLoopUtilization();
    let extra: Record<string, unknown> = {};
    try {
      extra = await options.sample?.() ?? {};
    } catch (error) {
      extra = { sampleError: error instanceof Error ? error.message : String(error) };
    }

    logger.log('runtime_sample', {
      uptimeMs: Math.round(process.uptime() * 1000),
      memory: process.memoryUsage(),
      resourceUsage: process.resourceUsage(),
      heapStatistics: v8.getHeapStatistics(),
      processMemoryInfo: await getMaybeProcessMemoryInfo(),
      blinkMemoryInfo: getMaybeBlinkMemoryInfo(),
      eventLoopUtilization,
      eventLoopDelay: {
        minMs: eventLoopDelay.min / 1_000_000,
        maxMs: eventLoopDelay.max / 1_000_000,
        meanMs: eventLoopDelay.mean / 1_000_000,
        stddevMs: eventLoopDelay.stddev / 1_000_000,
      },
      appMetrics: app.getAppMetrics(),
      windows: getWindowMetrics(),
      system: {
        loadAverage: os.loadavg(),
        freeMemoryBytes: os.freemem(),
        totalMemoryBytes: os.totalmem(),
      },
      ...extra,
    });
    eventLoopDelay.reset();
  };

  void writeSample();
  const timer = setInterval(() => {
    void writeSample();
  }, intervalMs);

  logger.log('sampler_started', { intervalMs, logPath });
  return {
    logPath,
    stop: () => {
      clearInterval(timer);
      eventLoopDelay.disable();
      logger.log('sampler_stopped');
      if (activeLogger === logger) activeLogger = undefined;
    },
  };
};
