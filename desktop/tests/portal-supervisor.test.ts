import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PortalSupervisor } from '../src/main/portal-supervisor';
import type { ConnectionSettingsStore } from '../src/main/settings-store';

const requiredControlCapabilities = [
  'terminal',
  'workspace-files',
  'workspace-files.watch',
  'lsp',
  'terminal.tmux-source-of-truth',
  'terminal.tmux-control-mode',
];

const supervisors: PortalSupervisor[] = [];

afterEach(() => {
  for (const supervisor of supervisors.splice(0)) supervisor.dispose();
});

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

const listen = (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = createServer(handler);
  return new Promise<{ server: ReturnType<typeof createServer>; url: string }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
};

const closeServer = async (server: ReturnType<typeof createServer>) => {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
};

const mutableSettingsStore = (initialUrl: string, authToken?: string) => {
  let mastraUrl = initialUrl;
  return {
    store: {
      getSettings: () => ({ mastraUrl, hasAuthToken: Boolean(authToken) }),
      getAuthToken: () => authToken,
    } as unknown as ConnectionSettingsStore,
    setUrl: (nextUrl: string) => {
      mastraUrl = nextUrl;
    },
  };
};

type TempPortalContext = {
  directory: string;
  portalHome: string;
  configPath: string;
  runtimePath: string;
  fakePortalPath: string;
  launchMarkerPath: string;
};

const fakePortalSource = (launchMarkerPath: string) => `#!/usr/bin/env node
import { createServer } from 'node:http';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const flag = name => args[args.indexOf(name) + 1];
const configPath = flag('--config');
const runtimePath = flag('--runtime');
const host = flag('--control-host');
const requestedPort = Number(flag('--control-port'));
const token = flag('--control-token');
const config = JSON.parse(await readFile(configPath, 'utf8'));
await appendFile(${JSON.stringify(launchMarkerPath)}, JSON.stringify({ pid: process.pid, args }) + '\\n');
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.searchParams.get('token') !== token) {
    response.statusCode = 401;
    response.end('unauthorized');
    return;
  }
  if (url.pathname === '/health') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      ok: true,
      httpServerUrl: config.httpServerUrl,
      wsServerUrl: config.wsServerUrl,
      controlCapabilities: ${JSON.stringify(requiredControlCapabilities)},
      remoteConnectionState: 'connected',
      remoteConnectedAt: new Date().toISOString(),
    }));
    return;
  }
  if (url.pathname === '/shutdown' && request.method === 'POST') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true }));
    setTimeout(() => server.close(() => process.exit(0)), 10);
    return;
  }
  response.statusCode = 404;
  response.end('not found');
});
server.listen(requestedPort, host, async () => {
  const address = server.address();
  const runtime = {
    version: 1,
    pid: process.pid,
    portalId: config.portal.portalId,
    configPath,
    httpServerUrl: config.httpServerUrl,
    wsServerUrl: config.wsServerUrl,
    controlHost: host,
    controlPort: address.port,
    controlToken: token,
    controlCapabilities: ${JSON.stringify(requiredControlCapabilities)},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const temporaryPath = runtimePath + '.' + process.pid + '.tmp';
  await writeFile(temporaryPath, JSON.stringify(runtime), { mode: 0o600 });
  await rename(temporaryPath, runtimePath);
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
`;

const stopRuntime = async (runtimePath: string) => {
  const runtime = await readFile(runtimePath, 'utf8')
    .then(text => JSON.parse(text))
    .catch(() => undefined);
  if (!runtime?.controlHost || !runtime.controlPort || !runtime.controlToken) return;
  await fetch(
    `http://${runtime.controlHost}:${runtime.controlPort}/shutdown?token=${encodeURIComponent(runtime.controlToken)}`,
    { method: 'POST' },
  ).catch(() => undefined);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      process.kill(runtime.pid, 0);
      await delay(20);
    } catch {
      return;
    }
  }
  if (runtime.pid !== process.pid) process.kill(runtime.pid, 'SIGTERM');
};

