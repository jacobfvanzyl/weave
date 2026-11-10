// A terminal drawn in the page (WVE-205, ADR 0032): a canvas the screen in WebAssembly
// (`core.ts`) is painted on, and the keyboard, mouse and clipboard that go with it. It's the
// Mac's counterpart of the iPad's native view (`ios/App/App/TerminalView.swift` and
// `WeaveTerminalRenderer.mm`), with the same font, colors and padding. It knows nothing of the
// stream: what the person types comes out as bytes (`input`), and what the terminal says goes in
// (`restore`, `write`, `resized`).
import type { TerminalSize } from '@/host/protocol';
import { CELL, CELL_WORDS, CURSOR, type Frame, type Ghostty, type TerminalCore } from './core';
import { keyFor } from './keys';
import { addressAt, opens } from './links';
import type { Restore } from './stream';

const PADDING = 8;
/** Catppuccin Mocha's surface2, behind selected text. */
const SELECTION = 0x585b70;
/** Lines a wheel may send a program at once. */
const WHEEL_LINES = 12;

export type ViewOptions = {
  fontSize: number;
  /** The font family the terminal's faces were loaded as. */
  family: string;
  /** Bytes for the terminal's program. */
  input(bytes: Uint8Array): void;
  /** The grid that fits the view changed. */
  fit(size: TerminalSize): void;
  /** A link the person ⌘-clicked. */
  open(address: string): void;
  /** Hears output arrive and frames drawn: the terminal check's measurements. */
  probe?: Probe;
};

export type Probe = {
  /** Output of this many bytes went into the screen. */
  written(bytes: number): void;
  /** The canvas shows the screen as it is now. */
  drawn(): void;
};

const css = (color: number) => `#${color.toString(16).padStart(6, '0')}`;

type Metrics = { width: number; height: number; ascent: number };

const measure = (family: string, size: number): Metrics => {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return { width: size * 0.6, height: Math.ceil(size * 1.3), ascent: Math.ceil(size) };
  context.font = `${size}px ${family}`;
  const measured = context.measureText('M');
  const ascent = Math.ceil(measured.fontBoundingBoxAscent || size);
  return {
    width: measured.width || size * 0.6,
    height: Math.ceil(ascent + (measured.fontBoundingBoxDescent || size * 0.25) + 2),
    ascent,
  };
};

export class TerminalView {
  readonly #host: HTMLElement;
  readonly #options: ViewOptions;
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D | null;
  /** Takes the keyboard: composed text, pastes and copies arrive here. */
  readonly #field: HTMLTextAreaElement;
  readonly #core: TerminalCore;
  readonly #observer: ResizeObserver;
  readonly #stop = new AbortController();
  #fontSize: number;
  #metrics: Metrics;
  #fits: TerminalSize = { cols: 80, rows: 24 };
  #frame: number | undefined;
  #full = true;
  #focused = false;
  #disposed = false;
  /** What the last frame said the program is doing with the mouse and the screen. */
  #modes = { mouse: false, alternate: false };
  #cursorRow = -1;
  #wheel = 0;
  /** The mouse button held over the terminal, and whether it's the program's or a selection's. */
  #held: { button: number; program: boolean } | undefined;
  #selected = false;

