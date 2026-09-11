import { contextBridge, ipcRenderer } from 'electron';
// Fixed terminal operations only; no Node, native window pointer, Host credential,
// arbitrary channel, or process execution capability crosses into the renderer.
const invoke = (method: string, input?: unknown) => ipcRenderer.invoke('weave:terminal', method, input);
type Stream = { port: MessagePort; sequence: number; pending: Map<number, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }> };
const streams = new Map<string, Stream>();
ipcRenderer.on('weave:terminal:stream', (event, { surfaceId }) => {
  const port = event.ports[0]; if (!port || typeof surfaceId !== 'string') return;
  const stream: Stream = { port, sequence: 0, pending: new Map() };
  streams.set(surfaceId, stream);
  port.onmessage = ({ data }) => {
    const pending = stream.pending.get(data.sequence); if (!pending) return;
    stream.pending.delete(data.sequence); clearTimeout(pending.timer);
    if (data.error) pending.reject(new Error(data.error)); else pending.resolve();
  };
  port.start();
});
const write = (input: { surfaceId: string; data: Uint8Array; reset: boolean; history?: boolean }) => {
  const stream = streams.get(input.surfaceId);
  if (!stream || !(input.data instanceof Uint8Array) || input.data.byteLength > 64 * 1024 * 1024 || stream.pending.size) return Promise.reject(new Error('Native stream is unavailable or awaiting consumption'));
  const sequence = ++stream.sequence;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { stream.pending.delete(sequence); reject(new Error('Native terminal consumption timed out')); stream.port.close(); streams.delete(input.surfaceId); }, 10000);
    stream.pending.set(sequence, { resolve, reject, timer });
    stream.port.postMessage({ sequence, input });
  });
};
const close = (input: { surfaceId: string }) => {
  const stream = streams.get(input.surfaceId);
  if (stream) { for (const pending of stream.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Native terminal closed')); } stream.port.close(); streams.delete(input.surfaceId); }
  return invoke('close', input);
};
contextBridge.exposeInMainWorld('weaveDesktop', Object.freeze({
  runtime: 'electron', platform: 'macos',
  setTopRailHeight: (height: number, overlayHeight: number) => ipcRenderer.invoke('weave:top-rail-height', height, overlayHeight),
  nativeTerminal: Object.freeze({
    create: () => invoke('create'),
    layout: (input: unknown) => invoke('layout', input),
    write,
    focus: (input: unknown) => invoke('focus', input),
    close,
    inspect: (input: unknown) => invoke('inspect', input),
    addListener: async (event: string, listener: (value: unknown) => void) => {
      if (event !== 'event' || typeof listener !== 'function') throw new Error('Invalid native event listener.');
      const receive = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value);
      ipcRenderer.on('weave:terminal:event', receive);
      return { remove: async () => { ipcRenderer.removeListener('weave:terminal:event', receive); } };
    },
  }),
}));
