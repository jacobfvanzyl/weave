import type { BrowserRpcContracts, BrowserRpcMethod, BrowserNotification, BrowserViewGrant } from '@weave/product-protocol';
import type { BrowserServiceClient } from './browser-service/client.ts';

export type BrowserBackend = Pick<BrowserServiceClient, 'browser' | 'events' | 'renew' | 'detach' | 'dispose'> & Partial<Pick<BrowserServiceClient, 'profile' | 'managedPage' | 'managedPagesEnabled'>>;
type Grant = BrowserViewGrant & { mode: 'observe' | 'control' };
export type BrowserAuthorization = (workspaceId: string, control: boolean) => Promise<void>;

export class BrowserAccess {
  #sessions = new Set<BrowserSession>();
  constructor(private backend: BrowserBackend) {}
  connect(authorize: BrowserAuthorization, send: (event: BrowserNotification) => unknown) {
    const session = new BrowserSession(this.backend, authorize, send, () => this.#sessions.delete(session));
    this.#sessions.add(session); return session;
  }
  async close() { await Promise.all([...this.#sessions].map(session => session.close())); this.backend.dispose(); }
}

/** A grant belongs to one authenticated Portal connection, not a client-supplied ID. */
export class BrowserSession {
  #grants = new Map<string, Grant>();
  #closed = false;
  #renewing = false;
  #timer: ReturnType<typeof setInterval>;
  constructor(private backend: BrowserBackend, private authorize: BrowserAuthorization, private send: (event: BrowserNotification) => unknown, private onClose: () => void) {
    this.#timer = setInterval(() => void this.renew(), 10000);
  }
  async request<M extends BrowserRpcMethod>(method: M, params: BrowserRpcContracts[M]['params']): Promise<BrowserRpcContracts[M]['result']> {
    if (this.#closed) throw new Error('Browser connection closed');
    const input = params as { workspaceId: string; viewId?: string; mode?: 'observe' | 'control' };
    const grant = input.viewId ? this.#grants.get(input.viewId) : undefined;
    if (input.viewId && (!grant || grant.workspaceId !== input.workspaceId)) throw new Error('Browser view unavailable');
    const control = method === 'browser.tab.create' || method === 'browser.tab.close' || method === 'browser.tab.navigate' || method === 'browser.view.focus' || method === 'browser.view.click' || method === 'browser.view.attach' && input.mode === 'control';
    if (control && grant && grant.mode !== 'control') throw new Error('Browser view is read-only');
    await this.authorize(input.workspaceId, control);
    if (this.#closed) throw new Error('Browser connection closed');
    if (method === 'browser.view.detach') {
      this.#grants.delete(input.viewId!);
      await this.backend.detach(input.workspaceId, input.viewId!);
      return {} as BrowserRpcContracts[M]['result'];
    }
    const result = await this.backend.browser(method, params);
    if (method === 'browser.view.attach') {
      const attached = (result as { grant: BrowserViewGrant }).grant;
      if (this.#closed) { await this.backend.detach(attached.workspaceId, attached.viewId); throw new Error('Browser connection closed during attachment'); }
      // Authorization may have changed while Chromium was starting capture.
      try { await this.authorize(input.workspaceId, control); }
      catch (error) { await this.backend.detach(attached.workspaceId, attached.viewId); throw error; }
      if (this.#closed) { await this.backend.detach(attached.workspaceId, attached.viewId); throw new Error('Browser connection closed during attachment'); }
      const grant: Grant = { ...attached, mode: input.mode! };
      this.#grants.set(grant.viewId, grant);
      void this.#events(grant);
    }
    return result;
  }
  async #events(grant: Grant) {
    try {
      while (!this.#closed && this.#grants.get(grant.viewId) === grant) {
        const events = await this.backend.events(grant.workspaceId, grant.viewId);
        if (this.#closed || this.#grants.get(grant.viewId) !== grant) return;
        await this.authorize(grant.workspaceId, grant.mode === 'control');
        for (const event of events) {
          if (event.workspaceId !== grant.workspaceId || event.viewId !== grant.viewId) throw new Error('Browser event address mismatch');
          if (this.send(event) === false) throw new Error('Browser signaling fell behind');
        }
      }
    } catch { await this.#revoke(grant); }
  }
  async renew() {
    if (this.#closed || this.#renewing) return;
    this.#renewing = true;
    try {
      await Promise.all([...this.#grants.values()].map(async grant => {
        try {
          await this.authorize(grant.workspaceId, grant.mode === 'control');
          if (this.#closed || this.#grants.get(grant.viewId) !== grant) return;
          grant.expiresAt = (await this.backend.renew(grant.workspaceId, grant.viewId)).expiresAt;
        } catch { await this.#revoke(grant); }
      }));
    } finally { this.#renewing = false; }
  }
  async #revoke(grant: Grant) {
    if (!this.#grants.delete(grant.viewId)) return;
    try { if (!this.#closed) this.send({ workspaceId: grant.workspaceId, viewId: grant.viewId, message: { type: 'revoked', reason: 'Browser viewing permission ended; reconnect to request a new view.' } }); } catch {}
    await this.backend.detach(grant.workspaceId, grant.viewId).catch(() => {});
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true; clearInterval(this.#timer); this.onClose();
    const grants = [...this.#grants.values()];
    this.#grants.clear();
    await Promise.all(grants.map(grant => this.backend.detach(grant.workspaceId, grant.viewId).catch(() => {})));
  }
}
