import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DesktopPortalStatus } from '../shared/desktop-api';
import type { ConnectionSettingsStore } from './settings-store';
import type { DesktopRpcConnection } from './rpc-connection';

type PortalConfig = {
  serverUrl?: string;
  httpServerUrl?: string;
  wsServerUrl?: string;
  portal?: {
    portalId?: string;
    portalToken?: string;
    name?: string;
    roots?: Array<{ id: string; name: string; path: string }>;
  };
};

type PortalRuntimeFile = {
  version: 2;
  pid: number;
  instanceId: string;
  portalId: string;
  configPath: string;
  serverUrl: string;
  connectionState:
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'rejected'
    | 'stopped';
  connectedAt?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
};

type PortalLaunchCommand = {
  file: string;
  args: string[];
};

export type PortalSupervisorOptions = {
  settingsStore: ConnectionSettingsStore;
  rpc: DesktopRpcConnection;
  homePath: string;
  isPackaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  portalSourcePath?: string;
  env?: NodeJS.ProcessEnv;
  monitorIntervalMs?: number;
  startupTimeoutMs?: number;
};

const execFileAsync = promisify(execFile);
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const normalizeUrl = (value: string) => value.replace(/\/+$/, '');
const splitExtraArgs = (value: string | undefined) => value?.split(/\s+/).filter(Boolean) ?? [];
const maxLogBytes = 1_000_000;

const resolvePortalHome = (env: NodeJS.ProcessEnv) => {
  const explicit = env.WEAVE_PORTAL_HOME?.trim();
  if (explicit) return explicit;
  return path.join(
    env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'),
    'weave',
    'portal',
  );
};

const readJsonFile = async <T>(filePath: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

const writeJsonFile = async (filePath: string, value: unknown) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600).catch(() => undefined);
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

const runtimeFresh = (runtime: PortalRuntimeFile | undefined) =>
  Boolean(
    runtime && runtime.version === 2 &&
      Date.now() - Date.parse(runtime.updatedAt) < 45_000,
  );

export class PortalSupervisor {
  private readonly settingsStore: ConnectionSettingsStore;
  private readonly rpc: DesktopRpcConnection;
  private readonly homePath: string;
  private readonly portalHome: string;
  private readonly configPath: string;
  private readonly runtimePath: string;
  private readonly logPath: string;
  private readonly isPackaged: boolean;
  private readonly resourcesPath?: string;
  private readonly appPath: string;
  private readonly portalSourcePath?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly monitorIntervalMs: number;
  private readonly startupTimeoutMs: number;
  private readonly listeners = new Set<(status: DesktopPortalStatus) => void>();
  private readonly onlinePortalIds = new Set<string>();
  private readonly detachPortalStatus: () => void;
  private readonly detachRpcState: () => void;
  private process?: ChildProcess;
  private startPromise?: Promise<void>;
  private monitor?: ReturnType<typeof setInterval>;
  private disposed = false;
  private status: DesktopPortalStatus;

  constructor(options: PortalSupervisorOptions) {
    this.settingsStore = options.settingsStore;
    this.rpc = options.rpc;
    this.homePath = options.homePath;
    this.env = options.env ?? process.env;
    this.portalHome = resolvePortalHome(this.env);
    this.configPath = path.join(this.portalHome, 'config.json');
    this.runtimePath = path.join(this.portalHome, 'runtime.json');
    this.logPath = path.join(this.portalHome, 'desktop-daemon.log');
    this.isPackaged = options.isPackaged ?? false;
    this.resourcesPath = options.resourcesPath;
    this.appPath = options.appPath ?? process.cwd();
    this.portalSourcePath = options.portalSourcePath;
    this.monitorIntervalMs = options.monitorIntervalMs ?? 5_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 20_000;
    this.status = {
      phase: 'idle',
      serverUrl: normalizeUrl(this.settingsStore.getSettings().mastraUrl),
    };
    this.detachPortalStatus = this.rpc.onNotification('portal.status.changed', (params) => {
      void this.handlePortalStatus(params);
    });
    this.detachRpcState = this.rpc.onState((state) => {
      if (state === 'connected') return;
      this.onlinePortalIds.clear();
      if (this.status.phase === 'ready') {
        this.setStatus({ ...this.status, phase: 'reconnecting', remoteConnectionState: 'reconnecting' });
      }
    });
  }

  async ensureStarted() {
    if (!this.startPromise) {
      this.startPromise = this.start().catch((error) => {
        this.startPromise = undefined;
        this.setFailed(error);
        throw error;
      });
    }
    await this.startPromise;
  }