const withTempPortal = async <T>(callback: (context: TempPortalContext) => Promise<T>) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'weave-portal-supervisor-'));
  const portalHome = path.join(directory, 'portal');
  const context = {
    directory,
    portalHome,
    configPath: path.join(portalHome, 'config.json'),
    runtimePath: path.join(portalHome, 'runtime.json'),
    fakePortalPath: path.join(directory, 'fake-portal.mjs'),
    launchMarkerPath: path.join(directory, 'launches.jsonl'),
  };
  await mkdir(portalHome, { recursive: true });
  await writeFile(context.fakePortalPath, fakePortalSource(context.launchMarkerPath), { mode: 0o700 });
  await chmod(context.fakePortalPath, 0o700);
  try {
    return await callback(context);
  } finally {
    await stopRuntime(context.runtimePath);
    await rm(directory, { recursive: true, force: true });
  }
};

const writeConfig = async (context: TempPortalContext, httpServerUrl: string, portalToken = 'portal-token') => {
  const url = new URL(httpServerUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.port = '4112';
  url.pathname = '';
  await writeFile(
    context.configPath,
    JSON.stringify({
      httpServerUrl,
      wsServerUrl: url.toString().replace(/\/$/, ''),
      portal: {
        portalId: 'portal_test',
        portalToken,
        roots: [{ id: 'default', name: 'Home', path: tmpdir() }],
      },
    }),
  );
};

const startControlRuntime = async (
  context: TempPortalContext,
  options: {
    httpServerUrl: string;
    wsServerUrl?: string;
    token?: string;
    capabilities?: string[];
    remoteConnectionState?: string;
    remoteConnectionError?: string;
    closeOnShutdown?: boolean;
  },
) => {
  const token = options.token ?? 'local-token';
  let shutdownRequested = false;
  let server: ReturnType<typeof createServer>;
  const listening = await listen((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('token') !== token) {
      response.statusCode = 401;
      response.end('unauthorized');
      return;
    }
    if (url.pathname === '/health') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          ok: true,
          httpServerUrl: options.httpServerUrl,
          wsServerUrl: options.wsServerUrl ?? 'ws://mastra.test:4112',
          controlCapabilities: options.capabilities ?? requiredControlCapabilities,
          remoteConnectionState: options.remoteConnectionState,
          remoteConnectionError: options.remoteConnectionError,
        }),
      );
      return;
    }
    if (url.pathname === '/shutdown' && request.method === 'POST') {
      shutdownRequested = true;
      response.end(JSON.stringify({ ok: true }));
      if (options.closeOnShutdown) {
        setTimeout(() => {
          server.close();
          server.closeAllConnections();
        }, 10);
      }
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  server = listening.server;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const startedAt = new Date().toISOString();
  await writeFile(
    context.runtimePath,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      portalId: 'portal_control',
      configPath: context.configPath,
      httpServerUrl: options.httpServerUrl,
      wsServerUrl: options.wsServerUrl ?? 'ws://mastra.test:4112',
      controlHost: '127.0.0.1',
      controlPort: address.port,
      controlToken: token,
      controlCapabilities: options.capabilities ?? requiredControlCapabilities,
      startedAt,
      updatedAt: startedAt,
    }),
  );
  return {
    server,
    get shutdownRequested() {
      return shutdownRequested;
    },
  };
};

const createSupervisor = (
  context: TempPortalContext,
  settingsStore: ConnectionSettingsStore,
  options: Partial<ConstructorParameters<typeof PortalSupervisor>[0]> = {},
) => {
  const supervisor = new PortalSupervisor({
    settingsStore,
    homePath: tmpdir(),
    env: {
      WEAVE_PORTAL_HOME: context.portalHome,
      WEAVE_PORTAL_COMMAND: process.execPath,
      WEAVE_PORTAL_ARGS: context.fakePortalPath,
    },
    startupTimeoutMs: 3_000,
    monitorIntervalMs: 25,
    ...options,
  });
  supervisors.push(supervisor);
  return supervisor;
};

const startTokenServer = async (portalId = 'portal_provisioned', portalToken = 'new-portal-token') => {
  let requests = 0;
  const listening = await listen((request, response) => {
    if (request.url === '/portal/token' && request.method === 'POST') {
      requests += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ portalId, token: portalToken }));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  return {
    ...listening,
    get requests() {
      return requests;
    },
  };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error('Timed out waiting for test condition.');
};

