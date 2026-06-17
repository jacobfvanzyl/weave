import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PortalSupervisor } from '../src/main/portal-terminal-client';
import type { ConnectionSettingsStore } from '../src/main/settings-store';

const originalEnv = {
  WEAVE_PORTAL_HOME: process.env.WEAVE_PORTAL_HOME,
  WEAVE_PORTAL_COMMAND: process.env.WEAVE_PORTAL_COMMAND,
  WEAVE_PORTAL_ARGS: process.env.WEAVE_PORTAL_ARGS,
  WEAVE_PORTAL_WS_URL: process.env.WEAVE_PORTAL_WS_URL,
  WEAVE_PORTAL_WS_PORT: process.env.WEAVE_PORTAL_WS_PORT,
};

const requiredControlCapabilities = ['terminal', 'editor', 'terminal.tmux-source-of-truth'];

const restoreEnv = () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const withTempPortal = async <T>(callback: (context: {
  directory: string;
  portalHome: string;
}) => Promise<T>) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'weave-portal-supervisor-'));
  const portalHome = path.join(directory, 'portal');
  process.env.WEAVE_PORTAL_HOME = portalHome;
  try {
    return await callback({ directory, portalHome });
  } finally {
    restoreEnv();
    rmSync(directory, { recursive: true, force: true });
  }
};

const listen = (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = createServer(handler);
  return new Promise<{ server: ReturnType<typeof createServer>; url: string }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
};

const createSettingsStore = (mastraUrl: string, authToken?: string) => ({
  getSettings: () => ({ mastraUrl, hasAuthToken: Boolean(authToken) }),
  getAuthToken: () => authToken,
}) as unknown as ConnectionSettingsStore;

const createSupervisor = (mastraUrl: string, authToken?: string) =>
  new PortalSupervisor({
    settingsStore: createSettingsStore(mastraUrl, authToken),
    homePath: tmpdir(),
  });

