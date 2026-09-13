import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {networkInterfaces} from 'node:os';
import type {ServerWebSocket} from 'bun';
import {Chromium} from './chromium.ts';

type Data = {id: string; role?: 'viewer' | 'extension'; tab?: string; readyGeneration?: number; peer?: string};
type Socket = ServerWebSocket<Data>;
type Tab = {id: string; target: string; session: string; generation: number; width: number; height: number; captured: boolean; owner?: string};
const build = resolve(import.meta.dir, '.build'); await mkdir(build, {recursive: true});
const token = crypto.randomUUID() + crypto.randomUUID();
const extensionToken = crypto.randomUUID() + crypto.randomUUID();
const evidence = Bun.file(resolve(build, 'host-evidence.jsonl')).writer();
const log = (event: string, detail: object = {}) => { const entry = {at: new Date().toISOString(), event, ...detail}; evidence.write(JSON.stringify(entry) + '\n'); evidence.flush(); console.log(JSON.stringify(entry)); };
const viewers = new Map<string, Socket>();
const tabs = new Map<string, Tab>();
const waiters = new Map<string, {resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
let extension: Socket | undefined, extensionId = '', workerSession = '', browser: Chromium;
let commands = Promise.resolve();
const enqueue = (fn: () => Promise<void>) => { commands = commands.then(fn).catch(error => log('operationError', {error: String(error)})); };
const send = (socket: Socket | undefined, value: object) => socket?.send(JSON.stringify(value));
const waitFor = (key: string) => new Promise<any>((resolve, reject) => {
  const timer = setTimeout(() => { waiters.delete(key); reject(new Error('Timed out: ' + key)); }, 12_000);
  waiters.set(key, {resolve, reject, timer});
});
const server = Bun.serve<Data>({
  port: Number(process.env.SPIKE_PORT ?? 9879), hostname: process.env.SPIKE_BIND ?? '0.0.0.0',
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === '/fixture') return new Response(Bun.file(resolve(import.meta.dir, 'fixture.html')), {headers: {'Content-Type': 'text/html'}});
    if (url.pathname === '/health') return Response.json({ready: tabs.size === 2, viewers: viewers.size, browser: browser?.version});
    if (url.pathname === '/control' && request.headers.get('authorization') === 'Bearer ' + token) {
      const value = await request.json() as any;
      if (value.type === 'focus' && viewers.has(value.viewer)) enqueue(() => focus(viewers.get(value.viewer)!, value));
      else if (value.type === 'navigate' && tabs.has(value.tab)) enqueue(async () => { await browser.send('Page.navigate', {url: `http://127.0.0.1:${server.port}/fixture?tab=${value.tab}&navigation=${Date.now()}`}, tabs.get(value.tab)!.session); log('navigated', {tab: value.tab}); });
      else return new Response('Unsupported control', {status: 400});
      return Response.json({queued: true});
    }
    if (url.pathname !== '/signal') return new Response('Not found', {status: 404});
    const origin = request.headers.get('origin');
    if (origin && origin !== `chrome-extension://${extensionId}`) return new Response('Origin rejected', {status: 403});
    if (server.upgrade(request, {data: {id: crypto.randomUUID()}})) return;
    return new Response('Upgrade required', {status: 426});
  },
  websocket: {
    maxPayloadLength: 128 * 1024,
    open(socket) { setTimeout(() => { if (!socket.data.role) socket.close(1008, 'Authentication timeout'); }, 5000); },
    message(socket, payload) {
      try {
        const message = JSON.parse(String(payload));
        if (!socket.data.role) {
          if (message.type !== 'hello') return socket.close(1008, 'Authenticate first');
          if (message.role === 'extension' && message.token === extensionToken && !extension) { socket.data.role = 'extension'; extension = socket; }
          else if (message.role === 'viewer' && message.token === token) { socket.data.role = 'viewer'; viewers.set(socket.data.id, socket); send(socket, {type: 'welcome', viewer: socket.data.id}); log('viewerJoined', {viewer: socket.data.id, platform: String(message.platform).slice(0,40)}); }
          else socket.close(1008, 'Unauthorized');
          return;
        }
        if (socket.data.role === 'extension') {
          if (message.type === 'captured' || message.type === 'stopped') {
            const key = `${message.type}:${message.tab}`; const waiter = waiters.get(key);
            if (waiter) { clearTimeout(waiter.timer); waiters.delete(key); waiter.resolve(message); }
            log(message.type, {tab: message.tab, generation: message.generation, tracks: message.tracks});
          } else if (message.peer && ['offer', 'ice'].includes(message.type)) {
            const viewer = [...viewers.values()].find(viewer => viewer.data.peer === message.peer);
            if (viewer) send(viewer, message);
          } else if (message.type === 'error' || message.type === 'peerState') log('extension', message);
          return;
        }
        if (message.type === 'focus') enqueue(() => focus(socket, message));
        else if (message.type === 'answer' || message.type === 'ice') {
          if (socket.data.peer && message.peer === socket.data.peer) send(extension, message);
        } else if (message.type === 'frame') {
          const tab = tabs.get(socket.data.tab ?? '');
          if (tab && socket.data.peer === message.peer && tab.generation === message.generation && message.width === tab.width && message.height === tab.height) {
            socket.data.readyGeneration = tab.generation;
            log('firstFrame', {viewer: socket.data.id, tab: tab.id, generation: tab.generation, width: message.width, height: message.height});
            send(socket, {type: 'inputReady', generation: tab.generation});
          }
        } else if (message.type === 'click') enqueue(async () => {
          const tab = tabs.get(socket.data.tab ?? '');
          if (!tab || tab.owner !== socket.data.id || socket.data.readyGeneration !== tab.generation || message.generation !== tab.generation) { log('staleInputRejected', {viewer: socket.data.id}); return; }
          if (!Number.isFinite(message.x) || !Number.isFinite(message.y) || message.x < 0 || message.y < 0 || message.x > tab.width || message.y > tab.height) return;
          await browser.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: message.x, y: message.y, button: 'left', clickCount: 1}, tab.session);
          await browser.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: message.x, y: message.y, button: 'left', clickCount: 1}, tab.session);
          const result = await browser.send('Runtime.evaluate', {expression: '({clicks, audio:typeof ac!=="undefined"?ac?.state:null})', returnByValue: true}, tab.session);
          log('clickAccepted', {tab: tab.id, generation: tab.generation, result: result.result.value});
        });
        else if (message.type === 'stats') log('nativeStats', {viewer: socket.data.id, ...message});
      } catch (error) { log('messageError', {error: String(error)}); socket.close(1008, 'Invalid message'); }
    },
    close(socket) {
      if (extension === socket) { extension = undefined; log('extensionDisconnected'); }
      if (viewers.delete(socket.data.id)) enqueue(async () => {
        send(extension, {type: 'leave', peer: socket.data.peer});
        const tab = tabs.get(socket.data.tab ?? '');
        if (tab && ![...viewers.values()].some(viewer => viewer.data.tab === tab.id)) await stop(tab);
        log('viewerLeft', {viewer: socket.data.id});
      });
    },
  },
});
async function stop(tab: Tab) {
  if (!tab.captured) return;
  const stopped = waitFor('stopped:' + tab.id); send(extension, {type: 'stop', tab: tab.id}); await stopped; tab.captured = false;
}
async function capture(tab: Tab) {
  const captured = waitFor('captured:' + tab.id);
  await browser.send('Extensions.setStorageItems', {id: extensionId, storageArea: 'session', values: {captureRequest: {tab: tab.id, generation: tab.generation, width: tab.width, height: tab.height, endpoint: `ws://127.0.0.1:${server.port}/signal`, token: extensionToken}, captureError: null}}, workerSession);
  await browser.send('Page.bringToFront', {}, tab.session);
  await browser.send('Extensions.triggerAction', {id: extensionId, targetId: tab.target});
  await captured; tab.captured = true;
}
async function peer(viewer: Socket, tab: Tab) {
  viewer.data.readyGeneration = undefined; viewer.data.peer = crypto.randomUUID();
  send(viewer, {type: 'reset', peer: viewer.data.peer, generation: tab.generation, tab: tab.id});
  send(extension, {type: 'peer', peer: viewer.data.peer, tab: tab.id, generation: tab.generation, expiresAt: Date.now() + 30000});
}
async function focus(viewer: Socket, message: any) {
  if (!tabs.has(message.tab) || !Number.isInteger(message.width) || !Number.isInteger(message.height) || message.width < 320 || message.width > 2560 || message.height < 240 || message.height > 1600) throw new Error('Invalid focus geometry');
  const previous = tabs.get(viewer.data.tab ?? '');
  send(extension, {type: 'leave', peer: viewer.data.peer});
  viewer.data.tab = message.tab;
  if (previous && previous.id !== message.tab && ![...viewers.values()].some(item => item.data.tab === previous.id)) await stop(previous);
  const tab = tabs.get(message.tab)!;
  tab.owner = viewer.data.id; tab.generation++; tab.width = message.width; tab.height = message.height;
  for (const item of viewers.values()) if (item.data.tab === tab.id) { item.data.readyGeneration = undefined; send(item, {type: 'reset', generation: tab.generation, tab: tab.id}); }
  await stop(tab);
  const {windowId} = await browser.send('Browser.getWindowForTarget', {}, tab.session);
  await browser.send('Browser.setContentsSize', {windowId, width: tab.width, height: tab.height});
  await browser.send('Emulation.setDeviceMetricsOverride', {width: tab.width, height: tab.height, deviceScaleFactor: 1, mobile: false}, tab.session);
  // Capture a compositor-produced reference before starting the new stream; native receiver is replaced.
  await browser.send('Page.captureScreenshot', {format: 'png'}, tab.session);
  await capture(tab);
  for (const item of viewers.values()) if (item.data.tab === tab.id) await peer(item, tab);
  log('focusApplied', {tab: tab.id, owner: tab.owner, generation: tab.generation, width: tab.width, height: tab.height});
}
let closing = false;
const renewal = setInterval(() => {
  for (const viewer of viewers.values()) if (viewer.data.peer) send(extension, {type: 'renew', peer: viewer.data.peer, expiresAt: Date.now() + 30000});
}, 10000);
async function shutdown(exitCode = 0) {
  if (closing) return; closing = true;
  clearInterval(renewal);
  for (const tab of tabs.values()) await stop(tab).catch(error => log('captureStopError', { tab: tab.id, error: String(error) }));
  server.stop(true);
  await browser?.close(); evidence.end(); process.exit(exitCode);
}
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
try {
  browser = await Chromium.launch();
  extensionId = (await browser.send('Extensions.loadUnpacked', {path: resolve(import.meta.dir, '../../product/portal/browser-extension')})).id;
  for (let i = 0; i < 50; i++) {
    const result = await browser.send('Target.getTargets');
    const worker = result.targetInfos.find((target: any) => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${extensionId}/`));
    if (worker) { workerSession = (await browser.send('Target.attachToTarget', {targetId: worker.targetId, flatten: true})).sessionId; break; }
    await Bun.sleep(100);
  }
  if (!workerSession) throw new Error('Extension service worker not found');
  for (const id of ['A', 'B']) {
    const url = `http://127.0.0.1:${server.port}/fixture?tab=${id}`;
    const page = await browser.send('Target.createTarget', {url, newWindow: true});
    const {sessionId} = await browser.send('Target.attachToTarget', {targetId: page.targetId, flatten: true});
    await browser.send('Runtime.enable', {}, sessionId);
    for (let i = 0; i < 50; i++) {
      const ready = await browser.send('Runtime.evaluate', {expression: 'document.readyState === "complete" && typeof tone === "function"', returnByValue: true}, sessionId);
      if (ready.result.value) break;
      if (i === 49) throw new Error('Fixture readiness timeout'); await Bun.sleep(100);
    }
    const targets = await browser.send('Target.getTargets', {filter: [{type: 'tab', exclude: false}, {exclude: true}]});
    const target = targets.targetInfos.find((target: any) => target.url === url);
    if (!target) throw new Error('Fixture tab target not found');
    tabs.set(id, {id, target: target.targetId, session: sessionId, generation: 0, width: 960, height: 640, captured: false});
  }
  const ip = process.env.SPIKE_HOST ?? Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal && !address.address.startsWith('100.'))?.address ?? '127.0.0.1';
  await writeFile(resolve(build, 'connection.json'), JSON.stringify({endpoint: `ws://${ip}:${server.port}/signal`, token}), {mode: 0o600});
  log('ready', {browser: browser.version, platform: process.platform, port: server.port, configuration: 'experiments/browser-streaming/.build/connection.json'});
} catch (error) { log('startupError', {error: String(error)}); await shutdown(1); }
