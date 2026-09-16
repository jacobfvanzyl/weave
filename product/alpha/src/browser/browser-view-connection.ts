import { browserFramebufferSize, browserViewportScale, type BrowserContext, type BrowserPage, type BrowserInputMethod } from '@weave/product-protocol';
import type { DirectHostClient } from '@/portal-client';
import { nativeBrowserBridge, type NativeBrowserBridge } from './native-browser';
import { browserDiagnostics, recordBrowserInput } from './browser-diagnostics';
type Client = Pick<DirectHostClient, 'browserRequest' | 'browserDisplay'>;
type Bounds = { x: number; y: number; width: number; height: number; deviceScaleFactor?: number; visible: boolean; focused: boolean; inputBlocked?: boolean; dim: number };
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
  private hover?: { args: Record<string, unknown>; result: Promise<void> };
  private inputGeneration = 0;
  constructor(private client: Client, private page: BrowserPage, private changed: (event: { width?: number; height?: number; diagnosticId?: string; error?: string }) => void, private native: NativeBrowserBridge = nativeBrowserBridge) {}
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
          this.changed({ ...this.decoded, diagnosticId:event.diagnosticId }); return;
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
    if (before && (before.deviceScaleFactor !== bounds.deviceScaleFactor || before.inputBlocked !== bounds.inputBlocked || before.focused !== bounds.focused || before.visible !== bounds.visible || before.width !== bounds.width || before.height !== bounds.height)) { this.wheel = undefined; this.hover = undefined; this.inputGeneration++; }
    if (this.disposed) return;
    if (this.surfaceId) void this.native.layout({ surfaceId: this.surfaceId, ...bounds }).catch(cause => this.fail(cause));
    if (!this.viewId || !bounds.visible) return;
    if (bounds.focused && (!before?.focused || (before.inputBlocked && !bounds.inputBlocked && !this.focusEpoch))) { void this.activate(); return; }
    // Queue layout changes even while a claim/resize temporarily clears its epoch.
    // The queued resize uses the acknowledged epoch after that request completes.
    if (bounds.focused && (bounds.width !== before?.width || bounds.height !== before?.height || bounds.deviceScaleFactor !== before?.deviceScaleFactor)) void this.enqueue(() => this.resize(false)).catch(cause => this.report(cause));
  }
  private report(cause: unknown) { if (!this.disposed) this.changed({ error: cause instanceof Error ? cause.message : String(cause) }); }
  private fail(cause: unknown) { this.report(cause); void this.close(); }
  private enqueue(action: () => Promise<void>) {
    this.wheel = undefined; this.hover = undefined;
    if (this.disposed) return Promise.reject(new Error('Browser display is unavailable'));
    if (this.pending >= 64) return Promise.reject(new Error('Browser input fell behind; activate the Pane again'));
    this.pending++;
    const next = this.queue.catch(() => {}).then(async () => { if (!this.disposed) await action(); }).finally(() => { this.pending--; });
    this.queue = next; return next;
  }
  private async resize(claim: boolean) {
    if (!this.viewId || !this.bounds?.visible || !this.bounds.focused) return;
    const width = Math.max(1, Math.min(4096, Math.floor(this.bounds.width))), height = Math.max(1, Math.min(4096, Math.floor(8_000_000 / width), Math.floor(this.bounds.height)));
    const deviceScaleFactor = browserViewportScale(width, height, this.bounds.deviceScaleFactor ?? 1);
    const oldEpoch = this.focusEpoch; this.focusEpoch = undefined;
    try {
      if (!claim && !oldEpoch) return;
      const result = claim
        ? await this.client.browserRequest('browser.page.view.focus', { viewId: this.viewId, width, height, deviceScaleFactor })
        : await this.client.browserRequest('browser.page.view.resize', { viewId: this.viewId, width, height, deviceScaleFactor, focusEpoch: oldEpoch! });
      if (this.disposed) return;
      this.expected = browserFramebufferSize(result); this.focusEpoch = result.focusEpoch;
    } catch (cause) { this.focusEpoch = undefined; throw cause; }
  }
  ensureActive() { return this.bounds?.focused && this.focusEpoch ? Promise.resolve() : this.activate(); }
  activate() { if (this.bounds?.inputBlocked) return Promise.resolve(); if (this.bounds) this.bounds.focused = true; return this.enqueue(() => this.resize(true)).catch(cause => this.report(cause)); }
  input(method: BrowserInputMethod, args: Record<string, unknown>) {
    if (this.bounds?.inputBlocked) return Promise.resolve();
    const hover = method === 'Input.dispatchMouseEvent' && args.type === 'mouseMoved' && !args.buttons && !args.mouseLeave;
    if (hover && this.hover) { Object.assign(this.hover.args, args); return this.hover.result; }
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
      if (this.hover?.args === args) this.hover = undefined;
      const until = Date.now() + 2500;
      while (!this.disposed && generation === this.inputGeneration && this.focusEpoch && (this.decoded.width !== this.expected.width || this.decoded.height !== this.expected.height)) {
        if (Date.now() > until) throw new Error('Waiting for the resized Browser display');
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      if (this.disposed || generation !== this.inputGeneration || !this.viewId || !this.focusEpoch || !this.bounds?.focused || !this.bounds.visible || this.bounds.inputBlocked) return;
      // A focus claim can reflow the page under this pointer. The gesture
      // claims the viewport only; never click a different, newly moved target.
      if (method === 'Input.dispatchMouseEvent' && (sourceSize.width !== this.expected.width || sourceSize.height !== this.expected.height)) return;
      const dispatchAt = timing ? performance.now() : 0;
      let ok = false;
      try { await this.client.browserRequest('browser.page.view.input', { viewId: this.viewId, focusEpoch: this.focusEpoch, method, arguments: args }); ok = true; }
      catch (cause) { this.focusEpoch = undefined; throw cause; }
      finally { if (timing) recordBrowserInput({ capturedAt: timing.capturedAt, queueMs: dispatchAt - timing.start, rpcMs: performance.now() - dispatchAt, pending: timing.pending, wheel: args.type === 'mouseWheel', ok }); }
    }).catch(cause => this.report(cause));
    if (hover) this.hover = { args, result };
    if (wheel) this.wheel = { args, width: sourceSize.width, height: sourceSize.height, epoch: this.focusEpoch, result };
    return result;
  }
  async context(x:number,y:number):Promise<BrowserContext|undefined> {
    const sourceSize={...this.decoded}, generation=this.inputGeneration;
    await this.ensureActive();
    if(sourceSize.width!==this.expected.width || sourceSize.height!==this.expected.height)return;
    let result:BrowserContext|undefined;
    await this.enqueue(async()=>{
      if(generation!==this.inputGeneration || !this.viewId || !this.focusEpoch || !this.bounds?.focused || !this.bounds.visible || this.bounds.inputBlocked || this.disposed)return;
      const epoch=this.focusEpoch;
      const context=await this.client.browserRequest('browser.page.view.context',{viewId:this.viewId,focusEpoch:this.focusEpoch,x:Math.floor(x),y:Math.floor(y)});
      if(!this.disposed && generation===this.inputGeneration && epoch===this.focusEpoch)result=context;
    });
    return result;
  }
  async clipboard(text?: string) {
    if (!this.surfaceId || this.disposed) throw new Error('Browser display is unavailable');
    return this.native.clipboard({ surfaceId:this.surfaceId, ...(text === undefined ? {} : {text}) });
  }
  async interaction(waitForInput = false) {
    const inputGeneration = this.inputGeneration;
    // Explicit clipboard actions wait for an already queued focus/input claim.
    // Cursor polling stays independent so it cannot stall human input.
    if (waitForInput) await this.queue;
    if (inputGeneration !== this.inputGeneration) return;
    if (!this.viewId || !this.focusEpoch || !this.bounds?.focused || !this.bounds.visible || this.bounds.inputBlocked || this.disposed) return;
    const generation = this.inputGeneration, epoch = this.focusEpoch;
    const result = await this.client.browserRequest('browser.page.view.interaction', { viewId:this.viewId, focusEpoch:epoch });
    if (!this.disposed && generation === this.inputGeneration && epoch === this.focusEpoch) return result;
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