describe('PortalSupervisor', () => {
  it('eagerly adopts a healthy matching runtime without owner credentials', async () =>
    withTempPortal(async context => {
      await writeConfig(context, 'http://mastra.test');
      const runtime = await startControlRuntime(context, { httpServerUrl: 'http://mastra.test' });
      const settings = mutableSettingsStore('http://mastra.test');
      const supervisor = createSupervisor(context, settings.store);

      supervisor.startMonitoring();
      await waitFor(() => supervisor.getStatus().phase === 'ready');

      expect(supervisor.getStatus()).toMatchObject({ phase: 'ready', source: 'adopted' });
      supervisor.dispose();
      const address = runtime.server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      const adoptedHealth = await fetch(
        `http://127.0.0.1:${address.port}/health?token=local-token`,
      );
      expect(adoptedHealth.ok).toBe(true);
      expect(runtime.shutdownRequested).toBe(false);
      await closeServer(runtime.server);
    }));

  it('reports homelab outages as reconnecting without restarting Portal', async () =>
    withTempPortal(async context => {
      await writeConfig(context, 'http://mastra.test');
      const runtime = await startControlRuntime(context, {
        httpServerUrl: 'http://mastra.test',
        remoteConnectionState: 'reconnecting',
        remoteConnectionError: 'server unreachable',
      });
      const settings = mutableSettingsStore('http://mastra.test');
      const supervisor = createSupervisor(context, settings.store);

      await supervisor.ensureStarted();

      expect(supervisor.getStatus()).toMatchObject({
        phase: 'reconnecting',
        source: 'adopted',
        error: 'server unreachable',
      });
      expect(runtime.shutdownRequested).toBe(false);
      expect(await readFile(context.launchMarkerPath, 'utf8').catch(() => '')).toBe('');
      await closeServer(runtime.server);
    }));

  it('refreshes cached control after an adopted daemon is replaced', async () =>
    withTempPortal(async context => {
      await writeConfig(context, 'http://mastra.test');
      const first = await startControlRuntime(context, {
        httpServerUrl: 'http://mastra.test',
        token: 'first-token',
      });
      const settings = mutableSettingsStore('http://mastra.test');
      const supervisor = createSupervisor(context, settings.store);
      const firstControl = await supervisor.ensureStarted();

      await closeServer(first.server);
      const second = await startControlRuntime(context, {
        httpServerUrl: 'http://mastra.test',
        token: 'second-token',
      });
      const secondControl = await supervisor.ensureStarted();

      expect(firstControl.httpUrl !== secondControl.httpUrl).toBe(true);
      expect(secondControl.token).toBe('second-token');
      await closeServer(second.server);
    }));

  it('uses a single launch for concurrent ensureStarted calls and keeps a packaged daemon alive on dispose', async () =>
    withTempPortal(async context => {
      const tokenServer = await startTokenServer();
      const settings = mutableSettingsStore(tokenServer.url, 'owner-token');
      const supervisor = createSupervisor(context, settings.store, { isPackaged: true });

      const controls = await Promise.all(Array.from({ length: 8 }, () => supervisor.ensureStarted()));
      expect(new Set(controls.map(control => control.httpUrl)).size).toBe(1);
      expect((await readFile(context.launchMarkerPath, 'utf8')).trim().split('\n')).toHaveLength(1);
      expect(supervisor.getStatus()).toMatchObject({ phase: 'ready', source: 'launched' });

      supervisor.dispose();
      const runtime = JSON.parse(await readFile(context.runtimePath, 'utf8'));
      const health = await fetch(
        `http://${runtime.controlHost}:${runtime.controlPort}/health?token=${encodeURIComponent(runtime.controlToken)}`,
      );
      expect(health.ok).toBe(true);
      expect((await stat(path.join(context.portalHome, 'desktop-daemon.log'))).mode & 0o777).toBe(0o600);
      await closeServer(tokenServer.server);
    }));

  it('stops a Portal launched by Desktop development mode on dispose', async () =>
    withTempPortal(async context => {
      const tokenServer = await startTokenServer();
      const settings = mutableSettingsStore(tokenServer.url, 'owner-token');
      const supervisor = createSupervisor(context, settings.store);

      await supervisor.ensureStarted();
      const runtime = JSON.parse(await readFile(context.runtimePath, 'utf8'));
      expect(supervisor.getStatus()).toMatchObject({ phase: 'ready', source: 'launched' });

      supervisor.dispose();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          process.kill(runtime.pid, 0);
          await delay(20);
        } catch {
          return;
        }
      }
      throw new Error(`Development Portal ${runtime.pid} survived Desktop disposal.`);
    }));

  it('adopts the winner when independent Desktop supervisors race to launch Portal', async () =>
    withTempPortal(async context => {
      await writeConfig(context, 'http://mastra.test');
      const settings = mutableSettingsStore('http://mastra.test');
      const options = {
        portalSourcePath: path.resolve(process.cwd(), '../portal/src/main.ts'),
        env: {
          ...process.env,
          WEAVE_PORTAL_HOME: context.portalHome,
          WEAVE_PORTAL_COMMAND: undefined,
          WEAVE_PORTAL_ARGS: undefined,
          WEAVE_DENO_BIN: 'deno',
        },
        startupTimeoutMs: 8_000,
      };
      const first = createSupervisor(context, settings.store, options);
      const second = createSupervisor(context, settings.store, options);

      const controls = await Promise.all([first.ensureStarted(), second.ensureStarted()]);

      expect(controls[0].httpUrl).toBe(controls[1].httpUrl);
      expect([first.getStatus().source, second.getStatus().source].sort()).toEqual(['adopted', 'launched']);
    }));

  it('recovers a stale runtime using current Portal source in development', async () =>
    withTempPortal(async context => {
      const tokenServer = await startTokenServer();
      await writeConfig(context, tokenServer.url);
      await writeFile(
        context.runtimePath,
        JSON.stringify({
          version: 1,
          pid: 99_999,
          portalId: 'stale',
          configPath: context.configPath,
          httpServerUrl: tokenServer.url,
          wsServerUrl: 'ws://127.0.0.1:4112',
          controlHost: '127.0.0.1',
          controlPort: 9,
          controlToken: 'stale',
          startedAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        }),
      );

      const wrapperPath = path.join(context.directory, 'fake-deno.mjs');
      const markerPath = path.join(context.directory, 'deno-args.json');
      await writeFile(
        wrapperPath,
        `#!${process.execPath}
import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(markerPath)}, JSON.stringify(process.argv.slice(2)));
await import(${JSON.stringify(`file://${context.fakePortalPath}`)});
`,
        { mode: 0o700 },
      );
      await chmod(wrapperPath, 0o700);
      const settings = mutableSettingsStore(tokenServer.url);
      const supervisor = createSupervisor(context, settings.store, {
        portalSourcePath: context.fakePortalPath,
        env: { WEAVE_PORTAL_HOME: context.portalHome, WEAVE_DENO_BIN: wrapperPath },
      });

      await supervisor.ensureStarted();
      const args = JSON.parse(await readFile(markerPath, 'utf8')) as string[];
      expect(args).toContain(context.fakePortalPath);
      expect(args.join(' ').includes('portal/dist/portal')).toBe(false);
      await closeServer(tokenServer.server);
    }));

  it('selects override, packaged, and development commands deterministically', async () =>
    withTempPortal(async context => {
      const settings = mutableSettingsStore('http://mastra.test');
      const command = (options: Partial<ConstructorParameters<typeof PortalSupervisor>[0]>) => {
        const supervisor = createSupervisor(context, settings.store, options);
        return (
          supervisor as unknown as { getPortalCommand: () => { file: string; args: string[]; source: string } }
        ).getPortalCommand();
      };

      expect(
        command({
          env: {
            WEAVE_PORTAL_HOME: context.portalHome,
            WEAVE_PORTAL_COMMAND: '/custom/portal',
            WEAVE_PORTAL_ARGS: '--flag value',
          },
        }),
      ).toEqual({ file: '/custom/portal', args: ['--flag', 'value'], source: 'override' });
      expect(
        command({
          isPackaged: true,
          resourcesPath: '/Applications/Weave.app/Contents/Resources',
          env: { WEAVE_PORTAL_HOME: context.portalHome },
        }),
      ).toEqual({ file: '/Applications/Weave.app/Contents/Resources/portal', args: [], source: 'packaged' });
      const development = command({
        appPath: '/repo/desktop',
        env: { WEAVE_PORTAL_HOME: context.portalHome, WEAVE_DENO_BIN: '/usr/bin/deno' },
      });
      expect(development.file).toBe('/usr/bin/deno');
      expect(development.source).toBe('development');
      expect(development.args).toContain('/repo/portal/src/main.ts');
      expect(development.args.join(' ').includes('portal/dist/portal')).toBe(false);
    }));

  it('provisions the new server before stopping and replacing a mismatched runtime', async () =>
    withTempPortal(async context => {
      await writeConfig(context, 'http://old.test');
      const oldRuntime = await startControlRuntime(context, {
        httpServerUrl: 'http://old.test',
        wsServerUrl: 'ws://old.test:4112',
        closeOnShutdown: true,
      });
      const tokenServer = await startTokenServer('portal_new');
      const settings = mutableSettingsStore(tokenServer.url, 'owner-token');
      const supervisor = createSupervisor(context, settings.store);

      await supervisor.ensureStarted();

      expect(tokenServer.requests).toBe(1);
      expect(oldRuntime.shutdownRequested).toBe(true);
      expect(supervisor.getStatus()).toMatchObject({ phase: 'ready', source: 'launched' });
      const config = JSON.parse(await readFile(context.configPath, 'utf8'));
      expect(config).toMatchObject({ httpServerUrl: tokenServer.url, portal: { portalId: 'portal_new' } });
      await closeServer(tokenServer.server);
    }));

  it('repairs one invalid Portal token through the existing token route', async () =>
    withTempPortal(async context => {
      const tokenServer = await startTokenServer('portal_repaired', 'repaired-token');
      await writeConfig(context, tokenServer.url, 'invalid-token');
      const rejectedRuntime = await startControlRuntime(context, {
        httpServerUrl: tokenServer.url,
        wsServerUrl: 'ws://127.0.0.1:4112',
        remoteConnectionState: 'rejected',
        remoteConnectionError: 'Invalid portal token',
        closeOnShutdown: true,
      });
      const settings = mutableSettingsStore(tokenServer.url, 'owner-token');
      const supervisor = createSupervisor(context, settings.store);

      await supervisor.ensureStarted();

      expect(tokenServer.requests).toBe(1);
      expect(rejectedRuntime.shutdownRequested).toBe(true);
      expect(JSON.parse(await readFile(context.configPath, 'utf8')).portal.portalToken).toBe('repaired-token');
      await closeServer(tokenServer.server);
    }));

  it('reconciles after settings changes and closes the old local runtime', async () =>
    withTempPortal(async context => {
      const first = await startTokenServer('portal_first');
      const second = await startTokenServer('portal_second');
      const settings = mutableSettingsStore(first.url, 'owner-token');
      const supervisor = createSupervisor(context, settings.store);
      await supervisor.ensureStarted();
      const firstRuntime = JSON.parse(await readFile(context.runtimePath, 'utf8'));

      settings.setUrl(second.url);
      await supervisor.reconcile({ refreshPortalToken: true });
      const secondRuntime = JSON.parse(await readFile(context.runtimePath, 'utf8'));

      expect(secondRuntime.pid !== firstRuntime.pid).toBe(true);
      expect(secondRuntime.httpServerUrl).toBe(second.url);
      expect(supervisor.getStatus()).toMatchObject({ serverUrl: second.url, source: 'launched' });
      await closeServer(first.server);
      await closeServer(second.server);
    }));

  it('reports actionable child failures and can be retried without blocking the shell', async () =>
    withTempPortal(async context => {
      const tokenServer = await startTokenServer();
      await writeConfig(context, tokenServer.url);
      const failingPath = path.join(context.directory, 'fake-failure.mjs');
      await writeFile(failingPath, `process.stderr.write('native helper is unavailable\\n'); process.exit(23);\n`);
      const settings = mutableSettingsStore(tokenServer.url);
      const supervisor = createSupervisor(context, settings.store, {
        env: {
          WEAVE_PORTAL_HOME: context.portalHome,
          WEAVE_PORTAL_COMMAND: process.execPath,
          WEAVE_PORTAL_ARGS: failingPath,
        },
      });

      await expect(supervisor.ensureStarted()).rejects.toThrow('native helper is unavailable');
      expect(supervisor.getStatus()).toMatchObject({ phase: 'failed' });
      await expect(supervisor.retry()).rejects.toThrow('native helper is unavailable');
      await closeServer(tokenServer.server);
    }));

  it('reports a missing Portal executable without an unhandled child error', async () =>
    withTempPortal(async context => {
      await writeConfig(context, 'http://mastra.test');
      const settings = mutableSettingsStore('http://mastra.test');
      const supervisor = createSupervisor(context, settings.store, {
        env: {
          WEAVE_PORTAL_HOME: context.portalHome,
          WEAVE_PORTAL_COMMAND: path.join(context.directory, 'missing-portal'),
        },
      });

      await expect(supervisor.ensureStarted()).rejects.toThrow('Could not launch Portal');
      expect(supervisor.getStatus()).toMatchObject({ phase: 'failed' });
    }));
});
