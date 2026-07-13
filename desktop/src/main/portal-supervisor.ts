import { randomBytes } from 'node:crypto';
import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DesktopPortalStatus } from '../shared/desktop-api';
import type { ConnectionSettingsStore } from './settings-store';

type PortalConfig = {
  httpServerUrl?: string;
  wsServerUrl?: string;
  portalId?: string;
  portal?: {
    portalId?: string;
    portalToken?: string;
    name?: string;
    roots?: Array<{ id: string; name: string; path: string }>;
  };
};

type PortalTokenResponse = {
  portalId?: string;
  token?: string;
};

type PortalRuntimeFile = {
  version?: number;
  pid?: number;
  portalId?: string;
  configPath?: string;
  httpServerUrl?: string;
  wsServerUrl?: string;
  controlHost?: string;
  controlPort?: number;
  controlToken?: string;
  controlCapabilities?: string[];
  startedAt?: string;
  updatedAt?: string;
};

type PortalHealthBody = {
  httpServerUrl?: string;
  wsServerUrl?: string;
  controlCapabilities?: unknown;
  localControlReady?: unknown;
  remoteConnectionState?: unknown;
  remoteConnectionError?: unknown;
  remoteConnectedAt?: unknown;
};

type PortalLaunchCommand = {
  file: string;
  args: string[];
  source: 'override' | 'packaged' | 'development';
};

type PortalRuntimeInspection = {
  runtime?: PortalRuntimeFile;
  health?: PortalHealthBody;
  kind: 'missing' | 'stale' | 'matching' | 'mismatched' | 'incompatible';
};

export type PortalSupervisorOptions = {
  settingsStore: ConnectionSettingsStore;
  homePath: string;
  isPackaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  portalSourcePath?: string;
  env?: NodeJS.ProcessEnv;
  monitorIntervalMs?: number;
  startupTimeoutMs?: number;
};

const defaultPortalWsPort = '4112';
const defaultMonitorIntervalMs = 10_000;
const defaultStartupTimeoutMs = 15_000;
const maxLogBytes = 1_000_000;
const requiredControlCapabilities = [
  'terminal',
  'workspace-files',
  'workspace-files.watch',
  'lsp',
  'terminal.tmux-source-of-truth',
  'terminal.tmux-control-mode',
];

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const normalizeHttpUrl = (value: string) => value.replace(/\/+$/, '');
const normalizeWsUrl = (value: string) => value.replace(/\/+$/, '');
const splitExtraArgs = (value: string | undefined) => value?.split(/\s+/).filter(Boolean) ?? [];

const optionalRemoteConnectionState = (value: unknown): DesktopPortalStatus['remoteConnectionState'] =>
  value === 'connecting' || value === 'connected' || value === 'reconnecting' || value === 'rejected'
    ? value
    : undefined;

