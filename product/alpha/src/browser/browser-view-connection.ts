import type { BrowserPage, BrowserInputMethod } from '@weave/product-protocol';
import type { DirectHostClient } from '@/portal-client';
import { nativeBrowserBridge, type NativeBrowserBridge } from './native-browser';
import { browserDiagnostics, recordBrowserInput } from './browser-diagnostics';
type Client = Pick<DirectHostClient, 'browserRequest' | 'browserDisplay'>;
type Bounds = { x: number; y: number; width: number; height: number; visible: boolean; focused: boolean; dim: number };
type Wheel = { args: Record<string, unknown>; width: number; height: number; epoch?: number; result: Promise<void> };
const isWheel = (method: BrowserInputMethod, args: Record<string, unknown>) => method === 'Input.dispatchMouseEvent' && args.type === 'mouseWheel' && typeof args.deltaX === 'number' && Number.isFinite(args.deltaX) && typeof args.deltaY === 'number' && Number.isFinite(args.deltaY);
function compatibleWheel(wheel: Wheel, args: Record<string, unknown>) {
  // A reversal, target or modifier change is a gesture boundary. Compare all
  // non-delta fields so future input metadata cannot accidentally be ignored.
  const keys = new Set([...Object.keys(wheel.args), ...Object.keys(args)]);
  for (const key of keys) if (key !== 'deltaX' && key !== 'deltaY' && wheel.args[key] !== args[key]) return false;
  return ['deltaX', 'deltaY'].every(key => {
    const before = wheel.args[key] as number, after = args[key] as number;
    return (before === 0 || after === 0 || Math.sign(before) === Math.sign(after)) && Math.abs(before + after) <= 32768;
  });
}
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
  private wheel?: Wheel;
  private inputGeneration = 0;
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
    if (before && (before.focused !== bounds.focused || before.visible !== bounds.visible || before.width !== bounds.width || before.height !== bounds.height)) { this.wheel = undefined; this.inputGeneration++; }
    if (this.disposed) return;
    if (this.surfaceId) void this.native.layout({ surfaceId: this.surfaceId, ...bounds }).catch(cause => this.fail(cause));
    if (!this.viewId || !bounds.visible) return;
    if (bounds.focused && !before?.focused) { void this.activate(); return; }
    if (bounds.focused && this.focusEpoch && (bounds.width !== before?.width || bounds.height !== before?.height)) void this.enqueue(() => this.resize(false)).catch(cause => this.report(cause));
  }
  private report(cause: unknown) { if (!this.disposed) this.changed({ error: cause instanceof Error ? cause.message : String(cause) }); }
  private fail(cause: unknown) { this.report(cause); void this.close(); }
  private enqueue(action: () => Promise<void>) {
    this.wheel = undefined;
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
    const wheel = isWheel(method, args);
    if (wheel && this.wheel && this.wheel.epoch === this.focusEpoch && this.wheel.width === sourceSize.width && this.wheel.height === sourceSize.height && compatibleWheel(this.wheel, args)) {
      this.wheel.args.deltaX = (this.wheel.args.deltaX as number) + (args.deltaX as number);
      this.wheel.args.deltaY = (this.wheel.args.deltaY as number) + (args.deltaY as number);
      return this.wheel.result;
    }
    args = { ...args };
    const generation = this.inputGeneration;
    const timing = browserDiagnostics() ? { capturedAt: performance.timeOrigin + performance.now(), start: performance.now(), pending: this.pending } : undefined;
    const result = this.enqueue(async () => {
      if (this.wheel?.args === args) this.wheel = undefined;
      const until = Date.now() + 2500;
      while (!this.disposed && this.focusEpoch && (this.decoded.width !== this.expected.width || this.decoded.height !== this.expected.height)) {
        if (Date.now() > until) throw new Error('Waiting for the resized Browser display');
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      if (this.disposed || generation !== this.inputGeneration || !this.viewId || !this.focusEpoch || !this.bounds?.focused || !this.bounds.visible) return;
      // A focus claim can reflow the page under this pointer. The gesture
      // claims the viewport only; never click a different, newly moved target.
      if (method === 'Input.dispatchMouseEvent' && (sourceSize.width !== this.expected.width || sourceSize.height !== this.expected.height)) return;
      const dispatchAt = timing ? performance.now() : 0;
      let ok = false;
      try { await this.client.browserRequest('browser.page.view.input', { viewId: this.viewId, focusEpoch: this.focusEpoch, method, arguments: args }); ok = true; }
      catch (cause) { this.focusEpoch = undefined; throw cause; }
      finally { if (timing) recordBrowserInput({ capturedAt: timing.capturedAt, queueMs: dispatchAt - timing.start, rpcMs: performance.now() - dispatchAt, pending: timing.pending, wheel: args.type === 'mouseWheel', ok }); }
    }).catch(cause => this.report(cause));
    if (wheel) this.wheel = { args, width: sourceSize.width, height: sourceSize.height, epoch: this.focusEpoch, result };
    return result;
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
