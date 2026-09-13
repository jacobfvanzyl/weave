import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { Portal } from '../../product/portal/src/portal.ts';
import { startPortalServer } from '../../product/portal/src/server.ts';
import { InMemoryTerminalExecution } from '../../product/portal/src/terminals.ts';
import { BrowserServiceClient } from '../../product/portal/src/browser-service/client.ts';
import { RpcSocket, generatePortalKey } from '../../product/portal/scripts/rpc-client.ts';
import { PORTAL_PAIR_REQUEST_TYPE, BROWSER_EVENT_METHOD } from '../../product/protocol/src/index.ts';

// Disposable native receiver adapter; actual browser authorization and signaling
// traverse Portal RPC. This is not an Alpha UI or a public signaling endpoint.
type Viewer = { authenticated: boolean; rpc?: RpcSocket; viewId?: string; tabId?: string; queue: Promise<void> };
const binary = process.env.CHROME_BINARY;
if (!binary) throw new Error('Set CHROME_BINARY explicitly');
const state = await mkdtemp('/tmp/weave-browser-portal-');
const output = process.env.SPIKE_OUTPUT ?? resolve(import.meta.dir, '.build/portal'); await mkdir(output, { recursive: true });
const token = crypto.randomUUID() + crypto.randomUUID();
const log = (event: string, data: object = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
const ownerCommand = process.env.BROWSER_SERVICE_EXECUTABLE ? [process.env.BROWSER_SERVICE_EXECUTABLE] : [process.execPath, resolve(import.meta.dir, '../../product/portal/src/browser-service/main.ts')];
const owner = Bun.spawn([...ownerCommand, state, binary], { stdout: 'ignore', stderr: 'inherit' });
const service = new BrowserServiceClient(state);
for (let i = 0; ; i++) {
  try { await service.open(); break; }
  catch (error) { if (i > 100 || owner.exitCode !== null) throw error; await Bun.sleep(50); }
}
const portal = await Portal.open({
  listen: { hostname: '127.0.0.1', port: 0 }, displayName: 'Browser integration acceptance', allowedOrigins: [],
  stateDirectory: state, executionContexts: [{ executionContextId: 'fixture', name: 'Fixture', path: state }], agents: [], browser: { executable: binary },
}, { terminalBackend: new InMemoryTerminalExecution() });
const portalServer = startPortalServer(portal);
const portalUrl = `ws://127.0.0.1:${portalServer.addr.port}/rpc`;
const key = await generatePortalKey();
const paired = await portal.security.redeemPairing({ type: PORTAL_PAIR_REQUEST_TYPE, token: await portal.security.createPairingToken(), label: 'Disposable browser acceptance', publicKey: key.publicKey });
const credential = { ...key, credentialId: paired.principal.credentialId };
const admin = await RpcSocket.open(portalUrl, credential);
const hostId = portal.security.hostId;
const current = await admin.request('workspace.composition.get', { hostId }) as any;
await admin.request('workspace.composition.replace', { hostId, expectedRevision: current.composition.revision, workspaces: [{ workspaceId: 'fixture', name: 'Browser acceptance', layout: { kind: 'terminal', nodeId: 'node', paneId: 'pane', terminalId: null, executionContextId: 'fixture' } }] });
const viewers = new Set<ServerWebSocket<Viewer>>();
const tabs = new Map<string, string>();
const server = Bun.serve<Viewer>({ hostname: process.env.SPIKE_BIND ?? '127.0.0.1', port: Number(process.env.SPIKE_PORT ?? 9892),
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === '/fixture') return new Response(Bun.file(process.env.SPIKE_FIXTURE_PATH ?? resolve(import.meta.dir, 'fixture.html')), { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/health') return Response.json({ ready: tabs.size === 2, viewers: viewers.size });
    if (url.pathname !== '/signal' || request.headers.has('origin')) return new Response('', { status: 403 });
    if (server.upgrade(request, { data: { authenticated: false, queue: Promise.resolve() } })) return;
    return new Response('', { status: 426 });
  },
  websocket: {
    maxPayloadLength: 256 * 1024,
    open(socket) { setTimeout(() => { if (!socket.data.authenticated) socket.close(1008); }, 5000); },
    message(socket, raw) {
      socket.data.queue = socket.data.queue.then(async () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const message = JSON.parse(String(raw)), viewer = socket.data;
        if (!viewer.authenticated) {
          if (message.type !== 'hello' || message.token !== token) { socket.close(1008); return; }
          viewer.authenticated = true; viewer.rpc = await RpcSocket.open(portalUrl, credential); viewers.add(socket);
          if (socket.readyState !== WebSocket.OPEN) { viewer.rpc.close(); return; }
          viewer.rpc.onNotification = notification => {
            if (notification.method !== BROWSER_EVENT_METHOD) return;
            const event = notification.params as any;
            // Tab is a harness label only; media peer/generation remain service-owned.
            socket.send(JSON.stringify({ ...event.message, ...(event.message.tab ? { tab: [...tabs].find(([, id]) => id === event.message.tab)?.[0] ?? event.message.tab } : {}) }));
          };
          socket.send(JSON.stringify({ type: 'welcome' })); return;
        }
        const rpc = viewer.rpc!;
        if (message.type === 'focus') {
          const tabId = tabs.get(message.tab); if (!tabId) throw new Error('Unknown tab');
          if (viewer.tabId !== tabId) {
            if (viewer.viewId) await rpc.request('browser.view.detach', { workspaceId: 'fixture', viewId: viewer.viewId });
            const result = await rpc.request('browser.view.attach', { workspaceId: 'fixture', tabId, mode: 'control' }) as any;
            viewer.viewId = result.grant.viewId; viewer.tabId = tabId;
          }
          await rpc.request('browser.view.focus', { workspaceId: 'fixture', viewId: viewer.viewId, width: message.width, height: message.height });
        } else if (message.type === 'answer' || message.type === 'ice') {
          await rpc.request('browser.view.signal', { workspaceId: 'fixture', viewId: viewer.viewId, signal: message });
        } else if (message.type === 'frame') {
          await rpc.request('browser.view.frame', { workspaceId: 'fixture', viewId: viewer.viewId, peer: message.peer, generation: message.generation, width: message.width, height: message.height });
          log('frame', { generation: message.generation, width: message.width, height: message.height });
        } else if (message.type === 'click') {
          await rpc.request('browser.view.click', { workspaceId: 'fixture', viewId: viewer.viewId, generation: message.generation, x: message.x, y: message.y });
          log('click', { generation: message.generation });
        } else if (message.type === 'stats') log('nativeStats', message);
      }).catch(error => log('viewerError', { error: String(error) }));
    },
    close(socket) { viewers.delete(socket); socket.data.rpc?.close(); },
  },
});
for (const label of ['A', 'B']) {
  const result = await admin.request('browser.tab.create', { workspaceId: 'fixture', url: `http://127.0.0.1:${server.port}/fixture?tab=${label}` }) as any;
  tabs.set(label, result.tab.tabId);
}
await writeFile(resolve(output, 'connection.json'), JSON.stringify({ endpoint: `ws://${process.env.SPIKE_HOST ?? '127.0.0.1'}:${server.port}/signal`, token }), { mode: 0o600 });
log('ready', { platform: process.platform, port: server.port, ownerPid: owner.pid });
let closing = false;
const close = async () => {
  if (closing) return; closing = true;
  server.stop(true); admin.close();
  await portalServer.shutdown(); await portal.close(); service.dispose();
  owner.kill('SIGTERM');
  await Promise.race([owner.exited, Bun.sleep(15000)]);
  if (owner.exitCode === null) { owner.kill('SIGKILL'); throw new Error(`Retained failed fixture state: ${state}`); }
  await rm(state, { recursive: true, force: true });
};
process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
