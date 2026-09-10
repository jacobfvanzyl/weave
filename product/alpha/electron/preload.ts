import { contextBridge, ipcRenderer } from 'electron';
// Fixed terminal operations only; no Node, native window pointer, Host credential,
// arbitrary channel, or process execution capability crosses into the renderer.
const invoke = (method: string, input?: unknown) => ipcRenderer.invoke('weave:terminal', method, input);
contextBridge.exposeInMainWorld('weaveDesktop', Object.freeze({
  runtime: 'electron', platform: 'macos',
  nativeTerminal: Object.freeze({
    create: () => invoke('create'),
    layout: (input: unknown) => invoke('layout', input),
    write: (input: unknown) => invoke('write', input),
    focus: (input: unknown) => invoke('focus', input),
    close: (input: unknown) => invoke('close', input),
    inspect: (input: unknown) => invoke('inspect', input),
    addListener: async (event: string, listener: (value: unknown) => void) => {
      if (event !== 'event' || typeof listener !== 'function') throw new Error('Invalid native event listener.');
      const receive = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value);
      ipcRenderer.on('weave:terminal:event', receive);
      return { remove: async () => { ipcRenderer.removeListener('weave:terminal:event', receive); } };
    },
  }),
}));
