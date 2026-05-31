import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { TerminalHostEvent, TerminalStartInput, TerminalStartResult } from '../shared/terminal';
import type { ConnectionSettingsStore } from './settings-store';

export type TerminalWebContents = {
  id: number;
  isDestroyed: () => boolean;
  send: (channel: string, event: TerminalHostEvent) => void;
};

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
  startedAt?: string;
  updatedAt?: string;
};

type LocalTerminalConnection = {
  clientId: string;
  socket: WebSocket;
  terminalId: string;
  subscribers: Map<number, TerminalWebContents>;
  pendingStart?: {
    resolve: (value: TerminalStartResult) => void;
    reject: (error: Error) => void;
  };
};

type PortalSupervisorOptions = {
  settingsStore: ConnectionSettingsStore;
  homePath: string;
};

const terminalEventChannel = 'terminal:event';
const defaultPortalWsPort = '4112';

const getAvailablePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close(() => reject(new Error('Could not reserve a Portal control port.')));
      return;
    }
    const { port } = address;
    server.close(error => error ? reject(error) : resolve(port));
  });
});

const toPortalWsUrl = (mastraUrl: string) => {
  const explicit = process.env.WEAVE_PORTAL_WS_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const url = new URL(mastraUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.port = process.env.WEAVE_PORTAL_WS_PORT ?? defaultPortalWsPort;
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
};

const normalizeHttpUrl = (value: string) => value.replace(/\/+$/, '');
const normalizeWsUrl = (value: string) => value.replace(/\/+$/, '');

const resolvePortalHome = () => {
  const explicit = process.env.WEAVE_PORTAL_HOME?.trim();
  if (explicit) return explicit;
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(configHome, 'weave', 'portal');
};

const readJsonFile = async <T>(filePath: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    return undefined;
  }
};

const writeJsonFile = async (filePath: string, value: unknown) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};

const splitExtraArgs = (value: string | undefined) => value?.split(/\s+/).filter(Boolean) ?? [];

export class PortalSupervisor {
  private readonly settingsStore: ConnectionSettingsStore;
  private readonly homePath: string;
  private readonly portalHome: string;
  private readonly configPath: string;
  private readonly runtimePath: string;
  private controlHost = '127.0.0.1';
  private controlPort?: number;
  private controlToken?: string;
  private process?: ChildProcess;
  private started?: Promise<void>;

  constructor(options: PortalSupervisorOptions) {
    this.settingsStore = options.settingsStore;
    this.homePath = options.homePath;
    this.portalHome = resolvePortalHome();
    this.configPath = path.join(this.portalHome, 'config.json');
    this.runtimePath = path.join(this.portalHome, 'runtime.json');
  }

  async ensureStarted() {
    if (!this.started) {
      this.started = this.start().catch(error => {
        this.started = undefined;
        throw error;
      });
    }
    await this.started;
    if (!this.controlPort || !this.controlToken) throw new Error('Portal control server is not initialized.');
    return {
      url: `ws://${this.controlHost}:${this.controlPort}/terminal?token=${encodeURIComponent(this.controlToken)}`,
      token: this.controlToken,
    };
  }

  private async start() {
    const settings = this.settingsStore.getSettings();
    const httpServerUrl = normalizeHttpUrl(settings.mastraUrl);
    const wsServerUrl = toPortalWsUrl(httpServerUrl);
    await this.ensurePortalConfig(httpServerUrl, wsServerUrl);

    if (await this.tryAdoptRuntime(httpServerUrl, wsServerUrl)) return;

    if (await this.isHealthy()) return;

    this.controlHost = '127.0.0.1';
    this.controlPort ??= await getAvailablePort();
    this.controlToken ??= randomBytes(24).toString('hex');
    const command = this.getPortalCommand();
    const portalEnv = {
      ...process.env,
      WEAVE_PORTAL_HOME: this.portalHome,
    };

    this.process = spawn(command.file, [
      ...command.args,
      'daemon',
      '--config',
      this.configPath,
      '--ws-server',
      wsServerUrl,
      '--control-host',
      '127.0.0.1',
      '--control-port',
      String(this.controlPort),
      '--control-token',
      this.controlToken,
    ], {
      env: portalEnv,
      stdio: 'ignore',
      detached: false,
    });

    this.process.once('exit', () => {
      this.process = undefined;
      this.started = undefined;
    });

    await this.waitUntilHealthy();
  }