const toPortalWsUrl = (mastraUrl: string, env: NodeJS.ProcessEnv) => {
  const explicit = env.WEAVE_PORTAL_WS_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const url = new URL(mastraUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.port = env.WEAVE_PORTAL_WS_PORT ?? defaultPortalWsPort;
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
};

const resolvePortalHome = (env: NodeJS.ProcessEnv) => {
  const explicit = env.WEAVE_PORTAL_HOME?.trim();
  if (explicit) return explicit;
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(configHome, 'weave', 'portal');
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
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await chmod(temporaryPath, 0o600).catch(() => undefined);
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

const hasRequiredControlCapabilities = (body: PortalHealthBody | undefined) => {
  const capabilities = body?.controlCapabilities;
  if (!Array.isArray(capabilities)) return false;
  return requiredControlCapabilities.every(capability => capabilities.includes(capability));
};

const isInvalidPortalToken = (body: PortalHealthBody | undefined) =>
  body?.remoteConnectionState === 'rejected' &&
  typeof body.remoteConnectionError === 'string' &&
  body.remoteConnectionError.toLowerCase().includes('invalid portal token');

export class PortalSupervisor {
  private readonly settingsStore: ConnectionSettingsStore;
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
  private controlHost = '127.0.0.1';
  private controlPort?: number;
  private controlToken?: string;
  private process?: ChildProcess;
  private started?: Promise<void>;
  private monitor?: ReturnType<typeof setInterval>;
  private status: DesktopPortalStatus;
  private tokenRepairKey?: string;
  private lifecycleGeneration = 0;
  private disposed = false;

  constructor(options: PortalSupervisorOptions) {
    this.settingsStore = options.settingsStore;
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
    this.monitorIntervalMs = options.monitorIntervalMs ?? defaultMonitorIntervalMs;
    this.startupTimeoutMs = options.startupTimeoutMs ?? defaultStartupTimeoutMs;
    this.status = {
      phase: 'idle',
      serverUrl: normalizeHttpUrl(this.settingsStore.getSettings().mastraUrl),
    };
  }

  async ensureStarted() {
    await this.ensureStartedOnce();
    const completedStart = this.started;
    let body = await this.getCurrentHealthBody();
    if (!body) {
      if (this.started === completedStart) {
        this.started = undefined;
        this.clearControlState();
      }
      await this.ensureStartedOnce();
      body = await this.getCurrentHealthBody();
    }
    if (!this.controlPort || !this.controlToken || !body) {
      throw new Error('Portal control server is not initialized.');
    }
    this.updateReadyStatus(body, this.status.source ?? 'adopted');
    return this.getControl();
  }

  startMonitoring() {
    if (this.monitor) return;
    void this.ensureStarted().catch(error => this.setFailed(error));
    this.monitor = setInterval(() => void this.monitorOnce(), this.monitorIntervalMs);
  }

  async reconcile(options: { refreshPortalToken?: boolean } = {}) {
    this.lifecycleGeneration += 1;
    this.started = undefined;
    this.clearControlState();
    await this.ensureStartedOnce(options);
    const body = await this.getCurrentHealthBody();
    if (!body) throw new Error('Portal did not expose local control after reconciliation.');
    this.updateReadyStatus(body, this.status.source ?? 'adopted');
    return this.getControl();
  }

  async retry() {
    this.tokenRepairKey = undefined;
    try {
      return await this.reconcile();
    } catch (error) {
      this.setFailed(error);
      throw error;
    }
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
    this.lifecycleGeneration += 1;
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;
    if (!this.isPackaged && this.process?.exitCode === null) {
      this.process.kill('SIGTERM');
    }
    this.listeners.clear();
  }

  getPerfSnapshot() {
    return {
      portalHome: this.portalHome,
      runtimePath: this.runtimePath,
      controlHost: this.controlHost,
      controlPort: this.controlPort,
      controlReady: Boolean(this.controlPort && this.controlToken),
      processPid: this.process?.pid,
      processExitCode: this.process?.exitCode,
      processSignalCode: this.process?.signalCode,
      startInFlight: Boolean(this.started),
      status: this.getStatus(),
    };
  }

  private async ensureStartedOnce(options: { refreshPortalToken?: boolean } = {}) {
    if (!this.started) {
      const generation = this.lifecycleGeneration;
      const starting = this.start(options, generation).catch(error => {
        if (generation === this.lifecycleGeneration) {
          this.started = undefined;
          this.setFailed(error);
        }
        throw error;
      });
      this.started = starting;
    }
    await this.started;
  }

  private async start(options: { refreshPortalToken?: boolean }, generation: number) {
    const httpServerUrl = normalizeHttpUrl(this.settingsStore.getSettings().mastraUrl);
    const wsServerUrl = toPortalWsUrl(httpServerUrl, this.env);
    this.setStatus({ phase: 'starting', serverUrl: httpServerUrl });

    let inspection = await this.inspectRuntime(httpServerUrl, wsServerUrl);
    this.assertCurrentGeneration(generation);
    const rejectedToken = inspection.kind === 'matching' && isInvalidPortalToken(inspection.health);
    if (inspection.kind === 'matching' && !rejectedToken && !options.refreshPortalToken) {
      this.adoptRuntime(inspection.runtime!);
      this.updateReadyStatus(inspection.health, 'adopted');
      return;
    }

    if (rejectedToken && !options.refreshPortalToken) {
      if (this.tokenRepairKey === httpServerUrl) {
        throw new Error(
          'Portal rejected its refreshed token. Save the connection again or use Retry after checking the server.',
        );
      }
      this.tokenRepairKey = httpServerUrl;
    }

    await this.ensurePortalConfig(httpServerUrl, wsServerUrl, Boolean(options.refreshPortalToken || rejectedToken));
    this.assertCurrentGeneration(generation);

    if (inspection.kind === 'matching' || inspection.kind === 'mismatched' || inspection.kind === 'incompatible') {
      await this.shutdownRuntime(inspection.runtime!);
      await this.waitForRuntimeShutdown(inspection.runtime!);
      this.assertCurrentGeneration(generation);
      inspection = await this.inspectRuntime(httpServerUrl, wsServerUrl);
    }

    await this.spawnPortal(httpServerUrl, wsServerUrl, generation);
  }

  private async inspectRuntime(httpServerUrl: string, wsServerUrl: string): Promise<PortalRuntimeInspection> {
    const runtime = await readJsonFile<PortalRuntimeFile>(this.runtimePath);
    if (runtime?.version !== 1 || !runtime.controlHost || !runtime.controlPort || !runtime.controlToken) {
      return { runtime, kind: runtime ? 'stale' : 'missing' };
    }

    const health = await this.getHealthBody(runtime.controlHost, runtime.controlPort, runtime.controlToken);
    if (!health) return { runtime, kind: 'stale' };
    if (
      normalizeHttpUrl(runtime.httpServerUrl ?? '') !== httpServerUrl ||
      normalizeWsUrl(runtime.wsServerUrl ?? '') !== wsServerUrl ||
      (typeof health.httpServerUrl === 'string' && normalizeHttpUrl(health.httpServerUrl) !== httpServerUrl) ||
      (typeof health.wsServerUrl === 'string' && normalizeWsUrl(health.wsServerUrl) !== wsServerUrl)
    ) {
      return { runtime, health, kind: 'mismatched' };
    }
    if (!hasRequiredControlCapabilities(health)) return { runtime, health, kind: 'incompatible' };
    return { runtime, health, kind: 'matching' };
  }

  private async ensurePortalConfig(httpServerUrl: string, wsServerUrl: string, refreshPortalToken: boolean) {
    const existing = await readJsonFile<PortalConfig>(this.configPath);
    if (
      !refreshPortalToken &&
      existing?.httpServerUrl === httpServerUrl &&
      existing.wsServerUrl === wsServerUrl &&
      existing.portal?.portalId &&
      existing.portal.portalToken
    ) {
      return;
    }

    const authToken = this.settingsStore.getAuthToken();
    if (!authToken) throw new Error('Portal requires a saved auth token before it can be provisioned.');

    const response = await fetch(`${httpServerUrl}/portal/token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${authToken}` },
    });
    if (!response.ok) throw new Error(`Portal token request failed: ${response.status} ${await response.text()}`);
    const body = (await response.json()) as PortalTokenResponse;
    if (!body.portalId || !body.token) throw new Error('Portal token response missing portalId/token.');

    await writeJsonFile(this.configPath, {
      ...existing,
      httpServerUrl,
      wsServerUrl,
      portalId: body.portalId,
      portal: {
        ...(existing?.portal ?? {}),
        portalId: body.portalId,
        portalToken: body.token,
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
        source: 'override',
      };
    }

    if (this.isPackaged) {
      if (!this.resourcesPath) throw new Error('Packaged Portal resources path is unavailable.');
      return {
        file: path.join(this.resourcesPath, 'portal'),
        args: [],
        source: 'packaged',
      };
    }

    const sourcePath = this.portalSourcePath ?? path.resolve(this.appPath, '../portal/src/main.ts');
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
      source: 'development',
    };
  }

  private async spawnPortal(httpServerUrl: string, wsServerUrl: string, generation: number) {
    const command = this.getPortalCommand();
    const controlToken = randomBytes(24).toString('hex');
    await mkdir(this.portalHome, { recursive: true });
    await this.rotateLog();
    const logFile = await open(this.logPath, 'a', 0o600);
    await chmod(this.logPath, 0o600).catch(() => undefined);

    let child: ChildProcess;
    let spawnError: Error | undefined;
    try {
      this.assertCurrentGeneration(generation);
      child = spawn(
        command.file,
        [
          ...command.args,
          'daemon',
          '--config',
          this.configPath,
          '--runtime',
          this.runtimePath,
          '--ws-server',
          wsServerUrl,
          '--control-host',
          '127.0.0.1',
          '--control-port',
          '0',
          '--control-token',
          controlToken,
          '--log-file',
          this.logPath,
          '--log-max-bytes',
          String(maxLogBytes),
        ],
        {
          env: { ...this.env, WEAVE_PORTAL_HOME: this.portalHome },
          stdio: ['ignore', logFile.fd, logFile.fd],
          detached: true,
        },
      );
      child.once('error', error => {
        spawnError = error;
      });
      child.unref();
      this.process = child;
      child.once('exit', () => {
        if (this.process === child) this.process = undefined;
      });
    } finally {
      await logFile.close();
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < this.startupTimeoutMs) {
      this.assertCurrentGeneration(generation);
      if (spawnError) {
        throw new Error(`Could not launch Portal: ${spawnError.message}.${await this.readLogTail()}`);
      }
      const runtime = await readJsonFile<PortalRuntimeFile>(this.runtimePath);
      if (runtime?.controlHost && runtime.controlPort && runtime.controlToken) {
        const health = await this.getHealthBody(runtime.controlHost, runtime.controlPort, runtime.controlToken);
        if (
          health &&
          hasRequiredControlCapabilities(health) &&
          normalizeHttpUrl(runtime.httpServerUrl ?? '') === httpServerUrl &&
          normalizeWsUrl(runtime.wsServerUrl ?? '') === wsServerUrl
        ) {
          this.adoptRuntime(runtime);
          const source = runtime.controlToken === controlToken ? 'launched' : 'adopted';
          this.updateReadyStatus(health, source);
          return;
        }
      }
      if (child.exitCode !== null) {
        const finalInspection = await this.inspectRuntime(httpServerUrl, wsServerUrl);
        if (finalInspection.kind === 'matching') {
          this.adoptRuntime(finalInspection.runtime!);
          this.updateReadyStatus(finalInspection.health, 'adopted');
          return;
        }
        throw new Error(`Portal exited before local control became available.${await this.readLogTail()}`);
      }
      await sleep(150);
    }
    throw new Error(`Timed out waiting for Portal local control.${await this.readLogTail()}`);
  }

  private adoptRuntime(runtime: PortalRuntimeFile) {
    this.controlHost = runtime.controlHost!;
    this.controlPort = runtime.controlPort!;
    this.controlToken = runtime.controlToken!;
  }

  private async shutdownRuntime(runtime: PortalRuntimeFile) {
    if (runtime.controlHost && runtime.controlPort && runtime.controlToken) {
      await fetch(
        `http://${runtime.controlHost}:${runtime.controlPort}/shutdown?token=${encodeURIComponent(
          runtime.controlToken,
        )}`,
        { method: 'POST' },
      ).catch(() => undefined);
    }
    if (this.process && this.process.pid === runtime.pid && this.process.exitCode === null) {
      await sleep(250);
      if (!(await this.getRuntimeHealth(runtime))) return;
      this.process.kill('SIGTERM');
    }
  }

  private async waitForRuntimeShutdown(runtime: PortalRuntimeFile) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5_000) {
      if (!(await this.getRuntimeHealth(runtime))) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for Portal daemon ${runtime.pid ?? 'unknown'} to stop.`);
  }

  private async getRuntimeHealth(runtime: PortalRuntimeFile) {
    if (!runtime.controlHost || !runtime.controlPort || !runtime.controlToken) return undefined;
    return await this.getHealthBody(runtime.controlHost, runtime.controlPort, runtime.controlToken);
  }

  private async getCurrentHealthBody() {
    if (!this.controlPort || !this.controlToken) return undefined;
    const body = await this.getHealthBody(this.controlHost, this.controlPort, this.controlToken);
    return hasRequiredControlCapabilities(body) ? body : undefined;
  }

  private async getHealthBody(host: string, port: number, token: string) {
    const timeout = AbortSignal.timeout(2_000);
    try {
      const response = await fetch(`http://${host}:${port}/health?token=${encodeURIComponent(token)}`, {
        signal: timeout,
      });
      if (!response.ok) return undefined;
      return (await response.json().catch(() => undefined)) as PortalHealthBody | undefined;
    } catch {
      return undefined;
    }
  }

  private async monitorOnce() {
    if (this.started && this.status.phase === 'starting') return;
    try {
      const body = await this.getCurrentHealthBody();
      if (!body) {
        this.started = undefined;
        this.clearControlState();
        await this.ensureStarted();
        return;
      }

      this.updateReadyStatus(body, this.status.source ?? 'adopted');
      if (isInvalidPortalToken(body)) {
        const repairKey = this.status.serverUrl;
        if (this.tokenRepairKey !== repairKey) {
          this.tokenRepairKey = repairKey;
          await this.reconcile({ refreshPortalToken: true });
        } else {
          throw new Error(
            'Portal rejected its refreshed token. Save the connection again or use Retry after checking the server.',
          );
        }
      }
    } catch (error) {
      this.setFailed(error);
    }
  }

  private getControl() {
    const httpUrl = `http://${this.controlHost}:${this.controlPort}`;
    return {
      httpUrl,
      url: `ws://${this.controlHost}:${this.controlPort}/terminal?token=${encodeURIComponent(this.controlToken!)}`,
      token: this.controlToken!,
    };
  }

  private clearControlState() {
    this.controlHost = '127.0.0.1';
    this.controlPort = undefined;
    this.controlToken = undefined;
  }

  private updateReadyStatus(body: PortalHealthBody | undefined, source: 'adopted' | 'launched') {
    const remoteConnectionState = optionalRemoteConnectionState(body?.remoteConnectionState);
    const error = typeof body?.remoteConnectionError === 'string' ? body.remoteConnectionError : undefined;
    const remoteConnectedAt = typeof body?.remoteConnectedAt === 'string' ? body.remoteConnectedAt : undefined;
    if (remoteConnectionState === 'connected') this.tokenRepairKey = undefined;
    this.setStatus({
      phase: remoteConnectionState && remoteConnectionState !== 'connected' ? 'reconnecting' : 'ready',
      serverUrl: normalizeHttpUrl(this.settingsStore.getSettings().mastraUrl),
      source,
      remoteConnectionState,
      remoteConnectedAt,
      error,
    });
  }

  private setFailed(error: unknown) {
    this.setStatus({
      phase: 'failed',
      serverUrl: normalizeHttpUrl(this.settingsStore.getSettings().mastraUrl),
      source: this.status.source,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private setStatus(status: DesktopPortalStatus) {
    this.status = status;
    for (const listener of this.listeners) listener(this.getStatus());
  }

  private assertCurrentGeneration(generation: number) {
    if (this.disposed) throw new Error('Portal supervisor was disposed during startup.');
    if (generation !== this.lifecycleGeneration) throw new Error('Portal lifecycle was superseded by new settings.');
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
