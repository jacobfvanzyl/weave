/** A renderer consumes one snapshot followed by ordered live output. Resolving a
 * write acknowledges consumption, so a slow native bridge cannot grow a queue
 * without bound. A new renderer must obtain a fresh snapshot after detachment. */
export type TerminalSnapshotGrid = { cols: number; rows: number };
export type TerminalOutputSink = {
  reset(data: Uint8Array, grid?: TerminalSnapshotGrid): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  history?(data: Uint8Array): Promise<void>;
};
export type TerminalOutputSource = {
  subscribe(sink: TerminalOutputSink): () => void;
};
type Frame = { grid?: TerminalSnapshotGrid; kind: 'reset' | 'write' | 'history'; data: Uint8Array; generation: number; bytes: number; done?: (success: boolean) => void };

export class TerminalOutputStream implements TerminalOutputSource {
  readonly #resynchronize: () => void;
  readonly #limit: number;
  #queue: Frame[] = [];
  #bytes = 0;
  #snapshotBytes = 0;
  #generation = 0;
  #valid = false;
  #consumed = false;
  #consumer?: { sink: TerminalOutputSink; pumping: boolean };

  constructor(resynchronize: () => void, limitBytes = 2 * 1024 * 1024) {
    this.#resynchronize = resynchronize;
    this.#limit = limitBytes;
  }

  reset(data: Uint8Array, grid?: TerminalSnapshotGrid) {
    this.clear();
    this.#valid = true;
    this.#enqueue('reset', data, grid);
  }

  write(data: Uint8Array) {
    if (this.#valid && data) this.#enqueue('write', data);
  }

  history(data: Uint8Array): Promise<boolean> {
    if (!this.#valid) return Promise.resolve(false);
    return new Promise(resolve => this.#enqueue('history', data, undefined, resolve));
  }

  clear() {
    this.#generation++;
    for (const frame of this.#queue) frame.done?.(false);
    this.#queue = [];
    this.#bytes = 0;
    this.#snapshotBytes = 0;
    this.#valid = false;
    this.#consumed = false;
  }

  subscribe(sink: TerminalOutputSink) {
    if (this.#consumer) throw new Error('A terminal stream has only one renderer.');
    const consumer = { sink, pumping: false };
    this.#consumer = consumer;
    if (this.#consumed) this.#gap();
    else this.#pump();
    return () => {
      if (this.#consumer !== consumer) return;
      this.#consumer = undefined;
      // Once any bytes were consumed, retained tails cannot rebuild emulation.
      if (this.#consumed) {
        this.clear();
        this.#consumed = true;
      }
    };
  }

  #enqueue(kind: Frame['kind'], data: Uint8Array, grid?: TerminalSnapshotGrid, done?: (success: boolean) => void) {
    const bytes = data.byteLength;
    const overflow = kind === 'reset' ? this.#snapshotBytes + bytes > 64 * 1024 * 1024 : this.#bytes + bytes > this.#limit;
    if (this.#queue.length >= 1024 || overflow) { this.#gap(); done?.(false); return; }
    if (kind === 'reset') this.#snapshotBytes += bytes;
    else this.#bytes += bytes;
    this.#queue.push({ kind, data, bytes, grid, done, generation: this.#generation });
    this.#pump();
  }

  #gap() {
    const request = this.#valid || this.#consumed;
    this.clear();
    if (request) this.#resynchronize();
  }

  #pump() {
    const consumer = this.#consumer;
    if (!consumer || consumer.pumping) return;
    consumer.pumping = true;
    void (async () => {
      try {
        while (this.#consumer === consumer && this.#queue.length) {
          const frame = this.#queue.shift()!;
          if (frame.kind === 'write') {
            const parts = [frame.data];
            while (this.#queue[0]?.kind === 'write' && this.#queue[0].generation === frame.generation && frame.bytes + this.#queue[0].bytes <= 65536) {
              const next = this.#queue.shift()!; parts.push(next.data); frame.bytes += next.bytes;
            }
            if (parts.length > 1) { const data = new Uint8Array(frame.bytes); let offset = 0; for (const part of parts) { data.set(part, offset); offset += part.byteLength; } frame.data = data; }
          }
          this.#consumed = true;
          try {
            if (frame.kind === 'reset') await consumer.sink.reset(frame.data, frame.grid);
            else if (frame.kind === 'history') { if (!consumer.sink.history) throw new Error('Renderer cannot restore history'); await consumer.sink.history(frame.data); }
            else await consumer.sink.write(frame.data);
            frame.done?.(frame.generation === this.#generation);
          } catch {
            frame.done?.(false);
            if (this.#consumer === consumer && frame.generation === this.#generation) this.#gap();
          } finally {
            if (this.#consumer === consumer && frame.generation === this.#generation) {
              if (frame.kind === 'reset') this.#snapshotBytes -= frame.bytes;
              else this.#bytes -= frame.bytes;
            }
          }
        }
      } finally {
        consumer.pumping = false;
      }
    })();
  }
}
