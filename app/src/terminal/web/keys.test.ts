// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ghostty, MODS } from './core';
import { keyFor, type Pressed } from './keys';
import { addressAt, opens } from './links';

const press = (key: string, code: string, held: Partial<Pressed> = {}): Pressed => ({
  key, code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, isComposing: false, ...held,
});

describe("a key on the Mac's keyboard", () => {
  it('goes to the terminal with its place and what it types', () => {
    expect(keyFor(press('a', 'KeyA'), 'press')).toEqual({ code: 'KeyA', text: 'a', mods: 0, action: 'press' });
    expect(keyFor(press('A', 'KeyA', { shiftKey: true }), 'press')).toEqual({ code: 'KeyA', text: 'A', mods: MODS.shift, action: 'press' });
    expect(keyFor(press('c', 'KeyC', { ctrlKey: true }), 'press')).toEqual({ code: 'KeyC', text: 'c', mods: MODS.control, action: 'press' });
    expect(keyFor(press('ArrowUp', 'ArrowUp', { repeat: true }), 'press')).toEqual({ code: 'ArrowUp', mods: 0, action: 'repeat' });
    expect(keyFor(press('Enter', 'Enter'), 'release')).toEqual({ code: 'Enter', mods: 0, action: 'release' });
  });

  it("is the app's with ⌘", () => {
    expect(keyFor(press('c', 'KeyC', { metaKey: true }), 'press')).toBeUndefined();
    expect(keyFor(press('ArrowLeft', 'ArrowLeft', { metaKey: true, altKey: true }), 'press')).toBeUndefined();
  });

  it('types the layout’s characters with Option, and is Alt on a key that types nothing', () => {
    expect(keyFor(press('∫', 'KeyB', { altKey: true }), 'press')).toEqual({ code: 'KeyB', text: '∫', mods: 0, action: 'press' });
    expect(keyFor(press('Å', 'KeyA', { altKey: true, shiftKey: true }), 'press')).toEqual({ code: 'KeyA', text: 'Å', mods: MODS.shift, action: 'press' });
    expect(keyFor(press('ArrowLeft', 'ArrowLeft', { altKey: true }), 'press')).toEqual({ code: 'ArrowLeft', mods: MODS.option, action: 'press' });
  });

  it('leaves an accent being composed, or an input method, to the text field', () => {
    expect(keyFor(press('Dead', 'KeyE', { altKey: true }), 'press')).toBe('compose');
    expect(keyFor(press('Process', 'KeyA'), 'press')).toBe('compose');
    expect(keyFor(press('a', 'KeyA', { isComposing: true }), 'press')).toBe('compose');
  });
});

const wasm = new URL('./generated/weave-terminal.wasm', import.meta.url);

describe.skipIf(!existsSync(wasm))('an address on screen', () => {
  const screen = async (output: string, columns = 30) => {
    const ghostty = await Ghostty.load(readFileSync(wasm));
    const terminal = ghostty.terminal({ columns, rows: 4 }, { width: 8, height: 17 })!;
    terminal.write(new TextEncoder().encode(output));
    return terminal.frame()!;
  };

  it('is found under the cell clicked, without what a sentence put after it', async () => {
    const frame = await screen('see https://example.com/a(b)?q=1, ok\r\n(http://x.test/y).', 40);
    expect(addressAt(frame, 4, 0)).toBe('https://example.com/a(b)?q=1');
    expect(addressAt(frame, 26, 0)).toBe('https://example.com/a(b)?q=1');
    expect(addressAt(frame, 2, 0)).toBeUndefined();
    expect(addressAt(frame, 32, 0)).toBeUndefined();
    expect(addressAt(frame, 3, 1)).toBe('http://x.test/y');
    expect(addressAt(frame, 16, 1)).toBeUndefined();
  });

  it('is read whole across a line that wrapped', async () => {
    const frame = await screen('go https://example.com/a/very/long/path/that/wraps here', 20);
    expect(addressAt(frame, 5, 0)).toBe('https://example.com/a/very/long/path/that/wraps');
    expect(addressAt(frame, 5, 1)).toBe('https://example.com/a/very/long/path/that/wraps');
    expect(addressAt(frame, 12, 2)).toBeUndefined();
  });

  it('opens only the web and mail', () => {
    expect(opens('https://example.com')).toBe(true);
    expect(opens('mailto:a@example.com')).toBe(true);
    expect(opens('file:///etc/passwd')).toBe(false);
    expect(opens('javascript:alert(1)')).toBe(false);
    expect(opens('not an address')).toBe(false);
  });
});
