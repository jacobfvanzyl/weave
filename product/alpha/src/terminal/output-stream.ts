/** A renderer consumes one snapshot followed by ordered live output. Resolving a
 * write acknowledges consumption, so a slow native bridge cannot grow a queue
 * without bound. A new renderer must obtain a fresh snapshot after detachment. */
export type TerminalSnapshotGrid = { cols: number; rows: number };
export type TerminalOutputSink = {
  reset(data: string, grid?: TerminalSnapshotGrid): Promise<void>;
  write(data: string): Promise<void>;
};
export type TerminalOutputSource = {
  subscribe(sink: TerminalOutputSink): () => void;
};
type Frame = { grid?: TerminalSnapshotGrid; kind: 'reset' | 'write'; data: string; generation: number; bytes: number };
const encoder = new TextEncoder();

export class TerminalOutputStream implements TerminalOutputSource {
  readonly #resynchronize: () => void;
  readonly #limit: number;
  #queue: Frame[] = [];
  #bytes = 0;
  #generation = 0;
  #valid = false;
  #consumed = false;
  #consumer?: { sink: TerminalOutputSink; pumping: boolean };

  constructor(resynchronize: () => void, limitBytes = 2 * 1024 * 1024) {
    this.#resynchronize = resynchronize;
    this.#limit = limitBytes;
  }

  reset(data: string, grid?: TerminalSnapshotGrid) {
    this.clear();
    this.#valid = true;
    this.#enqueue('reset', data, grid);
  }

  write(data: string) {
    if (this.#valid && data) this.#enqueue('write', data);
  }

  clear() {
    this.#generation++;
    this.#queue = [];
    this.#bytes = 0;
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
        this.#queue = [];
        this.#bytes = 0;
      }
    };
  }

  #enqueue(kind: Frame['kind'], data: string, grid?: TerminalSnapshotGrid) {
    const bytes = encoder.encode(data).byteLength;
    if (this.#queue.length >= 1024 || this.#bytes + bytes > this.#limit) { this.#gap(); return; }
    this.#bytes += bytes;
    this.#queue.push({ kind, data, bytes, grid, generation: this.#generation });
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
          this.#consumed = true;
          try {
            if (frame.kind === 'reset' && frame.grid) await consumer.sink.reset(frame.data, frame.grid);
            else await consumer.sink[frame.kind](frame.data);
          } catch {
            if (this.#consumer === consumer && frame.generation === this.#generation) this.#gap();
          } finally {
            if (this.#consumer === consumer && frame.generation === this.#generation) this.#bytes -= frame.bytes;
          }
        }
      } finally {
        consumer.pumping = false;
      }
    })();
  }
}
