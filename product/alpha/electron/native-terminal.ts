import { app, ipcMain, type BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

declare const ALPHA_ACCEPTANCE: boolean;
const channel = 'weave:terminal';
type Addon = {
  create(parent: Buffer, event: (json: string) => void): number;
  layout(id: number, x: number, y: number, width: number, height: number, visible: boolean, readOnly: boolean): { cols: number; rows: number };
  write(id: number, bytes: Buffer, reset: boolean, cols: number, rows: number): void;
  focus(id: number): void;
  inspect(id: number): string;
  close(id: number): void;
  acceptance?(action: string, value: string): Buffer | undefined;
};
/** A window owns view capabilities. The renderer never receives a native pointer,
 * Node handle, process identity, or general-purpose IPC channel. */
export function installNativeTerminals(window: BrowserWindow) {
  const addon = createRequire(import.meta.url)(join(app.getAppPath(), 'weave-terminal.node')) as Addon;
  const surfaces = new Map<string, number>();
  const contents = window.webContents;
  const clear = () => { for (const id of surfaces.values()) addon.close(id); surfaces.clear(); };
  const handler = (event: Electron.IpcMainInvokeEvent, method: unknown, input: unknown) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame || !event.senderFrame.url.startsWith('weave://app/')) throw new Error('Native terminal caller is unavailable.');
    if (method === 'create') {
      if (surfaces.size >= 64) throw new Error('Native terminal surface limit reached.');
      const surfaceId = randomUUID();
      const id = addon.create(window.getNativeWindowHandle(), (json) => {
        if (!contents.isDestroyed() && surfaces.has(surfaceId)) contents.send(`${channel}:event`, { ...JSON.parse(json), surfaceId });
      });
      surfaces.set(surfaceId, id);
      return { surfaceId, renderer: 'libghostty-vt-coretext' };
    }
    if (!input || typeof input !== 'object') throw new Error('Invalid terminal request.');
    const value = input as Record<string, unknown>;
    const id = typeof value.surfaceId === 'string' ? surfaces.get(value.surfaceId) : undefined;
    if (id === undefined) {
      if (method === 'close') return;
      throw new Error('Native terminal surface is unavailable.');
    }
    switch (method) {
      case 'layout': {
        const { x, y, width, height, visible, readOnly } = value;
        if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100000) || typeof visible !== 'boolean' || typeof readOnly !== 'boolean') throw new Error('Invalid terminal geometry.');
        const zoom = contents.getZoomFactor();
        return addon.layout(id, (x as number) * zoom, (y as number) * zoom, (width as number) * zoom, (height as number) * zoom, visible, readOnly);
      }
      case 'write': {
        if (typeof value.data !== 'string' || value.data.length > 3 * 1024 * 1024 || typeof value.reset !== 'boolean') throw new Error('Invalid terminal output.');
        const bytes = Buffer.from(value.data, 'base64');
        if (bytes.toString('base64') !== value.data) throw new Error('Invalid terminal output encoding.');
        const cols = value.cols ?? 0, rows = value.rows ?? 0;
        if (!(cols === 0 && rows === 0) && (!value.reset || !Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 2 || (cols as number) > 500 || (rows as number) < 2 || (rows as number) > 300)) throw new Error('Invalid terminal snapshot grid.');
        addon.write(id, bytes, value.reset, cols as number, rows as number); return;
      }
      case 'focus': addon.focus(id); return;
      case 'inspect': {
        if (!ALPHA_ACCEPTANCE) throw new Error('Native terminal inspection is unavailable.');
        return { text: addon.inspect(id), renderer: 'libghostty-vt-coretext' };
      }
      case 'close': addon.close(id); surfaces.delete(value.surfaceId as string); return;
      default: throw new Error('Unknown terminal operation.');
    }
  };
  ipcMain.handle(channel, handler);
  contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) clear(); });
  contents.on('render-process-gone', clear);
  window.once('closed', () => { clear(); ipcMain.removeHandler(channel); });
  return { acceptance: (action: string, value = '') => {
    if (!ALPHA_ACCEPTANCE || !addon.acceptance) throw new Error('Native acceptance is unavailable.');
    return addon.acceptance(action, value);
  } };
}