  private async ensurePortalConfig(httpServerUrl: string, wsServerUrl: string) {
    const existing = await readJsonFile<PortalConfig>(this.configPath);
    if (
      existing?.httpServerUrl === httpServerUrl
      && existing.wsServerUrl === wsServerUrl
      && existing.portal?.portalId
      && existing.portal.portalToken
    ) {
      return;
    }

    const authToken = this.settingsStore.getAuthToken();
    if (!authToken) throw new Error('Portal requires a saved auth token before terminals can start.');

    const response = await fetch(`${httpServerUrl}/portals/token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${authToken}` },
    });
    if (!response.ok) throw new Error(`Portal token request failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as PortalTokenResponse;
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

  private getPortalCommand() {
    const configuredCommand = process.env.WEAVE_PORTAL_COMMAND?.trim();
    if (configuredCommand) {
      return {
        file: configuredCommand,
        args: splitExtraArgs(process.env.WEAVE_PORTAL_ARGS),
      };
    }

    const packagedPortal = process.resourcesPath ? path.join(process.resourcesPath, 'portal') : undefined;
    const binaryCandidates = [
      packagedPortal,
      path.resolve(process.cwd(), '../portal/dist/portal'),
      path.resolve(process.cwd(), 'portal/dist/portal'),
      path.resolve(__dirname, '../../portal/dist/portal'),
      path.resolve(__dirname, '../../../portal/dist/portal'),
    ].filter((candidate): candidate is string => Boolean(candidate));
    const binaryPath = binaryCandidates.find(candidate => existsSync(candidate));
    if (binaryPath) {
      return {
        file: binaryPath,
        args: splitExtraArgs(process.env.WEAVE_PORTAL_ARGS),
      };
    }

    const candidates = [
      path.resolve(process.cwd(), '../portal/src/main.ts'),
      path.resolve(process.cwd(), 'portal/src/main.ts'),
      path.resolve(__dirname, '../../portal/src/main.ts'),
      path.resolve(__dirname, '../../../portal/src/main.ts'),
    ];
    const sourcePath = candidates.find(candidate => existsSync(candidate));
    if (!sourcePath) {
      throw new Error('Could not find Portal. Set WEAVE_PORTAL_COMMAND to a compiled Portal binary.');
    }

    return {
      file: process.env.WEAVE_DENO_BIN?.trim() || 'deno',
      args: [
        'run',
        '--allow-net',
        '--allow-read',
        '--allow-write',
        '--allow-env',
        '--allow-ffi',
        '--allow-run',
        sourcePath,
      ],
    };
  }

  private async isHealthy() {
    if (!this.controlPort || !this.controlToken) return false;
    try {
      const response = await fetch(`http://${this.controlHost}:${this.controlPort}/health?token=${encodeURIComponent(this.controlToken)}`);
      return response.ok;
    } catch {
      return false;
    }
  }

  private async tryAdoptRuntime(httpServerUrl: string, wsServerUrl: string) {
    const runtime = await readJsonFile<PortalRuntimeFile>(this.runtimePath);
    if (
      runtime?.version !== 1 ||
      !runtime.controlHost ||
      !runtime.controlPort ||
      !runtime.controlToken ||
      normalizeHttpUrl(runtime.httpServerUrl ?? '') !== httpServerUrl ||
      normalizeWsUrl(runtime.wsServerUrl ?? '') !== wsServerUrl
    ) {
      return false;
    }

    try {
      const url = `http://${runtime.controlHost}:${runtime.controlPort}/health?token=${encodeURIComponent(runtime.controlToken)}`;
      const response = await fetch(url);
      if (!response.ok) return false;
      const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
      if (typeof body?.httpServerUrl === 'string' && normalizeHttpUrl(body.httpServerUrl) !== httpServerUrl) {
        return false;
      }
      if (typeof body?.wsServerUrl === 'string' && normalizeWsUrl(body.wsServerUrl) !== wsServerUrl) {
        return false;
      }

      this.controlHost = runtime.controlHost;
      this.controlPort = runtime.controlPort;
      this.controlToken = runtime.controlToken;
      return true;
    } catch {
      return false;
    }
  }

  private async waitUntilHealthy() {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 10_000) {
      if (await this.isHealthy()) return;
      if (this.process?.exitCode !== null) throw new Error('Portal exited before local terminal control became available.');
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('Timed out waiting for Portal local terminal control.');
  }
}

