import { createServer, type IncomingMessage } from 'node:http';
import { chmod, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BrowserOwner } from './owner.ts';
import { privateDirectory } from './chromium.ts';
import { recoverStaleSocket, removeOwnedSocket } from '../local-socket.ts';
import { BROWSER_RPC_METHODS, parseBrowserRpcParams, type BrowserRpcMethod } from '@weave/product-protocol';
import { BROWSER_PROFILE_RPC_METHODS, browserProfileId, parseBrowserProfileRpcParams, type BrowserProfileRpcMethod } from '@weave/product-protocol';

export const BROWSER_SERVICE_VERSION = 3;
export const MAX_BROWSER_MESSAGE_BYTES = 1024 * 1024;
export const browserSocketPath = (stateDirectory: string) => join(resolve(stateDirectory), 'browser-service', 'service.sock');

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
};
const text = (value: unknown) => {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0')) throw new Error('Invalid identifier');
  return value;
};
async function readBody(request: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BROWSER_MESSAGE_BYTES) throw new Error('Browser request too large');
    chunks.push(chunk);
  }
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

/** Private same-user IPC only. Portal must authorize before calling this service.
 * HTTP connection loss does not close browser processes. No public listener. */
export async function serveBrowserService(options: { stateDirectory: string; binary: string; cefBinary?: string }) {
  const path = browserSocketPath(options.stateDirectory);
  if (Buffer.byteLength(path) > 100) throw new Error('Browser Service socket path exceeds portable Unix socket limit');
  await privateDirectory(resolve(options.stateDirectory));
  await privateDirectory(resolve(options.stateDirectory, 'browser-service'));
  await recoverStaleSocket(path);
  const owner = new BrowserOwner(options.stateDirectory, options.binary, options.cefBinary);
  let stopping = false, inFlight = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    if (request.method !== 'POST' || request.url !== '/rpc') { response.writeHead(404).end(); return; }
    if (stopping || inFlight >= 64) { response.writeHead(503).end(); return; }
    inFlight++;
    let id: unknown = null;
    try {
      const message = await readBody(request);
      id = message.id;
      if (message.jsonrpc !== '2.0' || !Number.isSafeInteger(id) || Number(id) < 1) throw new Error('Invalid JSON-RPC request');
      const params = object(message.params);
      let result: unknown;
      if (message.method === 'hello') {
        if (params.version !== BROWSER_SERVICE_VERSION) throw new Error('Browser Service version mismatch');
        result = { version: BROWSER_SERVICE_VERSION, generation: owner.generation, pid: process.pid };
      } else {
        if (params.serviceGeneration !== owner.generation) throw new Error('Stale Browser Service generation');
        switch (message.method) {
          case 'page.rpc': {
            const pages = owner.managedPages;
            if (!pages) throw new Error('Managed CEF runtime is not configured');
            const method = text(params.method), args = object(params.arguments ?? {});
            if (method === 'page.list') result = { pages: await pages.list(args.profileId === undefined ? undefined : browserProfileId(args.profileId)) };
            else if (method === 'page.events') result = { events: pages.events() };
            else if (method === 'page.create') result = await pages.create(browserProfileId(args.profileId), browserProfileId(args.pageId), String(args.url));
            else if (method === 'page.restore') result = await pages.restore(browserProfileId(args.pageId));
            else if (method === 'page.close') { await pages.closePage(browserProfileId(args.pageId), args.generation === undefined ? undefined : text(args.generation)); result = {}; }
            else result = await pages.command(browserProfileId(args.pageId), text(args.generation), method, object(args.arguments ?? {}));
            break;
          }
          case 'profile.open': result = await owner.openProfile(browserProfileId(params.profileId)); break;
          case 'profile.cdp.send': result = await owner.profileCommand(browserProfileId(params.profileId), text(params.generation), text(params.method), object(params.arguments ?? {}), params.sessionId === undefined ? undefined : text(params.sessionId)); break;
          case 'profile.rpc': {
            const method = text(params.method) as BrowserProfileRpcMethod;
            if (!BROWSER_PROFILE_RPC_METHODS.includes(method)) throw new Error('Unknown Browser Profile operation');
            const input = parseBrowserProfileRpcParams(method, params.arguments);
            if (method === 'browser.profile.list') result = { profiles: await owner.profiles.list() };
            else if ('profileId' in input) result = { profile: await owner.profiles.rename(input.profileId, input.name, input.expectedRevision) };
            else if ('name' in input) result = { profile: await owner.profiles.create(input.name) };
            break;
          }
          case 'workspace.list': result = await owner.list(); break;
          case 'workspace.open': result = await owner.open(text(params.workspaceId)); break;
          case 'workspace.close': await owner.closeWorkspace(text(params.workspaceId), text(params.generation)); result = {}; break;
          case 'cdp.send': result = await owner.command(text(params.workspaceId), text(params.generation), text(params.method), object(params.arguments ?? {}), params.sessionId === undefined ? undefined : text(params.sessionId)); break;
          case 'browser.rpc': {
            const method = text(params.method) as BrowserRpcMethod;
            if (!BROWSER_RPC_METHODS.includes(method)) throw new Error('Unknown browser operation');
            const input = parseBrowserRpcParams(method, params.arguments);
            result = await (await owner.media(input.workspaceId, true)).request(method, input); break;
          }
          case 'browser.events': result = await (await owner.media(text(params.workspaceId))).events(text(params.viewId)); break;
          case 'browser.renew': result = { expiresAt: (await owner.media(text(params.workspaceId))).renew(text(params.viewId)) }; break;
          case 'browser.detach': (await owner.media(text(params.workspaceId))).detach(text(params.viewId)); result = {}; break;
          default: throw new Error('Unknown Browser Service operation');
        }
      }
      const body = JSON.stringify({ jsonrpc: '2.0', id, result });
      if (Buffer.byteLength(body) > MAX_BROWSER_MESSAGE_BYTES) throw new Error('Browser result exceeds IPC limit');
      response.end(body);
    } catch (error) {
      response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: error instanceof Error ? error.message : 'Browser Service operation failed' } }));
    } finally { inFlight--; }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxConnections = 64;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    await chmod(path, 0o600);
  } catch (error) { server.close(); throw error; }
  const socketStat = await lstat(path);
  let closing: Promise<void> | undefined;
  return {
    path,
    close() {
      return closing ??= (async () => {
        stopping = true;
        const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeIdleConnections();
        try { await stopped; await owner.close(); }
        finally { await removeOwnedSocket(path, socketStat); }
      })();
    },
  };
}