  startMonitoring() {
    if (this.monitor) return;
    void this.ensureStarted().catch(() => undefined);
    this.monitor = setInterval(
      () => void this.monitorOnce(),
      this.monitorIntervalMs,
    );
  }

  async reconcile(options: { refreshPortalToken?: boolean } = {}) {
    this.startPromise = undefined;
    if (options.refreshPortalToken) await this.ensurePortalConfig(true);
    await this.ensureStarted();
  }

  async retry() {
    await this.reconcile();
  }

  getStatus() {
    return { ...this.status };
  }

  subscribe(listener: (status: DesktopPortalStatus) => void) {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;
    this.detachPortalStatus();
    this.detachRpcState();
    const runtimePromise = readJsonFile<PortalRuntimeFile>(this.runtimePath);
    void runtimePromise.then((runtime) =>
      runtime
        ? this.rpc.request('portal.shutdown', { portalId: runtime.portalId })
          .catch(() => undefined)
        : undefined
    );
    this.listeners.clear();
  }

  getPerfSnapshot() {
    return {
      portalHome: this.portalHome,
      runtimePath: this.runtimePath,
      processPid: this.process?.pid,
      processExitCode: this.process?.exitCode,
      startInFlight: Boolean(this.startPromise),
      status: this.getStatus(),
    };
  }

  private async start() {
    const serverUrl = normalizeUrl(this.settingsStore.getSettings().mastraUrl);
    this.setStatus({ phase: 'starting', serverUrl });
    await this.ensurePortalConfig(false);
    const existing = await readJsonFile<PortalRuntimeFile>(this.runtimePath);
    if (
      runtimeFresh(existing) && normalizeUrl(existing!.serverUrl) === serverUrl
    ) {
      await this.waitForServerPresence(existing!);
      this.updateFromRuntime(existing!, 'adopted');
      return;
    }
    if (existing && await this.verifyProcess(existing)) {
      throw new Error(
        'A Portal instance for a different or stale runtime is still running. Stop it explicitly first.',
      );
    }
    await unlink(this.runtimePath).catch(() => undefined);
    await this.spawnPortal(serverUrl);
  }

  private async ensurePortalConfig(refresh: boolean) {
    const serverUrl = normalizeUrl(this.settingsStore.getSettings().mastraUrl);
    const existing = await readJsonFile<PortalConfig>(this.configPath);
    if (
      !refresh && existing?.serverUrl === serverUrl &&
      existing.portal?.portalId && existing.portal.portalToken
    ) return;
    const token = await this.rpc.request('portal.token.issue');
    await writeJsonFile(this.configPath, {
      serverUrl,
      portal: {
        ...(existing?.portal ?? {}),
        portalId: token.portalId,
        portalToken: token.token,
        name: `${os.hostname()} Desktop`,
        roots: [{ id: 'default', name: 'Home', path: this.homePath }],
      },
    });
  }

  private getPortalCommand(): PortalLaunchCommand {
    const configuredCommand = this.env.WEAVE_PORTAL_COMMAND?.trim();
    if (configuredCommand) {
      return {
        file: configuredCommand,
        args: splitExtraArgs(this.env.WEAVE_PORTAL_ARGS),
      };
    }
    if (this.isPackaged) {
      if (!this.resourcesPath) {
        throw new Error('Packaged Portal resources path is unavailable.');
      }
      return { file: path.join(this.resourcesPath, 'portal'), args: [] };
    }
    const sourcePath = this.portalSourcePath ??
      path.resolve(this.appPath, '../portal/src/main.ts');
    return {
      file: this.env.WEAVE_DENO_BIN?.trim() || 'deno',
      args: [
        'run',
        '--allow-net',
        '--allow-read',
        '--allow-write',
        '--allow-env',
        '--allow-run',
        sourcePath,
      ],
    };
  }

