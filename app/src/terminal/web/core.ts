// libghostty-vt in WebAssembly (WVE-205, ADR 0032): the Mac's page keeps a replica of each
// terminal's screen in it, as the iPad's native renderer does in the same library, and reads it
// back a frame at a time to draw. `wasm/terminal.c` is the other side: the struct offsets here
// are its `Frame` and `Cell`. The module has no imports; one instance serves every terminal on
// the page.

/** Ghostty's modifiers. */
export const MODS = { shift: 1, control: 2, option: 4, command: 8 } as const;

/** What a cell's flags say (`terminal.c`). */
export const CELL = {
  bold: 1,
  italic: 2,
  underline: 4,
  strike: 8,
  invisible: 16,
  /** The second half of a wide character: nothing of its own to draw. */
  spacer: 32,
  wide: 64,
  selected: 128,
  link: 256,
} as const;

/** `Uint32`s a cell: codepoint, foreground, background, flags with a cluster's length above them, and where the cluster's text is. */
export const CELL_WORDS = 5;

export const CURSOR = { bar: 0, block: 1, underline: 2, hollow: 3 } as const;

/**
 * The screen as it is: every row's cells, with the rows that changed since the frame before
 * marked. Its arrays are views of the module's memory, good only until the next call on any
 * terminal: a call that grows the memory leaves them empty.
 */
export type Frame = {
  columns: number;
  rows: number;
  cursor: { x: number; y: number; visible: boolean; style: number; color: number };
  /** 0xRRGGBB. */
  background: number;
  foreground: number;
  /** Whether the program asked for the mouse. */
  mouse: boolean;
  /** Whether the program is on the alternate screen, as an editor is: it has no scrollback. */
  alternate: boolean;
  /** The scrollback, in rows: all there is, the first on screen, and how many are. */
  scroll: { total: number; offset: number; length: number };
  cells: Uint32Array;
  dirty: Uint8Array;
  wrapped: Uint8Array;
  /** Whether anything to draw changed. */
  changed: boolean;
  /** What the cell at `index` shows: its codepoint, or its cluster of several. */
  text(index: number): string;
};

