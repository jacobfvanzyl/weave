import type { BrowserPage, BrowserInputMethod } from '@weave/product-protocol';
import type { DirectHostClient } from '@/portal-client';
import { nativeBrowserBridge, type NativeBrowserBridge } from './native-browser';
type Client = Pick<DirectHostClient, 'browserRequest' | 'browserDisplay'>;
type Bounds = { x: number; y: number; width: number; height: number; visible: boolean; focused: boolean; dim: number };
/** One native display lease. Losing it never closes the Host-owned page. */
export class BrowserViewConnection {
  private surfaceId?: string;
  private viewId?: string;
  private removeListener?: () => Promise<void>;
  private disposed = false;
  private focusEpoch?: number;
  private decoded = { width: 0, height: 0 };
  private expected = { width: 0, height: 0 };
  private bounds?: Bounds;
  private queue = Promise.resolve();
  private pending = 0;
  constructor(private client: Client, private page: BrowserPage, private changed: (event: { width?: number; height?: number; error?: string }) => void, private native: NativeBrowserBridge = nativeBrowserBridge) {}
  async start() {
    try {
      const { surfaceId } = await this.native.create(); this.surfaceId = surfaceId;
      if (this.disposed) { await this.native.close({ surfaceId }); return; }
      const display = this.client.browserDisplay();
      let ticket = '', authenticated = false;
      const listener = await this.native.addListener('event', event => {
        if (this.disposed || event.surfaceId !== surfaceId) return;
        if (event.kind === 'frame') {
          this.decoded = { width: event.width ?? 0, height: event.height ?? 0 };
          this.changed(this.decoded); return;
        }
        if (event.kind === 'error') { this.fail(event.message); return; }
        if (event.kind === 'control') void (async () => {
          if ((event.message as { type?: string })?.type === 'weave.portal.auth.challenge') {
            if (authenticated) throw new Error('Unexpected Browser authentication challenge');
            const response = await display.authorize(event.message);
            if (!this.disposed) await this.native.control({ surfaceId, json: JSON.stringify(response) });
          } else {
            display.authenticated(event.message); authenticated = true;
            if (!this.disposed) await this.native.control({ surfaceId, json: JSON.stringify({ type: 'browser.rfb.bind', ticket }) });
          }
        })().catch(cause => this.fail(cause));
      });
      this.removeListener = () => listener.remove();
      if (this.disposed) { await listener.remove(); return; }
      const attachment = await this.client.browserRequest('browser.page.view.attach', { profileId: this.page.profileId, pageId: this.page.pageId, generation: this.page.generation!, mode: 'control' });
      this.viewId = attachment.viewId; ticket = attachment.ticket;
      if (this.disposed) { await this.client.browserRequest('browser.page.view.detach', { viewId: attachment.viewId }); return; }
      await this.native.connect({ surfaceId, url: display.url });
      if (this.bounds) { await this.native.layout({ surfaceId, ...this.bounds }); if (this.bounds.focused) void this.activate(); }
    } catch (cause) { this.fail(cause); }
  }
  layout(bounds: Bounds) {
    const before = this.bounds; this.bounds = bounds;
    if (this.disposed) return;
    if (this.surfaceId) void this.native.layout({ surfaceId: this.surfaceId, ...bounds }).catch(cause => this.fail(cause));
    if (!this.viewId || !bounds.visible) return;
    if (bounds.focused && !before?.focused) { void this.activate(); return; }
    if (bounds.focused && this.focusEpoch && (bounds.width !== before?.width || bounds.height !== before?.height)) void this.enqueue(() => this.resize(false)).catch(cause => this.report(cause));
  }
  private report(cause: unknown) { if (!this.disposed) this.changed({ error: cause instanceof Error ? cause.message : String(cause) }); }
  private fail(cause: unknown) { this.report(cause); void this.close(); }
  private enqueue(action: () => Promise<void>) {
    if (this.disposed) return Promise.reject(new Error('Browser display is unavailable'));
    if (this.pending >= 64) return Promise.reject(new Error('Browser input fell behind; activate the Pane again'));
    this.pending++;
    const next = this.queue.catch(() => {}).then(async () => { if (!this.disposed) await action(); }).finally(() => { this.pending--; });
    this.queue = next; return next;
  }
  private async resize(claim: boolean) {
    if (!this.viewId || !this.bounds?.visible || !this.bounds.focused) return;
    const width = Math.max(1, Math.min(4096, Math.floor(this.bounds.width))), height = Math.max(1, Math.min(4096, Math.floor(8_000_000 / width), Math.floor(this.bounds.height)));
    const oldEpoch = this.focusEpoch; this.focusEpoch = undefined;
    try {
      if (!claim && !oldEpoch) return;
      const result = claim
        ? await this.client.browserRequest('browser.page.view.focus', { viewId: this.viewId, width, height })
        : await this.client.browserRequest('browser.page.view.resize', { viewId: this.viewId, width, height, focusEpoch: oldEpoch! });
      if (this.disposed) return;
      this.expected = { width: result.width, height: result.height }; this.focusEpoch = result.focusEpoch;
    } catch (cause) { this.focusEpoch = undefined; throw cause; }
  }
  activate() { if (this.bounds) this.bounds.focused = true; return this.enqueue(() => this.resize(true)).catch(cause => this.report(cause)); }
  input(method: BrowserInputMethod, args: Record<string, unknown>) {
    const sourceSize = { ...this.decoded };
    return this.enqueue(async () => {
      const until = Date.now() + 2500;
      while (!this.disposed && this.focusEpoch && (this.decoded.width !== this.expected.width || this.decoded.height !== this.expected.height)) {
        if (Date.now() > until) throw new Error('Waiting for the resized Browser display');
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      if (this.disposed || !this.viewId || !this.focusEpoch || !this.bounds?.focused || !this.bounds.visible) return;
      // A focus claim can reflow the page under this pointer. The gesture
      // claims the viewport only; never click a different, newly moved target.
      if (method === 'Input.dispatchMouseEvent' && (sourceSize.width !== this.expected.width || sourceSize.height !== this.expected.height)) return;
      try { await this.client.browserRequest('browser.page.view.input', { viewId: this.viewId, focusEpoch: this.focusEpoch, method, arguments: args }); }
      catch (cause) { this.focusEpoch = undefined; throw cause; }
    }).catch(cause => this.report(cause));
  }
  async close() {
    if (this.disposed) return; this.disposed = true;
    await Promise.allSettled([
      this.surfaceId ? this.native.close({ surfaceId: this.surfaceId }) : Promise.resolve(),
      this.viewId ? this.client.browserRequest('browser.page.view.detach', { viewId: this.viewId }) : Promise.resolve(),
      this.removeListener?.(),
    ]);
  }
}
