import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';

export const TERMINAL_SERVICE_VERSION = 1;
export { TERMINAL_CODEC } from '@weave/product-protocol';
export const MAX_SERVICE_FRAME = 64 * 1024 * 1024;
export const MAX_STREAM_BYTES = 2 * 1024 * 1024;
export function serviceDirectory(stateDirectory: string) {
  const id = createHash('sha256').update(stateDirectory).digest('hex').slice(0, 24);
  return join(tmpdir(), `weave-terminal-${process.getuid!()}-${id}`);
}
export type ServiceRecord = {
  terminalId: string; executionContextId: string; initialDirectory: string; currentDirectory: string;
  title: string; processName: string; cols: number; rows: number; pid: number; status: 'running';
};
export type ServiceHeader = Record<string, unknown>;
// A bounded envelope for local control and opaque binary state/output. TCP and
// Unix sockets may split anywhere; no terminal bytes are interpreted here.
export function encodeServiceFrame(header: ServiceHeader, payload: Buffer = Buffer.alloc(0)): Buffer {
  const metadata = Buffer.from(JSON.stringify(header));
  if (metadata.length > 16384 || metadata.length + payload.length + 4 > MAX_SERVICE_FRAME) throw new Error('Terminal frame exceeds limit');
  const frame = Buffer.allocUnsafe(8 + metadata.length + payload.length);
  frame.writeUInt32BE(frame.length - 4, 0); frame.writeUInt32BE(metadata.length, 4);
  metadata.copy(frame, 8); payload.copy(frame, 8 + metadata.length); return frame;
}
export class ServiceFrameReader {
  #frame = Buffer.allocUnsafe(4);
  #received = 0;
  receive(data: Buffer, accept: (header: ServiceHeader, payload: Buffer) => void) {
    let offset = 0;
    while (offset < data.length) {
      const count = Math.min(this.#frame.length - this.#received, data.length - offset);
      data.copy(this.#frame, this.#received, offset, offset + count);
      this.#received += count; offset += count;
      if (this.#received !== this.#frame.length) continue;
      if (this.#frame.length === 4) {
        const size = this.#frame.readUInt32BE(0);
        if (size < 6 || size > MAX_SERVICE_FRAME) throw new Error('Invalid terminal frame length');
        // Allocate once after validating the prefix. In particular, a large
        // snapshot split across socket reads must not repeatedly copy its tail.
        const frame = Buffer.allocUnsafe(size + 4); this.#frame.copy(frame);
        this.#frame = frame;
        continue;
      }
      const frame = this.#frame, size = frame.length - 4;
      const metadataSize = frame.readUInt32BE(4);
      if (metadataSize > 16384 || metadataSize > size - 4) throw new Error('Invalid terminal frame metadata');
      const header: unknown = JSON.parse(frame.subarray(8, 8 + metadataSize).toString('utf8'));
      if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('Invalid terminal frame header');
      this.#frame = Buffer.allocUnsafe(4); this.#received = 0;
      accept(header as ServiceHeader, frame.subarray(8 + metadataSize));
    }
  }
}