describe('PortalSupervisor', () => {
  afterEach(() => restoreEnv());

  it('adopts a healthy shared runtime with matching server URLs', async () =>
    withTempPortal(async ({ portalHome }) => {
      const token = 'local-token';
      const { server, url: controlUrl } = await listen((request, response) => {
        const url = new URL(request.url ?? '/', controlUrl);
        if (url.pathname === '/health' && url.searchParams.get('token') === token) {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({
            ok: true,
            httpServerUrl: 'http://mastra.test',
            wsServerUrl: 'ws://mastra.test:4112',
            controlCapabilities: requiredControlCapabilities,
          }));
          return;
        }
        response.statusCode = 401;
        response.end('unauthorized');
      });

      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('test server did not bind');
        await mkdir(portalHome, { recursive: true });
        await writeFile(path.join(portalHome, 'config.json'), JSON.stringify({
          httpServerUrl: 'http://mastra.test',
          wsServerUrl: 'ws://mastra.test:4112',
          portal: {
            portalId: 'portal_adopted',
            portalToken: 'portal-token',
            roots: [{ id: 'default', name: 'Home', path: tmpdir() }],
          },
        }));
        await writeFile(path.join(portalHome, 'runtime.json'), JSON.stringify({
          version: 1,
          pid: process.pid,
          portalId: 'portal_adopted',
          configPath: path.join(portalHome, 'config.json'),
          httpServerUrl: 'http://mastra.test',
          wsServerUrl: 'ws://mastra.test:4112',
          controlHost: '127.0.0.1',
          controlPort: address.port,
          controlToken: token,
          controlCapabilities: requiredControlCapabilities,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));

        const control = await createSupervisor('http://mastra.test', 'unused-token').ensureStarted();
        expect(control.url).toBe(`ws://127.0.0.1:${address.port}/terminal?token=${token}`);
        expect(control.token).toBe(token);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }));

  it('refreshes cached local control when the adopted runtime is restarted', async () =>
    withTempPortal(async ({ portalHome }) => {
      const startControlServer = async (token: string) => {
        const { server, url: controlUrl } = await listen((request, response) => {
          const url = new URL(request.url ?? '/', controlUrl);
          if (url.pathname === '/health' && url.searchParams.get('token') === token) {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({
              ok: true,
              httpServerUrl: 'http://mastra.test',
              wsServerUrl: 'ws://mastra.test:4112',
              controlCapabilities: requiredControlCapabilities,
            }));
            return;
          }
          response.statusCode = 401;
          response.end('unauthorized');
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('test server did not bind');
        return { server, port: address.port, token };
      };

      const writeRuntime = async (runtime: { port: number; token: string; portalId: string }) => {
        await writeFile(path.join(portalHome, 'runtime.json'), JSON.stringify({
          version: 1,
          pid: process.pid,
          portalId: runtime.portalId,
          configPath: path.join(portalHome, 'config.json'),
          httpServerUrl: 'http://mastra.test',
          wsServerUrl: 'ws://mastra.test:4112',
          controlHost: '127.0.0.1',
          controlPort: runtime.port,
          controlToken: runtime.token,
          controlCapabilities: requiredControlCapabilities,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
      };

      const first = await startControlServer('first-token');
      let firstClosed = false;
      let second: Awaited<ReturnType<typeof startControlServer>> | undefined;
      try {
        await mkdir(portalHome, { recursive: true });
        await writeFile(path.join(portalHome, 'config.json'), JSON.stringify({
          httpServerUrl: 'http://mastra.test',
          wsServerUrl: 'ws://mastra.test:4112',
          portal: {
            portalId: 'portal_first',
            portalToken: 'portal-token',
            roots: [{ id: 'default', name: 'Home', path: tmpdir() }],
          },
        }));
        await writeRuntime({ port: first.port, token: first.token, portalId: 'portal_first' });

        const supervisor = createSupervisor('http://mastra.test', 'unused-token');
        const firstControl = await supervisor.ensureStarted();
        expect(firstControl.url).toBe(`ws://127.0.0.1:${first.port}/terminal?token=${first.token}`);

        await new Promise<void>(resolve => first.server.close(() => resolve()));
        firstClosed = true;
        const restarted = await startControlServer('second-token');
        second = restarted;
        await writeRuntime({ port: restarted.port, token: restarted.token, portalId: 'portal_second' });

        const refreshedControl = await supervisor.ensureStarted();
        expect(refreshedControl.url).toBe(`ws://127.0.0.1:${restarted.port}/terminal?token=${restarted.token}`);
        expect(refreshedControl.token).toBe(restarted.token);
      } finally {
        if (!firstClosed) await new Promise<void>(resolve => first.server.close(() => resolve()));
        const secondServer = second?.server;
        if (secondServer) await new Promise<void>(resolve => secondServer.close(() => resolve()));
      }
    }));

  it('ignores mismatched runtime files', async () =>
    withTempPortal(async ({ portalHome }) => {
      await mkdir(portalHome, { recursive: true });
      await writeFile(path.join(portalHome, 'runtime.json'), JSON.stringify({
        version: 1,
        pid: process.pid,
        portalId: 'portal_mismatch',
        configPath: path.join(portalHome, 'config.json'),
        httpServerUrl: 'http://other.test',
        wsServerUrl: 'ws://other.test:4112',
        controlHost: '127.0.0.1',
        controlPort: 9,
        controlToken: 'wrong',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      await expect(createSupervisor('http://mastra.test').ensureStarted()).rejects.toThrow('saved auth token');
    }));

  it('does not adopt a matching runtime that lacks tmux source-of-truth control', async () =>
    withTempPortal(async ({ directory, portalHome }) => {
      const token = 'old-token';
      let shutdownRequested = false;
      const { server, url: controlUrl } = await listen((request, response) => {
        const url = new URL(request.url ?? '/', controlUrl);
        if (url.pathname === '/health' && url.searchParams.get('token') === token) {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({
            ok: true,
            httpServerUrl: 'http://mastra.test',
            wsServerUrl: 'ws://mastra.test:4112',
            controlCapabilities: ['terminal', 'editor'],
          }));
          return;
        }
        if (url.pathname === '/shutdown' && url.searchParams.get('token') === token) {
          shutdownRequested = true;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        response.statusCode = 401;
        response.end('unauthorized');
      });

      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('test server did not bind');
        await mkdir(portalHome, { recursive: true });
        await writeFile(path.join(portalHome, 'config.json'), JSON.stringify({
          httpServerUrl: 'http://mastra.test',
          wsServerUrl: 'ws://mastra.test:4112',
          portal: {
            portalId: 'portal_terminal_only',
            portalToken: 'portal-token',
            roots: [{ id: 'default', name: 'Home', path: tmpdir() }],
          },
        }));
        await writeFile(path.join(portalHome, 'runtime.json'), JSON.stringify({
          version: 1,
          pid: process.pid,
          portalId: 'portal_terminal_only',
          configPath: path.join(portalHome, 'config.json'),
          httpServerUrl: 'http://mastra.test',
          wsServerUrl: 'ws://mastra.test:4112',
          controlHost: '127.0.0.1',
          controlPort: address.port,
          controlToken: token,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
        const fakePortalPath = path.join(directory, 'fake-exit.mjs');
        await writeFile(fakePortalPath, 'process.exit(0);\n');
        process.env.WEAVE_PORTAL_COMMAND = process.execPath;
        process.env.WEAVE_PORTAL_ARGS = fakePortalPath;

        await expect(createSupervisor('http://mastra.test').ensureStarted()).rejects.toThrow('Portal exited');
        expect(shutdownRequested).toBe(true);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }));

  it('ignores stale unreachable runtime files', async () =>
    withTempPortal(async ({ portalHome }) => {
      await mkdir(portalHome, { recursive: true });
      await writeFile(path.join(portalHome, 'runtime.json'), JSON.stringify({
        version: 1,
        pid: process.pid,
        portalId: 'portal_stale',
        configPath: path.join(portalHome, 'config.json'),
        httpServerUrl: 'http://mastra.test',
        wsServerUrl: 'ws://mastra.test:4112',
        controlHost: '127.0.0.1',
        controlPort: 9,
        controlToken: 'stale',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      await expect(createSupervisor('http://mastra.test').ensureStarted()).rejects.toThrow('saved auth token');
    }));

  it('provisions config and spawns Portal when no compatible runtime exists', async () =>
    withTempPortal(async ({ directory, portalHome }) => {
      const { server, url: mastraUrl } = await listen((request, response) => {
        if (request.url === '/portals/token') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ portalId: 'portal_spawned', token: 'portal-token' }));
          return;
        }
        response.statusCode = 404;
        response.end('not found');
      });

      const fakePortalPath = path.join(directory, 'fake-portal.mjs');
      await writeFile(fakePortalPath, `
import { createServer } from 'node:http';
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const host = flag('--control-host');
const port = Number(flag('--control-port'));
const token = flag('--control-token');
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/health' && url.searchParams.get('token') === token) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, controlCapabilities: ${JSON.stringify(requiredControlCapabilities)} }));
    setTimeout(() => server.close(() => process.exit(0)), 10);
    return;
  }
  response.statusCode = 401;
  response.end('unauthorized');
});
server.listen(port, host);
`);
      process.env.WEAVE_PORTAL_COMMAND = process.execPath;
      process.env.WEAVE_PORTAL_ARGS = fakePortalPath;

      try {
        const control = await createSupervisor(mastraUrl, 'desktop-token').ensureStarted();
        expect(control.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/terminal\?token=/);
        const config = JSON.parse(await readFile(path.join(portalHome, 'config.json'), 'utf8'));
        expect(config.portal).toMatchObject({
          portalId: 'portal_spawned',
          portalToken: 'portal-token',
        });
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }));
});
