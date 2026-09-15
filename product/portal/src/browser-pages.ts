import {
  PORTAL_BROWSER_RFB_PATH, parseBrowserPage, parseBrowserPageRpcParams,
  type BrowserPage, type BrowserPageRpcContracts, type BrowserPageRpcMethod,
} from '@weave/product-protocol';
import type { BrowserServiceClient } from './browser-service/client.ts';
import type { ManagedPageSummary } from './browser-service/managed-pages.ts';
import type { PortalPrincipal, PortalSecurity } from './security.ts';
import { browserDiagnostics, recordBrowserTiming } from './browser-diagnostics.ts';

export type ManagedPageBackend = Pick<BrowserServiceClient, 'managedPage'>;
type View = {
  viewId: string; ticket?: string; expiresAt: number; sessionId: string; principal: PortalPrincipal;
  profileId: string; pageId: string; generation: string; mode: 'observe' | 'control';
  closeStream?: () => void; bound: boolean;
};
type Focus = { viewId: string; generation: string; epoch: number; width: number; height: number; deviceScaleFactor: number };

/** Connection-scoped viewing and Profile-scoped authority, independent of RFB messages. */
export class ManagedBrowserAccess {
  #views = new Map<string, View>();
  #focus = new Map<string, Focus>();
  #queues = new Map<string, Promise<unknown>>();
  #pending = 0;
  #epoch = 0;
  #closed = false;
  #checking = false;
  #timer: ReturnType<typeof setInterval>;
  constructor(private backend: ManagedPageBackend, private security: Pick<PortalSecurity, 'authorize' | 'assertActive' | 'allows'>, private now: () => number = Date.now) {
    this.#timer = setInterval(() => void this.renew(), 5000);
    this.#timer.unref?.();
  }
  connect(principal: PortalPrincipal) {
    const sessionId = crypto.randomUUID();
    let closed = false;
    return {
      request: <M extends BrowserPageRpcMethod>(method: M, input: BrowserPageRpcContracts[M]['params']) => {
        if (closed || this.#closed) return Promise.reject(new Error('Browser connection closed'));
        return this.#request(principal, sessionId, method, input, () => !closed && !this.#closed);
      },
      close: () => { closed = true; for (const view of this.#views.values()) if (view.sessionId === sessionId) this.#detach(view); },
    };
  }
  async #authorize(principal: PortalPrincipal, profileId: string, control: boolean) {
    const start = browserDiagnostics ? performance.now() : 0;
    // authorize already reloads and validates credentials. Read-only requests
    // still need a fresh grant snapshot before selecting inspect vs control.
    if (!control) await this.security.assertActive(principal);
    const action = control || this.security.allows(principal, 'browser.profile.control', { browserProfileId: profileId }) ? 'browser.profile.control' : 'browser.profile.inspect';
    await this.security.authorize(principal, action, { browserProfileId: profileId });
    if (browserDiagnostics) recordBrowserTiming('authorize', start);
  }
  async #page(profileId: string, pageId: string, generation?: string) {
    const start = browserDiagnostics ? performance.now() : 0;
    const { pages } = await this.backend.managedPage<{ pages: ManagedPageSummary[] }>('page.list', { profileId });
    const page = pages.find(page => page.pageId === pageId && page.profileId === profileId);
    if (!page || generation !== undefined && (!page.available || page.generation !== generation)) throw new Error('Stale or unavailable browser page');
    if (browserDiagnostics) recordBrowserTiming('page', start);
    return page;
  }
  #ordered<T>(pageId: string, operation: () => Promise<T>) {
    if (this.#pending >= 64) return Promise.reject(new Error('Browser command queue full'));
    this.#pending++;
    const start = browserDiagnostics ? performance.now() : 0;
    const next = (this.#queues.get(pageId) ?? Promise.resolve()).catch(() => {}).then(() => { if (browserDiagnostics) recordBrowserTiming('queue', start); return operation(); });
    this.#queues.set(pageId, next);
    void next.finally(() => { this.#pending--; if (this.#queues.get(pageId) === next) this.#queues.delete(pageId); }).catch(() => {});
    return next;
  }
  async #request<M extends BrowserPageRpcMethod>(principal: PortalPrincipal, sessionId: string, method: M, raw: BrowserPageRpcContracts[M]['params'], active: () => boolean): Promise<BrowserPageRpcContracts[M]['result']> {
    const input = parseBrowserPageRpcParams(method, raw) as any;
    let result: unknown;
    if (input.viewId) {
      const view = this.#views.get(input.viewId);
      if (!view || view.sessionId !== sessionId) throw new Error('Browser view unavailable');
      if (!view.bound && view.expiresAt <= this.now()) { this.#detach(view); throw new Error('Browser attachment expired'); }
      if (method === 'browser.page.view.detach') { this.#detach(view); return {} as BrowserPageRpcContracts[M]['result']; }
      // Queue before asynchronous authorization so focus arrival order is retained across clients.
      result = await this.#ordered(view.pageId, async () => {
        await this.#authorize(principal, view.profileId, true);
        if (!active() || this.#views.get(view.viewId) !== view || view.mode !== 'control') throw new Error('Browser view is read-only or closed');
        await this.#page(view.profileId, view.pageId, view.generation);
        await this.#authorize(principal, view.profileId, true);
        if (!active() || this.#views.get(view.viewId) !== view) throw new Error('Browser view closed');
        const focus = this.#focus.get(view.pageId);
        if (method !== 'browser.page.view.focus' && (!focus || focus.viewId !== view.viewId || focus.epoch !== input.focusEpoch || focus.generation !== view.generation)) throw new Error('Browser view no longer owns the viewport');
        if (method === 'browser.page.view.input') {
          const start = browserDiagnostics ? performance.now() : 0;
          await this.backend.managedPage('page.cdp', { pageId: view.pageId, generation: view.generation, arguments: { method: input.method, arguments: input.arguments, nativeInput: true, inputEpoch: `${view.viewId}:${focus!.epoch}` } });
          if (browserDiagnostics) recordBrowserTiming('cdp', start);
          return {};
        }
        // A resize failure makes input ownership uncertain; clear it before requesting the transition.
        this.#focus.delete(view.pageId);
        await this.backend.managedPage('page.resize', { pageId: view.pageId, generation: view.generation, arguments: { width: input.width, height: input.height, deviceScaleFactor: input.deviceScaleFactor ?? 1 } });
        await this.#authorize(principal, view.profileId, true);
        if (!active() || this.#views.get(view.viewId) !== view) throw new Error('Browser view closed during focus');
        const next = { viewId: view.viewId, generation: view.generation, epoch: ++this.#epoch, width: input.width, height: input.height, deviceScaleFactor: input.deviceScaleFactor ?? 1 };
        this.#focus.set(view.pageId, next);
        return { viewId: next.viewId, generation: next.generation, focusEpoch: next.epoch, width: next.width, height: next.height, deviceScaleFactor: next.deviceScaleFactor };
      });
    } else {
      const control = !['browser.page.list', 'browser.page.get'].includes(method) && !(method === 'browser.page.view.attach' && input.mode === 'observe');
      await this.#authorize(principal, input.profileId, control);
      if (!active()) throw new Error('Browser connection closed');
      if (method === 'browser.page.list') {
        const list = await this.backend.managedPage<{ pages: ManagedPageSummary[] }>('page.list', { profileId: input.profileId });
        result = { pages: list.pages.filter(page => page.profileId === input.profileId).map(parseBrowserPage) };
      } else {
        const page = await this.#page(input.profileId, input.pageId, input.generation);
        if (!active()) throw new Error('Browser connection closed');
        if (method === 'browser.page.get') result = { page: parseBrowserPage(page) };
        else if (method === 'browser.page.view.attach') {
          if (this.#views.size >= 64 || [...this.#views.values()].filter(view => view.sessionId === sessionId).length >= 16) throw new Error('Browser view capacity exceeded');
          await this.#authorize(principal, input.profileId, control);
          if (!active()) throw new Error('Browser connection closed');
          const view: View = { viewId: crypto.randomUUID(), ticket: crypto.randomUUID(), expiresAt: this.now() + 30000, sessionId, principal, profileId: page.profileId, pageId: page.pageId, generation: input.generation, mode: input.mode, bound: false };
          this.#views.set(view.viewId, view);
          result = { viewId: view.viewId, ticket: view.ticket, expiresAt: view.expiresAt, path: PORTAL_BROWSER_RFB_PATH };
        } else {
          result = await this.#ordered(page.pageId, async () => {
            await this.#authorize(principal, page.profileId, true);
            if (!active()) throw new Error('Browser connection closed');
            await this.backend.managedPage<ManagedPageSummary>(method.replace('browser.', ''), { pageId: page.pageId, generation: input.generation, arguments: method === 'browser.page.navigate' ? { url: input.url } : {} });
            return { page: parseBrowserPage(await this.#page(page.profileId, page.pageId)) };
          });
        }
      }
      try {
        await this.#authorize(principal, input.profileId, control);
        if (!active()) throw new Error('Browser connection closed');
      } catch (error) {
        if (method === 'browser.page.view.attach') {
          const view = this.#views.get((result as { viewId: string }).viewId);
          if (view) this.#detach(view);
        }
        throw error;
      }
    }
    return result as BrowserPageRpcContracts[M]['result'];
  }
  async bind(principal: PortalPrincipal, ticket: string, close: () => void) {
    const view = [...this.#views.values()].find(view => view.ticket === ticket);
    if (!view || view.bound || view.expiresAt <= this.now() || view.principal.credentialId !== principal.credentialId || view.principal.principalId !== principal.principalId) throw new Error('Browser attachment unavailable');
    // Consume before any await. A ticket can bind exactly one transport.
    view.ticket = undefined; view.bound = true; view.closeStream = close;
    try {
      await this.#authorize(principal, view.profileId, view.mode === 'control');
      const page = await this.#page(view.profileId, view.pageId, view.generation);
      await this.#authorize(principal, view.profileId, view.mode === 'control');
      if (this.#closed || this.#views.get(view.viewId) !== view || !page.rfbSocket) throw new Error('Browser attachment closed');
      return { path: page.rfbSocket, active: () => !this.#closed && this.#views.get(view.viewId) === view, close: () => this.#detach(view) };
    } catch (error) { this.#detach(view); throw error; }
  }
  #detach(view: View) {
    if (this.#views.get(view.viewId) !== view) return;
    this.#views.delete(view.viewId);
    if (this.#focus.get(view.pageId)?.viewId === view.viewId) this.#focus.delete(view.pageId);
    try { view.closeStream?.(); } catch { /* Grant removal must complete even if a transport fails to close. */ }
  }
  async renew() {
    if (this.#checking || this.#closed) return;
    this.#checking = true;
    try {
      await Promise.all([...this.#views.values()].map(view => new Promise<void>(resolve => {
        let finished = false;
        const done = () => { if (finished) return; finished = true; clearTimeout(timeout); resolve(); };
        // A stalled private service must not postpone permission checks indefinitely.
        const timeout = setTimeout(() => { this.#detach(view); done(); }, 2000);
        void (async () => {
          if (!view.bound && view.expiresAt <= this.now()) throw new Error('Unbound browser view expired');
          await this.#authorize(view.principal, view.profileId, view.mode === 'control');
          await this.#page(view.profileId, view.pageId, view.generation);
        })().then(done, () => { this.#detach(view); done(); });
      })));
    } finally { this.#checking = false; }
  }
  close() { this.#closed = true; clearInterval(this.#timer); for (const view of this.#views.values()) this.#detach(view); }
}
export type ManagedBrowserSession = ReturnType<ManagedBrowserAccess['connect']>;
