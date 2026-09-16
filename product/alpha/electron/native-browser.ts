import { app, clipboard, ipcMain, type BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
type Addon = { capture(id: number): Buffer; create(parent: Buffer, event: (json: string) => void): number; connect(id: number, url: string): void; control(id: number, json: string): void; layout(id: number, x: number, y: number, width: number, height: number, visible: boolean, dim: number): void; close(id: number): void };
export function installNativeBrowsers(window: BrowserWindow) {
  const addon = createRequire(import.meta.url)(join(app.getAppPath(), 'weave-browser.node')) as Addon;
  const contents = window.webContents, surfaces = new Map<string, number>();
  const clear = () => { for (const id of surfaces.values()) addon.close(id); surfaces.clear(); };
  const handler = (event: Electron.IpcMainInvokeEvent, method: string, input?: Record<string, unknown>) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame || !event.senderFrame.url.startsWith('weave://app/')) throw new Error('Browser caller is unavailable');
    if (method === 'create') {
      if (surfaces.size >= 16) throw new Error('Browser display capacity reached');
      const surfaceId = randomUUID();
      const id = addon.create(window.getNativeWindowHandle(), json => { if (!contents.isDestroyed() && surfaces.has(surfaceId)) contents.send('weave:browser:event', { ...JSON.parse(json), surfaceId }); });
      surfaces.set(surfaceId, id); return { surfaceId };
    }
    const id = typeof input?.surfaceId === 'string' ? surfaces.get(input.surfaceId) : undefined;
    if (id === undefined) { if (method === 'close') return; throw new Error('Browser surface is unavailable'); }
    if (method === 'clipboard') {
      if (input?.text === undefined) return clipboard.readText().then(text => ({text}));
      if (typeof input.text !== 'string' || input.text.length > 32768) throw new Error('Invalid Browser clipboard text');
      return clipboard.writeText(input.text).then(() => ({}));
    }
    if (method === 'close') { addon.close(id); surfaces.delete(input!.surfaceId as string); return; }
    if (method === 'connect' || method === 'control') {
      const value = input?.[method === 'connect' ? 'url' : 'json'];
      if (typeof value !== 'string') throw new Error('Invalid Browser request');
      addon[method](id, value); return;
    }
    if (method === 'layout') {
      const values = ['x','y','width','height','dim'].map(key => input![key]);
      if (values.some(value => typeof value !== 'number' || !Number.isFinite(value)) || typeof input?.visible !== 'boolean') throw new Error('Invalid Browser geometry');
      const [x,y,w,h,dim] = values as number[], zoom = contents.getZoomFactor();
      addon.layout(id,x!*zoom,y!*zoom,w!*zoom,h!*zoom,input.visible,dim!); return;
    }
    throw new Error('Unknown Browser operation');
  };
  ipcMain.handle('weave:browser', handler);
  contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) clear(); });
  window.on('closed', () => { clear(); ipcMain.removeHandler('weave:browser'); });
  return { capture: () => { const id = surfaces.values().next().value; if (id === undefined) throw new Error('No Browser display to capture'); return addon.capture(id); } };
}
