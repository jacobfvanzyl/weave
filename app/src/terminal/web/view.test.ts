import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ghostty } from './core';
import { TerminalView } from './view';

// The page's environment gives a module no file address: from the app's directory, where tests run.
const wasm = resolve(process.cwd(), 'src/terminal/web/generated/weave-terminal.wasm');
const text = (bytes: Uint8Array[]) => new TextDecoder().decode(Uint8Array.from(bytes.flatMap((chunk) => [...chunk])));

/** A finger's event on `target`, as a touch screen sends it. */
const touch = (target: Element, type: string, at: { x: number; y: number }, ms: number) => {
  const finger = { identifier: 1, clientX: at.x, clientY: at.y, target };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    // As WebKit lists them: by index, with a length, and not iterable.
    touches: { value: type === 'touchend' || type === 'touchcancel' ? { length: 0 } : { 0: finger, length: 1 } },
    changedTouches: { value: { 0: finger, length: 1 } },
    timeStamp: { value: ms },
  });
  target.dispatchEvent(event);
  return event;
};

// Built by `bun scripts/ghostty.ts web`; without it there's no terminal to test.
describe.skipIf(!existsSync(wasm))('a terminal in the page under a finger and a software keyboard (WVE-221)', () => {
  const made: TerminalView[] = [];
  afterEach(() => {
    for (const view of made.splice(0)) view.dispose();
    vi.useRealTimers();
    document.body.replaceChildren();
  });
  const terminal = async (options: Partial<ConstructorParameters<typeof TerminalView>[2]> = {}) => {
    const host = document.createElement('div');
    document.body.append(host);
    const sent: Uint8Array[] = [];
    const view = new TerminalView(host, await Ghostty.load(readFileSync(wasm)), {
      fontSize: 13,
      family: 'monospace',
      input: (bytes) => sent.push(bytes),
      fit: () => {},
      open: () => {},
      ...options,
    });
    made.push(view);
    const canvas = host.querySelector('canvas')!;
    const field = host.querySelector('textarea')!;
    return { view, canvas, field, sent };
  };

  it('leaves a tap to the page, whose click takes the keyboard', async () => {
    const focused = vi.fn();
    const { canvas, field } = await terminal({ focused });
    const down = touch(canvas, 'touchstart', { x: 40, y: 40 }, 0);
    const up = touch(canvas, 'touchend', { x: 41, y: 40 }, 80);
    // WebKit shows the keyboard for a click, and makes none of a touch the page took.
    expect([down.defaultPrevented, up.defaultPrevented]).toEqual([false, false]);
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.activeElement).toBe(field);
    expect(focused).toHaveBeenLastCalledWith(true);
  });

  it('scrolls when dragged, without taking the keyboard', async () => {
    const { view, canvas, field } = await terminal();
    view.restore({ kind: 'vt', size: { cols: 20, rows: 4 }, bytes: new TextEncoder().encode(Array.from({ length: 40 }, (_, line) => `line-${line}`).join('\r\n')) });
    expect(view.text().at(-1)).toBe('line-39');
    touch(canvas, 'touchstart', { x: 40, y: 20 }, 0);
    // The text follows the finger down, to what's above.
    touch(canvas, 'touchmove', { x: 40, y: 120 }, 50);
    touch(canvas, 'touchmove', { x: 40, y: 220 }, 400);
    const up = touch(canvas, 'touchend', { x: 40, y: 220 }, 600);
    // No click follows a drag.
    expect(up.defaultPrevented).toBe(true);
    expect(view.text().at(-1)).not.toBe('line-39');
    expect(document.activeElement).not.toBe(field);
  });

  it('selects the word a finger rests on, and copies it when the finger lifts', async () => {
    vi.useFakeTimers();
    const copied = vi.fn();
    const { view, canvas } = await terminal({ copied });
    view.restore({ kind: 'vt', size: { cols: 20, rows: 4 }, bytes: new TextEncoder().encode('hello world') });
    touch(canvas, 'touchstart', { x: 12, y: 12 }, 0);
    vi.advanceTimersByTime(500);
    touch(canvas, 'touchend', { x: 12, y: 12 }, 520);
    expect(copied).toHaveBeenCalledWith('hello');
  });

  it("sends a software keyboard's text, Delete and Return", async () => {
    const { field, sent } = await terminal();
    field.value = 'ls';
    field.dispatchEvent(new Event('input'));
    for (const inputType of ['deleteContentBackward', 'insertLineBreak']) {
      const event = new Event('beforeinput', { cancelable: true });
      Object.defineProperty(event, 'inputType', { value: inputType });
      field.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(text(sent)).toBe('ls\x7f\r');
    expect(field.value).toBe('');
  });

  it("sends the key bar's keys, and Control with the next letter only", async () => {
    const controlUsed = vi.fn();
    const { view, field, sent } = await terminal({ controlUsed });
    view.press('Escape');
    view.press('ArrowUp');
    view.holdControl(true);
    for (const letter of ['c', 'c']) {
      field.value = letter;
      field.dispatchEvent(new Event('input'));
    }
    expect(text(sent)).toBe('\x1b\x1b[A\x03c');
    expect(controlUsed).toHaveBeenCalledTimes(1);
  });
});
