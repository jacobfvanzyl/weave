import { app, ipcMain, type BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
type Addon = { prepare(parent: Buffer): void; adopt(parent: Buffer, token: string, event: (value: string) => void, key?: string): number; create(parent: Buffer, address: string, event: (value: string) => void, key?: string): number; layout(id: number, x: number, y: number, w: number, h: number, visible: boolean, blocked: boolean): void; snapshot(id: number): string; focus(id: number): void; command(id: number, action: string, address: string): void; close(id: number): void };
export function installClientBrowser(window: BrowserWindow) {
  const addon = createRequire(import.meta.url)(join(app.getAppPath(), 'weave-client-browser.node')) as Addon;
  addon.prepare(window.getNativeWindowHandle());
  const surfaces = new Map<string, { id: number; paneKey?: string }>();
  const contents = window.webContents;
  const clear = () => { for (const { id } of surfaces.values()) addon.close(id); surfaces.clear(); };
  ipcMain.handle('weave:client-browser', (event, method: string, input: Record<string, unknown> = {}) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame || !event.senderFrame.url.startsWith('weave://app/')) throw new Error('Invalid Client Browser caller');
    if (method === 'list') return { panes: [...surfaces].flatMap(([surfaceId, entry]) => entry.paneKey ? [{ surfaceId, paneKey: entry.paneKey }] : []) };
    if (method === 'create' || method === 'adopt') {
      const paneKey = input.paneKey;
      if (paneKey !== undefined && (typeof paneKey !== 'string' || !paneKey || paneKey.length > 1024)) throw new Error('Invalid Client Browser pane key');
      if (paneKey) {
        const existing = [...surfaces].find(([, entry]) => entry.paneKey === paneKey);
        if (existing) return { surfaceId: existing[0] };
      }
      if (surfaces.size >= 128) throw new Error('Too many Client Browser surfaces');
      if (method === 'adopt' && (typeof input.popupToken !== 'string' || input.popupToken.length > 128)) throw new Error('Invalid popup token');
      if (method === 'create' && (typeof input.address !== 'string' || input.address.length > 16384 || (input.address !== 'about:blank' && !['http:', 'https:'].includes(new URL(input.address).protocol)))) throw new Error('Invalid Client Browser address');
      const surfaceId = randomUUID();
      const callback = (json: string) => {
        if (!surfaces.has(surfaceId) || contents.isDestroyed()) return;
        const value = JSON.parse(json);
        // DOM focus alone cannot transfer AppKit's first responder out of
        // WebKit. Restore the Electron view before focusing its address input.
        if (value.kind === 'focus-address') contents.focus();
        contents.send('weave:client-browser:event', { ...value, surfaceId });
      };
      const args = [window.getNativeWindowHandle(), (method === 'adopt' ? input.popupToken : input.address) as string, callback] as const;
      const id = paneKey ? addon[method](...args, paneKey as string) : addon[method](...args);
      surfaces.set(surfaceId, { id, ...(paneKey ? { paneKey: paneKey as string } : {}) }); return { surfaceId };
    }
    const entry = typeof input.surfaceId === 'string' ? surfaces.get(input.surfaceId) : undefined;
    if (!entry) { if (method === 'close' || (method === 'layout' && input.visible === false)) return; if (method === 'snapshot') return { closed: true, pageIdentity: '', url: '', title: '', loading: false, width: 0, height: 0, hidden: true, error: '', renderer: 'SwiftUI/WKWebView' }; throw new Error('Missing Client Browser surface'); }
    const { id } = entry;
    if (method === 'close') { addon.close(id); surfaces.delete(input.surfaceId as string); return; }
    if (method === 'snapshot') return JSON.parse(addon.snapshot(id));
    if (method === 'focus') { addon.focus(id); return; }
    if (method === 'command') {
      if (typeof input.action !== 'string' || !['navigate', 'back', 'forward', 'reload', 'stop'].includes(input.action)) throw new Error('Invalid Client Browser command');
      if (input.action === 'navigate' && (typeof input.address !== 'string' || input.address.length > 16384 || (input.address !== 'about:blank' && !['http:', 'https:'].includes(new URL(input.address).protocol)))) throw new Error('Invalid Client Browser address');
      addon.command(id, input.action, input.action === 'navigate' ? input.address as string : ''); return;
    }
    if (method !== 'layout') throw new Error('Invalid Client Browser operation');
    const { x, y, width, height, visible, blocked } = input;
    if ([x, y, width, height].some(n => typeof n !== 'number' || !Number.isFinite(n)) || typeof visible !== 'boolean' || typeof blocked !== 'boolean') throw new Error('Invalid Client Browser geometry');
    const zoom = contents.getZoomFactor();
    addon.layout(id, Number(x) * zoom, Number(y) * zoom, Number(width) * zoom, Number(height) * zoom, visible, blocked);
  });
  contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (!mainFrame || inPlace) return;
    for (const [surfaceId, { id, paneKey }] of surfaces) {
      if (paneKey) addon.layout(id, 0, 0, 0, 0, false, true);
      else { addon.close(id); surfaces.delete(surfaceId); }
    }
  });
  window.once('closed', () => { clear(); ipcMain.removeHandler('weave:client-browser'); });
}