  constructor(host: HTMLElement, ghostty: Ghostty, options: ViewOptions) {
    this.#host = host;
    this.#options = options;
    this.#fontSize = options.fontSize;
    this.#metrics = measure(options.family, options.fontSize);
    this.#canvas = document.createElement('canvas');
    this.#canvas.setAttribute('aria-hidden', 'true');
    this.#canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:text';
    this.#context = this.#canvas.getContext('2d', { alpha: false });
    this.#field = document.createElement('textarea');
    this.#field.setAttribute('aria-label', 'Terminal input');
    this.#field.setAttribute('autocapitalize', 'off');
    this.#field.setAttribute('autocorrect', 'off');
    this.#field.setAttribute('autocomplete', 'off');
    this.#field.spellcheck = false;
    this.#field.dataset.slot = 'terminal-input';
    this.#field.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1em;padding:0;border:0;margin:0;opacity:0;resize:none;outline:none;overflow:hidden;white-space:pre;caret-color:transparent;pointer-events:none';
    host.append(this.#canvas, this.#field);
    this.#fits = this.#fit();
    const core = ghostty.terminal({ columns: this.#fits.cols, rows: this.#fits.rows }, this.#metrics);
    if (!core) throw new Error('The terminal is out of memory.');
    this.#core = core;
    this.#observer = new ResizeObserver(() => this.#laidOut());
    this.#observer.observe(host);
    this.#listen();
    this.#laidOut();
  }

  /** The grid that fits the view now. */
  get fits(): TerminalSize {
    return this.#fits;
  }

  get fontSize() {
    return this.#fontSize;
  }

  /** The screen in place of what's drawn: false when a snapshot doesn't decode, and the screen stays. */
  restore(restore: Restore): boolean {
    if (this.#disposed) return false;
    if (restore.kind === 'snapshot') {
      if (!this.#core.restore(restore.bytes)) return false;
    } else {
      if (!this.#core.reset({ columns: restore.size.cols, rows: restore.size.rows })) return false;
      this.#core.write(restore.bytes);
    }
    this.#selected = false;
    this.#full = true;
    this.#invalidate();
    return true;
  }

  write(output: Uint8Array) {
    if (this.#disposed) return;
    this.#core.write(output);
    this.#options.probe?.written(output.length);
    this.#invalidate();
  }

  /** The terminal's size now, which another device may have given it. */
  resized(size: TerminalSize) {
    if (this.#disposed) return;
    this.#core.resize({ columns: size.cols, rows: size.rows }, this.#metrics);
    this.#full = true;
    this.#invalidate();
  }

  setFontSize(size: number) {
    if (this.#disposed || size === this.#fontSize) return;
    this.#fontSize = size;
    this.#metrics = measure(this.#options.family, size);
    this.#laidOut();
  }

  focus() {
    if (!this.#disposed && document.activeElement !== this.#field) this.#field.focus({ preventScroll: true });
  }

  /** The rows on screen as text: for tests, and for what a screen reader is told. */
  text(): string[] {
    const frame = this.#core.frame();
    this.#full = true;
    this.#invalidate();
    if (!frame) return [];
    const lines: string[] = [];
    for (let y = 0; y < frame.rows; y += 1) {
      let line = '';
      for (let x = 0; x < frame.columns; x += 1) {
        const index = y * frame.columns + x;
        if ((frame.cells[index * CELL_WORDS + 3] ?? 0) & CELL.spacer) continue;
        line += frame.text(index) || ' ';
      }
      lines.push(line.trimEnd());
    }
    return lines;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stop.abort();
    this.#observer.disconnect();
    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
    this.#core.close();
    this.#canvas.remove();
    this.#field.remove();
  }

  #fit(): TerminalSize {
    const { width, height } = this.#host.getBoundingClientRect();
    return {
      cols: Math.min(500, Math.max(2, Math.floor((width - 2 * PADDING) / this.#metrics.width))),
      rows: Math.min(300, Math.max(2, Math.floor((height - 2 * PADDING) / this.#metrics.height))),
    };
  }

  /** The view's size or font changed: the canvas follows, and the Host hears the grid that fits. */
  #laidOut() {
    if (this.#disposed) return;
    const { width, height } = this.#host.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    const scale = window.devicePixelRatio || 1;
    const [pixelsWide, pixelsHigh] = [Math.round(width * scale), Math.round(height * scale)];
    if (this.#canvas.width !== pixelsWide || this.#canvas.height !== pixelsHigh) {
      this.#canvas.width = pixelsWide;
      this.#canvas.height = pixelsHigh;
    }
    this.#full = true;
    this.#invalidate();
    const fits = this.#fit();
    if (fits.cols === this.#fits.cols && fits.rows === this.#fits.rows) return;
    this.#fits = fits;
    this.#options.fit(fits);
  }

  #invalidate() {
    if (this.#disposed || this.#frame !== undefined) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = undefined;
      this.#draw();
    });
  }

  #send(bytes: Uint8Array | undefined) {
    if (!bytes || bytes.length === 0) return;
    // Typing is at the prompt: back from the scrollback, and nothing stays selected.
    this.#core.scrollToBottom();
    if (this.#selected) {
      this.#core.clearSelection();
      this.#selected = false;
    }
    this.#invalidate();
    this.#options.input(bytes);
  }

  /** Text that came composed: an accent, an input method's, the emoji picker's. */
  #typed(text: string) {
    if (text) this.#send(this.#core.key({ code: '', text, mods: 0 }));
  }

  #cell(event: MouseEvent) {
    const bounds = this.#canvas.getBoundingClientRect();
    const px = event.clientX - bounds.left - PADDING;
    const py = event.clientY - bounds.top - PADDING;
    return { px, py, x: px / this.#metrics.width, y: py / this.#metrics.height, height: bounds.height - 2 * PADDING };
  }

  #listen() {
    const signal = this.#stop.signal;
    const field = this.#field;
    const canvas = this.#canvas;

    field.addEventListener('keydown', (event) => {
      const key = keyFor(event, 'press');
      if (key === undefined || key === 'compose') return;
      const bytes = this.#core.key(key);
      // A key the terminal has no bytes for (a modifier alone) is nobody's.
      if (!bytes?.length) return;
      event.preventDefault();
      this.#send(bytes);
    }, { signal });
    field.addEventListener('keyup', (event) => {
      const key = keyFor(event, 'release');
      if (key === undefined || key === 'compose') return;
      // Only a program that asked to hear keys let go gets bytes for one.
      const bytes = this.#core.key(key);
      if (bytes && bytes.length > 0) this.#options.input(bytes);
    }, { signal });
    field.addEventListener('input', (event) => {
      if ((event as InputEvent).isComposing) return;
      const text = field.value;
      field.value = '';
      this.#typed(text);
    }, { signal });
    field.addEventListener('compositionend', (event) => {
      field.value = '';
      this.#typed(event.data);
    }, { signal });
    field.addEventListener('paste', (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain');
      if (text) this.#send(this.#core.paste(text));
    }, { signal });
    const copy = (event: ClipboardEvent) => {
      const text = this.#core.selection();
      if (!text) return;
      event.preventDefault();
      event.clipboardData?.setData('text/plain', text);
    };
    field.addEventListener('copy', copy, { signal });
    field.addEventListener('cut', copy, { signal });
    field.addEventListener('focus', () => {
      this.#focused = true;
      this.#invalidate();
    }, { signal });
    field.addEventListener('blur', () => {
      this.#focused = false;
      this.#invalidate();
    }, { signal });

    const mods = (event: MouseEvent) => (event.shiftKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.altKey ? 4 : 0);
    const button = (event: MouseEvent) => event.button === 0 ? 1 : event.button === 1 ? 3 : event.button === 2 ? 2 : 0;
    canvas.addEventListener('mousedown', (event) => {
      this.focus();
      // The field keeps the keyboard: a press on the canvas mustn't take it.
      event.preventDefault();
      const at = this.#cell(event);
      if (event.metaKey && event.button === 0) {
        this.#follow(Math.floor(at.x), Math.floor(at.y));
        return;
      }
      // Shift keeps the mouse for selecting, as in other terminals.
      if (this.#modes.mouse && !event.shiftKey) {
        this.#held = { button: button(event), program: true };
        const bytes = this.#core.mouse({ x: at.x, y: at.y, button: button(event), action: 'press', mods: mods(event), pressed: true });
        if (bytes?.length) this.#options.input(bytes);
        return;
      }
      if (event.button !== 0) return;
      this.#held = { button: 1, program: false };
      this.#selected = this.#core.select('press', { x: Math.floor(at.x), y: Math.floor(at.y), px: at.px, py: at.py }, { ms: event.timeStamp });
      this.#invalidate();
    }, { signal });
    window.addEventListener('mousemove', (event) => {
      const held = this.#held;
      if (!held && !(this.#modes.mouse && event.target === canvas)) return;
      const at = this.#cell(event);
      if (!held || held.program) {
        const bytes = this.#core.mouse({ x: at.x, y: at.y, button: held?.button ?? 0, action: 'motion', mods: mods(event), pressed: held !== undefined });
        if (bytes?.length) this.#options.input(bytes);
        return;
      }
      // Dragged past the top or bottom, the screen scrolls under the selection.
      if (at.py < 0) this.#core.scroll(-1);
      else if (at.py > at.height) this.#core.scroll(1);
      this.#selected = this.#core.select('drag', { x: Math.floor(at.x), y: Math.floor(at.y), px: Math.max(0, at.px), py: Math.max(0, at.py) }, {
        ms: event.timeStamp,
        rectangle: event.altKey,
        height: at.height,
      });
      this.#invalidate();
    }, { signal });
    window.addEventListener('mouseup', (event) => {
      const held = this.#held;
      if (!held) return;
      this.#held = undefined;
      const at = this.#cell(event);
      if (held.program) {
        const bytes = this.#core.mouse({ x: at.x, y: at.y, button: held.button, action: 'release', mods: mods(event), pressed: false });
        if (bytes?.length) this.#options.input(bytes);
        return;
      }
      this.#selected = this.#core.select('release', { x: Math.floor(at.x), y: Math.floor(at.y), px: Math.max(0, at.px), py: Math.max(0, at.py) }, { ms: event.timeStamp });
      this.#invalidate();
    }, { signal });
    canvas.addEventListener('contextmenu', (event) => {
      if (this.#modes.mouse && !event.shiftKey) event.preventDefault();
    }, { signal });
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.#wheel += event.deltaMode === 1 ? event.deltaY * this.#metrics.height : event.deltaY;
      const lines = Math.trunc(this.#wheel / this.#metrics.height);
      if (!lines) return;
      this.#wheel -= lines * this.#metrics.height;
      const count = Math.min(WHEEL_LINES, Math.abs(lines));
      if (this.#modes.mouse && !event.shiftKey) {
        const at = this.#cell(event);
        for (let line = 0; line < count; line += 1) {
          const bytes = this.#core.mouse({ x: at.x, y: at.y, button: lines < 0 ? 4 : 5, action: 'press', mods: mods(event), pressed: false });
          if (bytes?.length) this.#options.input(bytes);
        }
      } else if (this.#modes.alternate) {
        // An editor or a pager has no scrollback of the terminal's: the wheel is its arrows.
        for (let line = 0; line < count; line += 1) {
          const bytes = this.#core.key({ code: lines < 0 ? 'ArrowUp' : 'ArrowDown', mods: 0 });
          if (bytes?.length) this.#options.input(bytes);
        }
      } else {
        this.#core.scroll(lines);
        this.#invalidate();
      }
    }, { signal, passive: false });
  }

  /** Opens what the cell links to: the program's own link, or an address written there. */
  #follow(x: number, y: number) {
    const marked = this.#core.link(x, y);
    if (marked) {
      if (opens(marked)) this.#options.open(marked);
      return;
    }
    const frame = this.#core.frame();
    this.#full = true;
    this.#invalidate();
    const address = frame && addressAt(frame, x, y);
    if (address) this.#options.open(address);
  }

  #draw() {
    if (this.#disposed) return;
    const frame = this.#core.frame();
    if (!frame) return;
    this.#modes = { mouse: frame.mouse, alternate: frame.alternate };
    const context = this.#context;
    const full = this.#full;
    this.#full = false;
    // The field sits at the cursor, where an input method puts its candidates.
    this.#field.style.transform = `translate(${PADDING + frame.cursor.x * this.#metrics.width}px, ${PADDING + frame.cursor.y * this.#metrics.height}px)`;
    if (!context || (!full && !frame.changed)) {
      this.#options.probe?.drawn();
      return;
    }
    const scale = window.devicePixelRatio || 1;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    const width = this.#canvas.width / scale;
    const height = this.#canvas.height / scale;
    const { width: cellWidth, height: cellHeight } = this.#metrics;
    const columns = Math.min(frame.columns, Math.max(0, Math.ceil((width - PADDING) / cellWidth)));
    const rows = Math.min(frame.rows, Math.max(0, Math.ceil((height - PADDING) / cellHeight)));
    if (full) {
      context.fillStyle = css(frame.background);
      context.fillRect(0, 0, width, height);
    }
    const cursorRow = frame.cursor.visible ? frame.cursor.y : -1;
    for (let y = 0; y < rows; y += 1) {
      if (full || frame.dirty[y] || y === cursorRow || y === this.#cursorRow) this.#row(context, frame, y, columns, width);
    }
    this.#cursorRow = cursorRow;
    this.#thumb(context, frame, width, height);
    this.#options.probe?.drawn();
  }

  /** Where column `x` starts, on a whole device pixel so neighbours meet without a seam. */
  #left(x: number) {
    const scale = window.devicePixelRatio || 1;
    return Math.round((PADDING + x * this.#metrics.width) * scale) / scale;
  }

  #font(flags: number) {
    return `${flags & CELL.italic ? 'italic ' : ''}${flags & CELL.bold ? 'bold ' : ''}${this.#fontSize}px ${this.#options.family}`;
  }

  #row(context: CanvasRenderingContext2D, frame: Frame, y: number, columns: number, width: number) {
    const { height: cellHeight, ascent } = this.#metrics;
    const cells = frame.cells;
    const top = PADDING + y * cellHeight;
    const base = y * frame.columns * CELL_WORDS;
    const flagsAt = (x: number) => (cells[base + x * CELL_WORDS + 3] ?? 0) & 0xffff;
    const backgroundAt = (x: number) => flagsAt(x) & CELL.selected ? SELECTION : cells[base + x * CELL_WORDS + 2] ?? frame.background;
    // Backgrounds first, a run of one color at a time, so a wide glyph isn't erased by its second cell.
    for (let x = 0; x < columns;) {
      const color = backgroundAt(x);
      const start = x;
      while (x < columns && backgroundAt(x) === color) x += 1;
      const left = this.#left(start);
      context.fillStyle = css(color);
      context.fillRect(left, top, this.#left(x) - left, cellHeight);
    }
    // Past the last column is the terminal's own background, whatever the row's last cell has.
    context.fillStyle = css(frame.background);
    context.fillRect(this.#left(columns), top, Math.max(0, width - this.#left(columns)), cellHeight);
    // A glyph taller than its row stays in it: the rows beside aren't drawn again to clear it.
    context.save();
    context.beginPath();
    context.rect(0, top, width, cellHeight);
    context.clip();
    context.textBaseline = 'alphabetic';
    let font = '';
    const use = (flags: number, color: number) => {
      const next = this.#font(flags);
      if (next !== font) {
        font = next;
        context.font = next;
      }
      context.fillStyle = css(color);
    };
    for (let x = 0; x < columns;) {
      const flags = flagsAt(x);
      const word = base + x * CELL_WORDS;
      const codepoint = cells[word] ?? 0;
      if (flags & (CELL.spacer | CELL.invisible) || codepoint === 0 || codepoint === 0x20) {
        x += 1;
        continue;
      }
      const foreground = cells[word + 1] ?? frame.foreground;
      const style = flags & (CELL.bold | CELL.italic);
      const clustered = (cells[word + 3] ?? 0) >>> 16 > 0;
      const plain = (at: number) => {
        const other = cells[base + at * CELL_WORDS] ?? 0;
        const otherFlags = flagsAt(at);
        // ASCII in the terminal's own font advances a cell exactly, so a run draws as one string.
        return other >= 0x20 && other < 0x7f && !(otherFlags & (CELL.spacer | CELL.invisible | CELL.wide))
          && (otherFlags & (CELL.bold | CELL.italic)) === style
          && (other === 0x20 || (cells[base + at * CELL_WORDS + 1] ?? 0) === foreground)
          && (cells[base + at * CELL_WORDS + 3] ?? 0) >>> 16 === 0;
      };
      use(flags, foreground);
      if (!clustered && plain(x)) {
        const start = x;
        let text = '';
        while (x < columns && plain(x)) {
          text += String.fromCharCode(cells[base + x * CELL_WORDS] ?? 0x20);
          x += 1;
        }
        context.fillText(text.trimEnd(), PADDING + start * this.#metrics.width, top + ascent);
        continue;
      }
      context.fillText(frame.text(y * frame.columns + x), PADDING + x * this.#metrics.width, top + ascent);
      x += 1;
    }
    for (let x = 0; x < columns; x += 1) {
      const flags = flagsAt(x);
      if (!(flags & (CELL.underline | CELL.strike)) || flags & CELL.invisible) continue;
      context.fillStyle = css(cells[base + x * CELL_WORDS + 1] ?? frame.foreground);
      const left = this.#left(x);
      const wide = this.#left(x + 1) - left;
      if (flags & CELL.underline) context.fillRect(left, top + cellHeight - 2, wide, 1);
      if (flags & CELL.strike) context.fillRect(left, top + Math.floor(cellHeight / 2), wide, 1);
    }
    if (frame.cursor.visible && frame.cursor.y === y && frame.cursor.x < columns) this.#cursor(context, frame, top);
    context.restore();
  }

  #cursor(context: CanvasRenderingContext2D, frame: Frame, top: number) {
    const { height: cellHeight, ascent } = this.#metrics;
    const x = frame.cursor.x;
    const left = this.#left(x);
    const wide = this.#left(x + 1) - left;
    const color = css(frame.cursor.color);
    context.fillStyle = color;
    // Without the keyboard, an outline: the terminal isn't where typing goes.
    const style = this.#focused ? frame.cursor.style : CURSOR.hollow;
    if (style === CURSOR.bar) {
      context.fillRect(left, top, 2, cellHeight);
    } else if (style === CURSOR.underline) {
      context.fillRect(left, top + cellHeight - 2, wide, 2);
    } else if (style === CURSOR.hollow) {
      context.strokeStyle = color;
      context.lineWidth = 1;
      context.strokeRect(left + 0.5, top + 0.5, wide - 1, cellHeight - 1);
    } else {
      context.fillRect(left, top, wide, cellHeight);
      const index = frame.cursor.y * frame.columns + x;
      const flags = (frame.cells[index * CELL_WORDS + 3] ?? 0) & 0xffff;
      const text = flags & (CELL.spacer | CELL.invisible) ? '' : frame.text(index);
      if (text && text !== ' ') {
        context.font = this.#font(flags);
        context.fillStyle = css(frame.cells[index * CELL_WORDS + 2] ?? frame.background);
        context.fillText(text, PADDING + x * this.#metrics.width, top + ascent);
      }
    }
  }

  /** Where the screen is in the scrollback, at the right edge, while it's scrolled back. */
  #thumb(context: CanvasRenderingContext2D, frame: Frame, width: number, height: number) {
    const { total, offset, length } = frame.scroll;
    context.fillStyle = css(frame.background);
    context.fillRect(width - 4, 0, 4, height);
    if (total <= length || offset + length >= total) return;
    const track = height - 2 * PADDING;
    const size = Math.max(16, track * length / total);
    context.fillStyle = css(SELECTION);
    context.fillRect(width - 4, PADDING + (track - size) * offset / (total - length), 3, size);
  }
}
