import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatGPTLoginBroker } from '../src/main/chatgpt-login';

const servers: Server[] = [];

const listen = (server: Server, port = 0) =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

const reservePort = async () => {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => close(server).catch(() => undefined)));
});

describe('ChatGPTLoginBroker', () => {
  it('captures the loopback callback and forwards only code and state with owner auth', async () => {
    const callbackPort = await reservePort();
    let completionBody: unknown;
    let completionAuth: string | undefined;
    const weaveServer = createServer((request, response) => {
      if (request.url === '/agent/chatgpt/login/start') {
        expect(request.headers.authorization).toBe('Bearer owner-token');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          url: `http://127.0.0.1:${callbackPort}/auth/callback?code=one-time-code&state=state-1`,
          state: 'state-1',
          expiresAt: Date.now() + 5_000,
        }));
        return;
      }
      if (request.url === '/agent/chatgpt/login/complete') {
        completionAuth = request.headers.authorization;
        const chunks: Buffer[] = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          completionBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ connected: true, accountId: 'account-1', expires: 123 }));
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    servers.push(weaveServer);
    const weavePort = await listen(weaveServer);
    let browserHtml = '';
    const broker = new ChatGPTLoginBroker({
      port: callbackPort,
      getConnection: () => ({ mastraUrl: `http://127.0.0.1:${weavePort}`, authToken: 'owner-token' }),
      openExternal: async (url) => {
        browserHtml = await (await fetch(url)).text();
      },
    });

    const first = broker.connect();
    const second = broker.connect();
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ connected: true, accountId: 'account-1', expires: 123 });
    expect(completionAuth).toBe('Bearer owner-token');
    expect(completionBody).toEqual({ code: 'one-time-code', state: 'state-1' });
    await vi.waitFor(() => expect(browserHtml).toContain('ChatGPT Connected'));
    expect(browserHtml.includes('one-time-code')).toBe(false);
  });

  it('rejects mismatched state without forwarding completion', async () => {
    const callbackPort = await reservePort();
    let completions = 0;
    const weaveServer = createServer((request, response) => {
      if (request.url === '/agent/chatgpt/login/start') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          url: `http://127.0.0.1:${callbackPort}/auth/callback?code=code&state=wrong-state`,
          state: 'expected-state',
          expiresAt: Date.now() + 5_000,
        }));
        return;
      }
      completions += 1;
      response.statusCode = 500;
      response.end();
    });
    servers.push(weaveServer);
    const weavePort = await listen(weaveServer);
    const broker = new ChatGPTLoginBroker({
      port: callbackPort,
      getConnection: () => ({ mastraUrl: `http://127.0.0.1:${weavePort}`, authToken: 'owner-token' }),
      openExternal: async (url) => {
        await fetch(url);
      },
    });

    await expect(broker.connect()).rejects.toThrow(/state did not match/);
    expect(completions).toBe(0);
  });

  it('reports an occupied callback port and cleans up', async () => {
    const occupied = createServer();
    servers.push(occupied);
    const port = await listen(occupied);
    const broker = new ChatGPTLoginBroker({
      port,
      getConnection: () => ({ mastraUrl: 'http://127.0.0.1:4111', authToken: 'owner-token' }),
      openExternal: async () => undefined,
    });

    await expect(broker.connect()).rejects.toThrow(`Port ${port} is already in use`);
  });

  it('times out and surfaces provider callback errors', async () => {
    const timeoutPort = await reservePort();
    const timeoutServer = createServer((request, response) => {
      if (request.url === '/agent/chatgpt/login/start') {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({ url: 'https://auth.openai.com/test', state: 'state-1', expiresAt: Date.now() + 20 }),
        );
      }
    });
    servers.push(timeoutServer);
    const timeoutServerPort = await listen(timeoutServer);
    const timeoutBroker = new ChatGPTLoginBroker({
      port: timeoutPort,
      getConnection: () => ({ mastraUrl: `http://127.0.0.1:${timeoutServerPort}`, authToken: 'owner-token' }),
      openExternal: async () => undefined,
    });
    await expect(timeoutBroker.connect()).rejects.toThrow(/timed out/);

    const callbackPort = await reservePort();
    const errorServer = createServer((request, response) => {
      if (request.url === '/agent/chatgpt/login/start') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          url: `http://127.0.0.1:${callbackPort}/auth/callback?error_description=Access%20denied%20%3Cscript%3E`,
          state: 'state-1',
          expiresAt: Date.now() + 5_000,
        }));
      }
    });
    servers.push(errorServer);
    const errorServerPort = await listen(errorServer);
    let browserHtml = '';
    const errorBroker = new ChatGPTLoginBroker({
      port: callbackPort,
      getConnection: () => ({ mastraUrl: `http://127.0.0.1:${errorServerPort}`, authToken: 'owner-token' }),
      openExternal: async (url) => {
        browserHtml = await (await fetch(url)).text();
      },
    });
    await expect(errorBroker.connect()).rejects.toThrow(/Access denied/);
    await vi.waitFor(() => expect(browserHtml).toContain('&lt;script&gt;'));
    expect(browserHtml.includes('<script>')).toBe(false);
  });
});