  private async spawnPortal(serverUrl: string) {
    const command = this.getPortalCommand();
    const instanceId = randomBytes(24).toString('hex');
    await mkdir(this.portalHome, { recursive: true });
    await this.rotateLog();
    const logFile = await open(this.logPath, 'a', 0o600);
    let child: ChildProcess;
    try {
      child = spawn(command.file, [
        ...command.args,
        'daemon',
        '--config',
        this.configPath,
        '--runtime',
        this.runtimePath,
        '--server',
        serverUrl,
        '--instance-id',
        instanceId,
        '--log-file',
        this.logPath,
        '--log-max-bytes',
        String(maxLogBytes),
      ], {
        env: { ...this.env, WEAVE_PORTAL_HOME: this.portalHome },
        stdio: ['ignore', logFile.fd, logFile.fd],
        detached: true,
      });
      child.unref();
      this.process = child;
      child.once('exit', () => {
        if (this.process === child) this.process = undefined;
      });
    } finally {
      await logFile.close();
    }

    const started = Date.now();
    while (Date.now() - started < this.startupTimeoutMs) {
      const runtime = await readJsonFile<PortalRuntimeFile>(this.runtimePath);
      if (
        runtimeFresh(runtime) && runtime?.instanceId === instanceId &&
        normalizeUrl(runtime.serverUrl) === serverUrl &&
        runtime.connectionState === 'connected'
      ) {
        await this.waitForServerPresence(runtime);
        this.updateFromRuntime(runtime, 'launched');
        return;
      }
      if (child.exitCode !== null) {
        throw new Error(
          `Portal exited during startup.${await this.readLogTail()}`,
        );
      }
      await sleep(150);
    }
    throw new Error(
      `Timed out waiting for Portal to connect.${await this.readLogTail()}`,
    );
  }

  private async waitForServerPresence(runtime: PortalRuntimeFile) {
    const started = Date.now();
    while (Date.now() - started < this.startupTimeoutMs) {
      if (this.onlinePortalIds.has(runtime.portalId)) return;
      const result = await this.rpc.request('portal.list');
      if (
        result.portals.some((portal) => portal.portalId === runtime.portalId && portal.status === 'online')
      ) {
        this.onlinePortalIds.add(runtime.portalId);
        return;
      }
      await sleep(150);
    }
    throw new Error(
      'Portal heartbeat exists but the server does not report it online.',
    );
  }

  private async monitorOnce() {
    if (this.disposed) return;
    const runtime = await readJsonFile<PortalRuntimeFile>(this.runtimePath);
    if (!runtimeFresh(runtime)) {
      this.startPromise = undefined;
      void this.ensureStarted().catch(() => undefined);
      return;
    }
    this.updateFromRuntime(runtime!, this.status.source ?? 'adopted');
  }

  private async handlePortalStatus(params: unknown) {
    const event = params && typeof params === 'object' && !Array.isArray(params)
      ? params as { portalId?: unknown; status?: unknown }
      : undefined;
    if (typeof event?.portalId !== 'string') return;
    if (event.status === 'online') this.onlinePortalIds.add(event.portalId);
    else this.onlinePortalIds.delete(event.portalId);

    const runtime = await readJsonFile<PortalRuntimeFile>(this.runtimePath);
    if (!runtime || runtime.portalId !== event.portalId) return;
    if (event.status !== 'online') {
      this.setStatus({
        ...this.status,
        phase: 'reconnecting',
        remoteConnectionState: 'reconnecting',
        error: 'Portal disconnected from the server.',
      });
      return;
    }
    if (runtimeFresh(runtime)) this.updateFromRuntime(runtime, this.status.source ?? 'adopted');
  }

  private updateFromRuntime(
    runtime: PortalRuntimeFile,
    source: 'adopted' | 'launched',
  ) {
    this.setStatus({
      phase: runtime.connectionState === 'connected' ? 'ready' : 'reconnecting',
      serverUrl: normalizeUrl(runtime.serverUrl),
      source,
      remoteConnectionState: runtime.connectionState === 'stopped' ? 'reconnecting' : runtime.connectionState,
      remoteConnectedAt: runtime.connectedAt,
      error: runtime.error,
    });
  }

  private async verifyProcess(runtime: PortalRuntimeFile) {
    try {
      const { stdout } = await execFileAsync('ps', [
        '-p',
        String(runtime.pid),
        '-o',
        'command=',
      ]);
      return stdout.includes(this.runtimePath) &&
        stdout.includes(runtime.instanceId);
    } catch {
      return false;
    }
  }

  private setFailed(error: unknown) {
    this.setStatus({
      phase: 'failed',
      serverUrl: normalizeUrl(this.settingsStore.getSettings().mastraUrl),
      source: this.status.source,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private setStatus(status: DesktopPortalStatus) {
    this.status = status;
    for (const listener of this.listeners) listener(this.getStatus());
  }

  private async rotateLog() {
    const info = await stat(this.logPath).catch(() => undefined);
    if (!info || info.size < maxLogBytes) return;
    const previousPath = `${this.logPath}.1`;
    await unlink(previousPath).catch(() => undefined);
    await rename(this.logPath, previousPath);
    await chmod(previousPath, 0o600).catch(() => undefined);
  }

  private async readLogTail() {
    const text = await readFile(this.logPath, 'utf8').catch(() => '');
    const tail = text.slice(-4_000).trim();
    return tail ? ` Portal log:\n${tail}` : '';
  }
}
