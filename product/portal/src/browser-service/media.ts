import { dirname, resolve } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import { parseBrowserNotification, type BrowserRpcMethod, type BrowserNotification, type BrowserStreamMessage, type RemoteBrowserTab } from '@weave/product-protocol';
import type { ChromiumProcess } from './chromium.ts';

export const BROWSER_VIEW_TTL_MS = 30000;
type Tab = RemoteBrowserTab & { target: string; captureTarget: string; session: string; captured: boolean; owner?: string };
type View = { id: string; tabId: string; mode: 'observe' | 'control'; expiresAt: number; peer?: string; ready?: number; events: BrowserNotification[]; wake?: () => void };
type ExtensionData = { authenticated: boolean };

/** Capture and peer lifetime belongs to the browser owner, never to Portal. */
export class BrowserMedia {
  #tabs = new Map<string, Tab>();
  #views = new Map<string, View>();
  #extension?: ServerWebSocket<ExtensionData>;
  #extensionId = '';
  #workerSession = '';
  #token = crypto.randomUUID() + crypto.randomUUID();
  #server: Server<ExtensionData>;
  #opening?: Promise<void>;
  #queue = Promise.resolve();
  #closed = false;
  #waiters = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #expiry: ReturnType<typeof setInterval>;
  constructor(readonly workspaceId: string, private browser: ChromiumProcess) {
    this.#server = Bun.serve<ExtensionData>({ hostname: '127.0.0.1', port: 0,
      fetch: (request, server) => {
        if (new URL(request.url).pathname !== '/capture' || request.headers.get('origin') !== `chrome-extension://${this.#extensionId}`) return new Response('', { status: 403 });
        if (server.upgrade(request, { data: { authenticated: false } })) return;
        return new Response('', { status: 426 });
      },
      websocket: {
        maxPayloadLength: 256 * 1024,
        open: socket => { setTimeout(() => { if (!socket.data.authenticated) socket.close(1008); }, 3000); },
        message: (socket, raw) => {
          try {
            const message = JSON.parse(String(raw));
            if (!socket.data.authenticated) {
              if (message.type !== 'hello' || message.token !== this.#token || this.#extension) { socket.close(1008); return; }
              socket.data.authenticated = true; this.#extension = socket; return;
            }
            const waiter = this.#waiters.get(message.requestId);
            if (waiter && ['captured', 'stopped'].includes(message.type)) {
              clearTimeout(waiter.timer); this.#waiters.delete(message.requestId); waiter.resolve(); return;
            }
            if (message.type === 'offer' || message.type === 'ice') {
              const view = [...this.#views.values()].find(view => view.peer === message.peer);
              if (view) this.#emit(view, message);
            }
          } catch { socket.close(1008, 'Invalid capture message'); }
        },
        close: socket => {
          if (this.#extension !== socket) return;
          this.#extension = undefined;
          for (const tab of this.#tabs.values()) tab.captured = false;
          for (const view of [...this.#views.values()]) this.detach(view.id);
          for (const waiter of this.#waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Capture extension disconnected')); }
          this.#waiters.clear();
        },
      },
    });
    this.#expiry = setInterval(() => { for (const view of this.#views.values()) if (view.expiresAt <= Date.now()) this.detach(view.id); }, 250);
  }
  #send(message: object) {
    if (!this.#extension || this.#extension.getBufferedAmount() > 256 * 1024) throw new Error('Capture extension unavailable');
    this.#extension.send(JSON.stringify(message));
  }
  #emit(view: View, message: BrowserStreamMessage) {
    if (!this.#views.has(view.id) || view.expiresAt <= Date.now()) return;
    const event = parseBrowserNotification({ workspaceId: this.workspaceId, viewId: view.id, message });
    if (view.events.length >= 128 || JSON.stringify(view.events).length + JSON.stringify(event).length > 256 * 1024) { this.detach(view.id); return; }
    view.events.push(event); view.wake?.();
  }
  async #open() {
    return this.#opening ??= (async () => {
      const path = process.execPath.endsWith('/weave-browser-service') ? resolve(dirname(process.execPath), 'browser-extension') : resolve(import.meta.dir, '../../browser-extension');
      this.#extensionId = (await this.browser.send('Extensions.loadUnpacked', { path })).id;
      for (let i = 0; i < 100; i++) {
        const { targetInfos } = await this.browser.send('Target.getTargets');
        const worker = targetInfos.find((target: any) => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${this.#extensionId}/`));
        if (worker) { this.#workerSession = (await this.browser.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })).sessionId; return; }
        await Bun.sleep(50);
      }
      throw new Error('Capture extension worker unavailable');
    })();
  }
  #ordered<Result>(operation: () => Promise<Result>) {
    const pending = this.#queue.then(() => { if (this.#closed) throw new Error('Browser media closed'); return operation(); });
    this.#queue = pending.then(() => {}, () => {}); return pending;
  }
  #tab(id: string) { const tab = this.#tabs.get(id); if (!tab) throw new Error('Browser tab unavailable'); return tab; }
  #view(id: string) { const view = this.#views.get(id); if (!view || view.expiresAt <= Date.now()) throw new Error('Browser view expired or detached'); return view; }
  #summary(tab: Tab): RemoteBrowserTab { const { tabId, workspaceId, url, title, generation, viewport } = tab; return { tabId, workspaceId, url, title, generation, viewport: { ...viewport } }; }
  #wait(requestId: string) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.#waiters.delete(requestId); reject(new Error('Capture operation timed out')); }, 10000);
      this.#waiters.set(requestId, { resolve, reject, timer });
    });
  }
  async #stop(tab: Tab) {
    if (!tab.captured) return;
    tab.captured = false;
    const requestId = crypto.randomUUID(), pending = this.#wait(requestId);
    void pending.catch(() => {});
    try { this.#send({ type: 'stop', tab: tab.tabId, requestId }); await pending; }
    catch (error) { this.#extension?.close(); throw error; }
  }
  async #capture(tab: Tab) {
    const requestId = crypto.randomUUID(), pending = this.#wait(requestId);
    // Attach a rejection handler before the CDP awaits to avoid orphaned rejections.
    void pending.catch(() => {});
    try {
    await this.browser.send('Extensions.setStorageItems', { id: this.#extensionId, storageArea: 'session', values: { captureRequest: {
      tab: tab.tabId, generation: tab.generation, ...tab.viewport, requestId,
      endpoint: `ws://127.0.0.1:${this.#server.port}/capture`, token: this.#token,
    }, captureError: null } }, this.#workerSession);
    await this.browser.send('Page.bringToFront', {}, tab.session);
    await this.browser.send('Extensions.triggerAction', { id: this.#extensionId, targetId: tab.captureTarget });
      await pending; tab.captured = true;
    } catch (error) { this.#extension?.close(); throw error; }
  }
  #peer(view: View, tab: Tab) {
    this.#view(view.id);
    view.ready = undefined; view.peer = crypto.randomUUID();
    this.#emit(view, { type: 'reset', tab: tab.tabId, peer: view.peer, generation: tab.generation });
    this.#send({ type: 'peer', peer: view.peer, tab: tab.tabId, generation: tab.generation, expiresAt: view.expiresAt });
  }
  renew(id: string) {
    const view = this.#view(id); view.expiresAt = Date.now() + BROWSER_VIEW_TTL_MS;
    if (view.peer) this.#send({ type: 'renew', peer: view.peer, expiresAt: view.expiresAt });
    return view.expiresAt;
  }
  detach(id: string) {
    const view = this.#views.get(id); if (!view) return;
    this.#views.delete(id); view.wake?.();
    if (view.peer && this.#extension) {
      try { this.#send({ type: 'leave', peer: view.peer }); }
      catch { this.#extension.close(1011, 'Capture connection fell behind'); }
    }
    const tab = this.#tabs.get(view.tabId);
    if (tab?.owner === id) tab.owner = undefined;
    if (tab && ![...this.#views.values()].some(view => view.tabId === tab.tabId)) void this.#ordered(() => this.#stop(tab)).catch(() => {});
  }
  async events(id: string) {
    const view = this.#view(id);
    if (view.wake) throw new Error('Browser event poll already active');
    if (!view.events.length) await new Promise<void>(resolve => {
      const timer = setTimeout(() => { view.wake = undefined; resolve(); }, 10000);
      view.wake = () => { clearTimeout(timer); view.wake = undefined; resolve(); };
    });
    this.#view(id); return view.events.splice(0);
  }
  request(method: BrowserRpcMethod, input: any): Promise<any> {
    if (method === 'browser.view.detach') { this.detach(input.viewId); return Promise.resolve({}); }
    if (method === 'browser.view.signal') {
      const view = this.#view(input.viewId);
      if (view.peer !== input.signal.peer) throw new Error('Stale media peer');
      this.#send(input.signal); return Promise.resolve({});
    }
    return this.#ordered(async () => {
      await this.#open();
      switch (method) {
        case 'browser.tab.list': {
          const { targetInfos } = await this.browser.send('Target.getTargets');
          for (const tab of [...this.#tabs.values()]) {
            const target = targetInfos.find((target: any) => target.targetId === tab.target);
            if (target) { tab.url = target.url; tab.title = target.title; }
            else { for (const view of [...this.#views.values()]) if (view.tabId === tab.tabId) this.detach(view.id); this.#tabs.delete(tab.tabId); }
          }
          return { tabs: [...this.#tabs.values()].map(tab => this.#summary(tab)) };
        }
        case 'browser.tab.create': {
          if (this.#tabs.size >= 64) throw new Error('Browser tab capacity exceeded');
          const tabId = crypto.randomUUID(), bootstrap = `about:blank#weave-${tabId}`;
          const { targetId } = await this.browser.send('Target.createTarget', { url: bootstrap, newWindow: true });
          try {
            const { sessionId } = await this.browser.send('Target.attachToTarget', { targetId, flatten: true });
            const { targetInfos } = await this.browser.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
            const target = targetInfos.find((target: any) => target.url === bootstrap);
            if (!target) throw new Error('Capture tab target unavailable');
            const tab: Tab = { tabId, workspaceId: this.workspaceId, url: input.url, title: '', generation: 1, viewport: { width: 960, height: 640 }, target: targetId, captureTarget: target.targetId, session: sessionId, captured: false };
            await this.browser.send('Page.navigate', { url: input.url }, sessionId);
            this.#tabs.set(tabId, tab); return { tab: this.#summary(tab) };
          } catch (error) { await this.browser.send('Target.closeTarget', { targetId }).catch(() => {}); throw error; }
        }
        case 'browser.tab.close': {
          const tab = this.#tab(input.tabId);
          for (const view of [...this.#views.values()]) if (view.tabId === tab.tabId) this.detach(view.id);
          await this.#stop(tab); await this.browser.send('Target.closeTarget', { targetId: tab.target });
          this.#tabs.delete(tab.tabId); return {};
        }
        case 'browser.tab.navigate': {
          const tab = this.#tab(input.tabId);
          const result = await this.browser.send('Page.navigate', { url: input.url }, tab.session);
          if (result.errorText) throw new Error('Browser navigation failed');
          tab.url = input.url; return { tab: this.#summary(tab) };
        }
        case 'browser.view.attach': {
          const tab = this.#tab(input.tabId);
          if (this.#views.size >= 16) throw new Error('Browser viewer capacity exceeded');
          const view: View = { id: crypto.randomUUID(), tabId: tab.tabId, mode: input.mode, expiresAt: Date.now() + BROWSER_VIEW_TTL_MS, events: [] };
          this.#views.set(view.id, view);
          try {
            if (!tab.captured) { await this.#resize(tab); await this.#capture(tab); }
            this.#peer(view, tab);
            return { grant: { viewId: view.id, workspaceId: this.workspaceId, tabId: tab.tabId, expiresAt: view.expiresAt } };
          } catch (error) { this.detach(view.id); throw error; }
        }
        case 'browser.view.focus': {
          const view = this.#view(input.viewId), tab = this.#tab(view.tabId);
          if (view.mode !== 'control') throw new Error('Browser view is read-only');
          tab.owner = view.id;
          if (tab.viewport.width === input.width && tab.viewport.height === input.height) return {};
          tab.generation++; tab.viewport = { width: input.width, height: input.height };
          for (const other of this.#views.values()) if (other.tabId === tab.tabId) {
            other.ready = undefined;
            this.#emit(other, { type: 'reset', tab: tab.tabId, generation: tab.generation });
          }
          await this.#stop(tab); await this.#resize(tab); await this.#capture(tab);
          for (const other of [...this.#views.values()]) if (other.tabId === tab.tabId && other.expiresAt > Date.now()) this.#peer(other, tab);
          if (![...this.#views.values()].some(other => other.tabId === tab.tabId)) await this.#stop(tab);
          return {};
        }
        case 'browser.view.frame': {
          const view = this.#view(input.viewId), tab = this.#tab(view.tabId);
          if (input.peer !== view.peer || input.generation !== tab.generation || input.width !== tab.viewport.width || input.height !== tab.viewport.height) throw new Error('Stale browser frame');
          view.ready = tab.generation; this.#emit(view, { type: 'inputReady', generation: tab.generation }); return {};
        }
        case 'browser.view.click': {
          const view = this.#view(input.viewId), tab = this.#tab(view.tabId);
          if (view.mode !== 'control' || tab.owner !== view.id || view.ready !== tab.generation || input.generation !== tab.generation || input.x >= tab.viewport.width || input.y >= tab.viewport.height) throw new Error('Browser input is stale or not authorized');
          await this.browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: input.x, y: input.y, button: 'left', clickCount: 1 }, tab.session);
          await this.browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: input.x, y: input.y, button: 'left', clickCount: 1 }, tab.session); return {};
        }
        default: throw new Error('Unsupported browser operation');
      }
    });
  }
  async #resize(tab: Tab) {
    const { windowId } = await this.browser.send('Browser.getWindowForTarget', {}, tab.session);
    await this.browser.send('Browser.setContentsSize', { windowId, ...tab.viewport });
    await this.browser.send('Emulation.setDeviceMetricsOverride', { ...tab.viewport, deviceScaleFactor: 1, mobile: false }, tab.session);
    await this.browser.send('Page.captureScreenshot', { format: 'png' }, tab.session);
  }
  async close() {
    clearInterval(this.#expiry);
    for (const view of [...this.#views.values()]) this.detach(view.id);
    await this.#queue;
    this.#closed = true; this.#server.stop(true);
  }
}