type Exports = {
  memory: WebAssembly.Memory;
  wt_alloc(length: number): number;
  wt_free(pointer: number, length: number): void;
  wt_snapshot_version(): number;
  wt_new(columns: number, rows: number, cellWidth: number, cellHeight: number): number;
  wt_close(terminal: number): void;
  wt_reset(terminal: number, columns: number, rows: number): number;
  wt_restore(terminal: number, snapshot: number, length: number): number;
  wt_write(terminal: number, output: number, length: number): void;
  wt_resize(terminal: number, columns: number, rows: number, cellWidth: number, cellHeight: number): number;
  wt_frame(terminal: number): number;
  wt_scroll(terminal: number, lines: number): void;
  wt_scroll_bottom(terminal: number): void;
  wt_out(terminal: number): number;
  wt_key(terminal: number, name: number, nameLength: number, text: number, textLength: number, mods: number, action: number, unshifted: number): number;
  wt_mouse(terminal: number, x: number, y: number, button: number, action: number, mods: number, pressed: number): number;
  wt_paste(terminal: number, text: number, length: number): number;
  wt_select(terminal: number, type: number, x: number, y: number, px: number, py: number, ms: number, rectangle: number, height: number): number;
  wt_select_clear(terminal: number): void;
  wt_selection(terminal: number): number;
  wt_link(terminal: number, x: number, y: number): number;
  wt_snapshot(terminal: number): number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One codepoint's string, kept: a screen draws the same few thousands of times. */
const glyphs = new Map<number, string>();
const glyph = (codepoint: number) => {
  let text = glyphs.get(codepoint);
  if (text === undefined) {
    try {
      text = String.fromCodePoint(codepoint);
    } catch {
      text = '�';
    }
    if (glyphs.size > 8192) glyphs.clear();
    glyphs.set(codepoint, text);
  }
  return text;
};

/** The module, instantiated: every terminal on the page is in its memory. */
export class Ghostty {
  readonly #exports: Exports;
  /** Bytes the page hands a call: grown to the largest yet. */
  #scratch = 0;
  #scratchLength = 0;

  private constructor(exports: Exports) {
    this.#exports = exports;
  }

  static async load(module: BufferSource | Response | Promise<Response>): Promise<Ghostty> {
    const source = await module;
    if (!(source instanceof Response)) {
      const made = await WebAssembly.instantiate(source as ArrayBuffer, {});
      return new Ghostty(made.instance.exports as unknown as Exports);
    }
    if (!source.ok) throw new Error(`The terminal's module didn't load (${source.status}).`);
    // A web view that serves the module as something other than WebAssembly can't stream it.
    const whole = source.clone();
    const { instance } = await WebAssembly.instantiateStreaming(source, {})
      .catch(async () => WebAssembly.instantiate(await whole.arrayBuffer(), {}));
    return new Ghostty(instance.exports as unknown as Exports);
  }

  /** The codec of this build's snapshots, as a holder of the same Ghostty names its own (ADR 0022). */
  codec(commit: string): string {
    return `ghostty ${commit} snapshot ${this.#exports.wt_snapshot_version()}`;
  }

  /** A blank terminal, or none if the module is out of memory. */
  terminal(size: { columns: number; rows: number }, cell: { width: number; height: number }): TerminalCore | undefined {
    const pointer = this.#exports.wt_new(size.columns, size.rows, Math.ceil(cell.width), Math.ceil(cell.height));
    return pointer ? new TerminalCore(this, this.#exports, pointer) : undefined;
  }

  /** `bytes` in the module's memory, for one call. */
  give(bytes: Uint8Array): number {
    if (bytes.length > this.#scratchLength) {
      if (this.#scratch) this.#exports.wt_free(this.#scratch, this.#scratchLength);
      this.#scratchLength = Math.max(4096, bytes.length * 2);
      this.#scratch = this.#exports.wt_alloc(this.#scratchLength);
      if (!this.#scratch) {
        this.#scratchLength = 0;
        throw new Error('The terminal is out of memory.');
      }
    }
    new Uint8Array(this.#exports.memory.buffer, this.#scratch, bytes.length).set(bytes);
    return this.#scratch;
  }
}

/** A key, as a `KeyboardEvent` has it. */
export type Key = {
  /** The key's place on the keyboard: `KeyboardEvent.code`. */
  code: string;
  /** What it types in the keyboard's layout, when it types something. */
  text?: string;
  /** `MODS`, added up. */
  mods: number;
  action?: 'press' | 'release' | 'repeat';
};

const ACTIONS = { release: 0, press: 1, repeat: 2 } as const;

/** One terminal's screen in the module. */
export class TerminalCore {
  readonly #ghostty: Ghostty;
  readonly #exports: Exports;
  #pointer: number;

  constructor(ghostty: Ghostty, exports: Exports, pointer: number) {
    this.#ghostty = ghostty;
    this.#exports = exports;
    this.#pointer = pointer;
  }

  /** Frees the screen: the terminal runs on in its holder. */
  close() {
    if (this.#pointer) this.#exports.wt_close(this.#pointer);
    this.#pointer = 0;
  }

  get closed() {
    return this.#pointer === 0;
  }

  /** A blank screen of this size, as before a restore that's VT. */
  reset(size: { columns: number; rows: number }): boolean {
    return this.#exports.wt_reset(this.#pointer, size.columns, size.rows) !== 0;
  }

  /** The holder's snapshot as the screen, history and all; false if it doesn't decode, and the screen stays. */
  restore(snapshot: Uint8Array): boolean {
    return this.#exports.wt_restore(this.#pointer, this.#ghostty.give(snapshot), snapshot.length) !== 0;
  }

  write(output: Uint8Array) {
    if (output.length === 0) return;
    this.#exports.wt_write(this.#pointer, this.#ghostty.give(output), output.length);
  }

  resize(size: { columns: number; rows: number }, cell: { width: number; height: number }): boolean {
    return this.#exports.wt_resize(this.#pointer, size.columns, size.rows, Math.ceil(cell.width), Math.ceil(cell.height)) !== 0;
  }

  frame(): Frame | undefined {
    const at = this.#exports.wt_frame(this.#pointer);
    if (!at) return undefined;
    const buffer = this.#exports.memory.buffer;
    const head = new Uint32Array(buffer, at, 20);
    const columns = head[0] ?? 0;
    const rows = head[1] ?? 0;
    const cells = new Uint32Array(buffer, head[13], columns * rows * CELL_WORDS);
    const stride = head[17] ?? 0;
    const text = head[16] ?? 0;
    return {
      columns,
      rows,
      cursor: { x: head[2] ?? 0, y: head[3] ?? 0, visible: head[4] !== 0, style: head[5] ?? 0, color: head[6] ?? 0 },
      background: head[7] ?? 0,
      foreground: head[8] ?? 0,
      mouse: head[9] !== 0,
      alternate: head[19] !== 0,
      scroll: { total: head[10] ?? 0, offset: head[11] ?? 0, length: head[12] ?? 0 },
      cells,
      dirty: new Uint8Array(buffer, head[14], rows),
      wrapped: new Uint8Array(buffer, head[15], rows),
      changed: head[18] !== 0,
      text(index) {
        const base = index * CELL_WORDS;
        const length = (cells[base + 3] ?? 0) >>> 16;
        if (length > 0) {
          const row = Math.floor(index / columns);
          return decoder.decode(new Uint8Array(buffer, text + row * stride + (cells[base + 4] ?? 0), length));
        }
        const codepoint = cells[base] ?? 0;
        return codepoint ? glyph(codepoint) : '';
      },
    };
  }

  /** Scrolls back (negative) or forward. */
  scroll(lines: number) {
    if (lines) this.#exports.wt_scroll(this.#pointer, Math.trunc(lines));
  }

  scrollToBottom() {
    this.#exports.wt_scroll_bottom(this.#pointer);
  }

  #out(length: number): Uint8Array | undefined {
    if (length < 0) return undefined;
    return new Uint8Array(this.#exports.memory.buffer, this.#exports.wt_out(this.#pointer), length).slice();
  }

  /** A key as the bytes the program expects in the modes it's in; none for a key that types nothing there. */
  key(key: Key): Uint8Array | undefined {
    const name = encoder.encode(key.code);
    const text = encoder.encode(key.text ?? '');
    const both = new Uint8Array(name.length + text.length);
    both.set(name);
    both.set(text, name.length);
    const at = this.#ghostty.give(both);
    const typed = key.text ?? '';
    const unshifted = [...typed].length === 1 ? typed.toLowerCase().codePointAt(0) ?? 0 : 0;
    return this.#out(this.#exports.wt_key(this.#pointer, at, name.length, at + name.length, text.length, key.mods, ACTIONS[key.action ?? 'press'], unshifted));
  }

  /**
   * The mouse at a cell, for a program that asked for it: none when it didn't. `button` is 0
   * for none, 1 left, 2 right, 3 middle, 4 and 5 the wheel up and down.
   */
  mouse(event: { x: number; y: number; button: number; action: 'press' | 'release' | 'motion'; mods: number; pressed: boolean }): Uint8Array | undefined {
    const action = event.action === 'press' ? 0 : event.action === 'release' ? 1 : 2;
    return this.#out(this.#exports.wt_mouse(this.#pointer, event.x, event.y, event.button, action, event.mods, event.pressed ? 1 : 0));
  }

  /** Pasted text as the program takes it, bracketed if it asked. */
  paste(text: string): Uint8Array | undefined {
    const bytes = encoder.encode(text);
    return this.#out(this.#exports.wt_paste(this.#pointer, this.#ghostty.give(bytes), bytes.length));
  }

  /**
   * The pointer selecting text, at a cell on screen and a place in pixels. A second press in
   * place selects the word, a third the line. Whether there's a selection now.
   */
  select(type: 'press' | 'release' | 'drag', at: { x: number; y: number; px: number; py: number }, options: { ms: number; rectangle?: boolean; height?: number }): boolean {
    const kind = type === 'press' ? 0 : type === 'release' ? 1 : 2;
    return this.#exports.wt_select(this.#pointer, kind, Math.max(0, at.x), Math.max(0, at.y), at.px, at.py, options.ms, options.rectangle ? 1 : 0, Math.ceil(options.height ?? 0)) !== 0;
  }

  clearSelection() {
    this.#exports.wt_select_clear(this.#pointer);
  }

  /** The selected text, as copying takes it. */
  selection(): string | undefined {
    const bytes = this.#out(this.#exports.wt_selection(this.#pointer));
    return bytes && bytes.length > 0 ? decoder.decode(bytes) : undefined;
  }

  /** The address the cell links to (OSC 8), if it does. */
  link(x: number, y: number): string | undefined {
    const length = this.#exports.wt_link(this.#pointer, x, y);
    return length > 0 ? decoder.decode(this.#out(length)) : undefined;
  }

  /** The screen as a holder's snapshot of it would be: for tests. */
  snapshot(): Uint8Array {
    return this.#out(this.#exports.wt_snapshot(this.#pointer)) ?? new Uint8Array();
  }
}

/** The rows on screen as text, a line each, trailing spaces gone: what tests and link-finding read. */
export const screenText = (frame: Frame): string[] => {
  const lines: string[] = [];
  for (let y = 0; y < frame.rows; y++) {
    let line = '';
    for (let x = 0; x < frame.columns; x++) {
      const index = y * frame.columns + x;
      if ((frame.cells[index * CELL_WORDS + 3] ?? 0) & CELL.spacer) continue;
      line += frame.text(index) || ' ';
    }
    lines.push(line.trimEnd());
  }
  return lines;
};
