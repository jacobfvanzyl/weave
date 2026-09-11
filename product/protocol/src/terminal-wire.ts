/** Versioned binary payloads over the authenticated Host WebSocket. Control
 * remains JSON; terminal state is never decoded as UTF-8. One payload per frame. */
export const TERMINAL_CODEC = 'libghostty-vt:4a70ee4718ba0967bcfd72f43adb715bf65a860d:weave-1';
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const maximum = 64 * 1024 * 1024;
export function encodeHostMessage(message: unknown): string | Uint8Array<ArrayBuffer> {
  let payload: Uint8Array | undefined;
  const json = JSON.stringify(message, (_key, value) => {
    // Buffer.toJSON runs before replacers; callers pass Uint8Array across this
    // shared boundary, never Node's Buffer JSON representation.
    if (value instanceof Uint8Array) {
      if (payload) throw new Error('Multiple terminal payloads in one frame');
      payload = value; return { terminalBytes: value.byteLength };
    }
    return value;
  });
  if (!payload) return json;
  const metadata = encoder.encode(json);
  if (metadata.byteLength > 65536 || payload.byteLength > maximum) throw new Error('Terminal frame too large');
  const bytes = new Uint8Array(12 + metadata.byteLength + payload.byteLength);
  bytes.set([0x57,0x56,0x54,1], 0);
  const view = new DataView(bytes.buffer); view.setUint32(4, metadata.byteLength); view.setUint32(8, payload.byteLength);
  bytes.set(metadata, 12); bytes.set(payload, 12 + metadata.byteLength); return bytes;
}
export function decodeHostMessage(data: string | ArrayBuffer | Uint8Array): unknown {
  if (typeof data === 'string') return JSON.parse(data);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 12 || bytes[0] !== 0x57 || bytes[1] !== 0x56 || bytes[2] !== 0x54 || bytes[3] !== 1) throw new Error('Invalid terminal binary frame');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metadataSize = view.getUint32(4), size = view.getUint32(8);
  if (metadataSize > 65536 || size > maximum || bytes.byteLength !== 12 + metadataSize + size) throw new Error('Invalid terminal binary frame length');
  let used = false;
  const result = JSON.parse(decoder.decode(bytes.subarray(12, 12 + metadataSize)), (_key, value) => {
    if (value && typeof value === 'object' && 'terminalBytes' in value) {
      if (used || Object.keys(value).length !== 1 || value.terminalBytes !== size) throw new Error('Invalid terminal payload reference');
      used = true; return bytes.subarray(12 + metadataSize);
    }
    return value;
  });
  if (!used) throw new Error('Missing terminal payload reference'); return result;
}
export const terminalBytes = (value: unknown, limit = maximum): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.byteLength > limit) throw new Error('Terminal data must be bounded bytes');
  return value;
};