export class PortalTerminalClient {
  private readonly supervisor: PortalSupervisor;
  private readonly connections = new Map<string, LocalTerminalConnection>();

  constructor(supervisor: PortalSupervisor) {
    this.supervisor = supervisor;
  }

  async start(input: TerminalStartInput, webContents: TerminalWebContents): Promise<TerminalStartResult> {
    const connection = await this.getConnection(input.terminalId);
    connection.subscribers.set(webContents.id, webContents);
    return new Promise<TerminalStartResult>((resolve, reject) => {
      connection.pendingStart = { resolve, reject };
      this.send(connection, { type: 'start', ...input });
    });
  }

  async input(terminalId: string, data: string) {
    const connection = this.connections.get(terminalId);
    if (!connection) return;
    this.send(connection, { type: 'input', terminalId, data });
  }

  async resize(terminalId: string, cols: number, rows: number) {
    const connection = this.connections.get(terminalId);
    if (!connection) return;
    this.send(connection, { type: 'resize', terminalId, cols, rows });
  }

  async close(terminalId: string) {
    const connection = this.connections.get(terminalId);
    if (!connection) return;
    this.send(connection, { type: 'close', terminalId });
    connection.socket.close();
    this.connections.delete(terminalId);
  }

  async detach(terminalId: string, webContents: TerminalWebContents) {
    const connection = this.connections.get(terminalId);
    if (!connection) return;
    connection.subscribers.delete(webContents.id);
    if (connection.subscribers.size > 0) return;
    this.send(connection, { type: 'detach', terminalId });
    connection.socket.close();
    this.connections.delete(terminalId);
  }

  detachWebContents(webContentsId: number) {
    for (const [terminalId, connection] of this.connections) {
      connection.subscribers.delete(webContentsId);
      if (connection.subscribers.size === 0) {
        this.send(connection, { type: 'detach', terminalId });
        connection.socket.close();
        this.connections.delete(terminalId);
      }
    }
  }

  dispose() {
    for (const connection of this.connections.values()) {
      connection.socket.close();
    }
    this.connections.clear();
  }

  private async getConnection(terminalId: string) {
    const existing = this.connections.get(terminalId);
    if (existing && existing.socket.readyState === WebSocket.OPEN) return existing;

    const control = await this.supervisor.ensureStarted();
    const socket = new WebSocket(control.url);
    const connection: LocalTerminalConnection = {
      clientId: `desktop:${randomBytes(12).toString('hex')}`,
      terminalId,
      socket,
      subscribers: new Map(),
    };

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('Portal local terminal WebSocket failed.'));
      socket.onclose = () => {
        connection.pendingStart?.reject(new Error('Portal local terminal WebSocket closed.'));
        connection.pendingStart = undefined;
        this.connections.delete(terminalId);
      };
      socket.onmessage = event => {
        const envelope = JSON.parse(String(event.data)) as { type?: string; event?: TerminalHostEvent };
        if (envelope.type !== 'terminal.event' || !envelope.event) return;
        this.handleEvent(connection, envelope.event);
      };
    });

    this.connections.set(terminalId, connection);
    return connection;
  }

  private send(connection: LocalTerminalConnection, message: { type: string; [key: string]: unknown }) {
    if (connection.socket.readyState !== WebSocket.OPEN) throw new Error('Portal local terminal WebSocket is not open.');
    connection.socket.send(JSON.stringify({ type: 'terminal.client', clientId: connection.clientId, message }));
  }

  private handleEvent(connection: LocalTerminalConnection, event: TerminalHostEvent) {
    if (event.type === 'started') {
      connection.pendingStart?.resolve({ sessionId: event.sessionId, cwd: event.cwd });
      connection.pendingStart = undefined;
    } else if (event.type === 'error' && connection.pendingStart && event.terminalId === connection.terminalId) {
      connection.pendingStart.reject(new Error(event.error));
      connection.pendingStart = undefined;
    }

    for (const [id, webContents] of connection.subscribers) {
      if (webContents.isDestroyed()) {
        connection.subscribers.delete(id);
        continue;
      }
      webContents.send(terminalEventChannel, event);
    }
  }
}
