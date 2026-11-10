// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CELL, CELL_WORDS, Ghostty, MODS, screenText } from './core';

const wasm = new URL('./generated/weave-terminal.wasm', import.meta.url);
const built = existsSync(wasm);
const text = (bytes: Uint8Array | undefined) => bytes ? new TextDecoder().decode(bytes) : undefined;
const bytes = (value: string) => new TextEncoder().encode(value);

// Built by `bun scripts/ghostty.ts web`; without it there's no terminal to test.
describe.skipIf(!built)('the terminal in WebAssembly', () => {
  const load = () => Ghostty.load(readFileSync(wasm));
  const cell = { width: 8, height: 17 };

  it('names its codec as a holder of the same Ghostty does', async () => {
    const ghostty = await load();
    expect(ghostty.codec('abc')).toMatch(/^ghostty abc snapshot \d+$/);
  });

  it('draws what it was written, and marks only the rows that changed', async () => {
    const ghostty = await load();
    const terminal = ghostty.terminal({ columns: 20, rows: 4 }, cell)!;
    terminal.write(bytes('hello\r\n\x1b[1;31mred\x1b[0m 日本'));
    const frame = terminal.frame()!;
    expect(screenText(frame)).toEqual(['hello', 'red 日本', '', '']);
    expect([frame.columns, frame.rows]).toEqual([20, 4]);
    expect(frame.cursor).toMatchObject({ x: 8, y: 1, visible: true });
    const red = 20 * CELL_WORDS;
    expect(frame.cells[red + 3]! & CELL.bold).toBe(CELL.bold);
    expect(frame.cells[red + 1]).toBe(0xf38ba8);
    expect(frame.cells[(20 + 4) * CELL_WORDS + 3]! & CELL.wide).toBe(CELL.wide);
    expect(frame.cells[(20 + 5) * CELL_WORDS + 3]! & CELL.spacer).toBe(CELL.spacer);

    terminal.write(bytes('!'));
    const next = terminal.frame()!;
    expect([...next.dirty]).toEqual([0, 1, 0, 0]);
    expect(terminal.frame()!.changed).toBe(false);
    terminal.close();
  });

  it('shows a cluster of several codepoints as one cell', async () => {
    const ghostty = await load();
    const terminal = ghostty.terminal({ columns: 10, rows: 2 }, cell)!;
    terminal.write(bytes('éx 👨‍👩‍👧'));
    expect(screenText(terminal.frame()!)[0]).toBe('éx 👨‍👩‍👧');
    terminal.close();
  });

  it('restores a snapshot with its history, and scrolls back into it', async () => {
    const ghostty = await load();
    const first = ghostty.terminal({ columns: 12, rows: 3 }, cell)!;
    first.write(bytes(Array.from({ length: 10 }, (_, line) => `line ${line}`).join('\r\n')));
    const snapshot = first.snapshot();
    first.close();

    const second = ghostty.terminal({ columns: 80, rows: 24 }, cell)!;
    expect(second.restore(snapshot)).toBe(true);
    expect(screenText(second.frame()!)).toEqual(['line 7', 'line 8', 'line 9']);
    second.scroll(-2);
    const back = second.frame()!;
    expect(screenText(back)).toEqual(['line 5', 'line 6', 'line 7']);
    expect(back.scroll).toEqual({ total: 10, offset: 5, length: 3 });
    second.scrollToBottom();
    expect(screenText(second.frame()!)[2]).toBe('line 9');
    expect(second.restore(bytes('not a snapshot'))).toBe(false);
    expect(screenText(second.frame()!)[2]).toBe('line 9');
    second.close();
  });

  it('encodes keys by the modes the program set', async () => {
    const ghostty = await load();
    const terminal = ghostty.terminal({ columns: 20, rows: 4 }, cell)!;
    expect(text(terminal.key({ code: 'KeyA', text: 'a', mods: 0 }))).toBe('a');
    expect(text(terminal.key({ code: 'KeyC', text: 'c', mods: MODS.control }))).toBe('\x03');
    expect(text(terminal.key({ code: 'Enter', mods: 0 }))).toBe('\r');
    expect(text(terminal.key({ code: 'ArrowUp', mods: 0 }))).toBe('\x1b[A');
    // Application cursor keys, as vim asks for.
    terminal.write(bytes('\x1b[?1h'));
    expect(text(terminal.key({ code: 'ArrowUp', mods: 0 }))).toBe('\x1bOA');
    expect(text(terminal.key({ code: 'KeyB', text: 'b', mods: MODS.option }))).toBe('\x1bb');
    terminal.close();
  });

  it('brackets a paste only when the program asked', async () => {
    const ghostty = await load();
    const terminal = ghostty.terminal({ columns: 20, rows: 4 }, cell)!;
    expect(text(terminal.paste('ls\n'))).toBe('ls\r');
    terminal.write(bytes('\x1b[?2004h'));
    expect(text(terminal.paste('ls'))).toBe('\x1b[200~ls\x1b[201~');
    terminal.close();
  });

  it('reports the mouse only to a program that asked for it', async () => {
    const ghostty = await load();
    const terminal = ghostty.terminal({ columns: 20, rows: 4 }, cell)!;
    const press = { x: 2.5, y: 1.5, button: 1, action: 'press', mods: 0, pressed: true } as const;
    expect(terminal.mouse(press)).toBeUndefined();
    expect(terminal.frame()!.mouse).toBe(false);
    terminal.write(bytes('\x1b[?1000h\x1b[?1006h'));
    expect(terminal.frame()!.mouse).toBe(true);
    expect(text(terminal.mouse(press))).toBe('\x1b[<0;3;2M');
    terminal.close();
  });

  it('selects by dragging, a word by a second press, and gives the text', async () => {
    const ghostty = await load();
    const terminal = ghostty.terminal({ columns: 20, rows: 4 }, cell)!;
    terminal.write(bytes('hello world\r\nsecond line'));
    // A drag takes in the cells whose middles it crossed, so it starts left of one and ends right of another.
    const at = (x: number, y: number, within = 2) => ({ x, y, px: x * cell.width + within, py: y * cell.height + 2 });
    expect(terminal.select('press', at(0, 0), { ms: 1000 })).toBe(false);
    expect(terminal.select('drag', at(4, 0, 6), { ms: 1050 })).toBe(true);
    terminal.select('release', at(4, 0, 6), { ms: 1100 });
    expect(terminal.selection()).toBe('hello');
    const frame = terminal.frame()!;
    const selected = Array.from({ length: 20 }, (_, x) => (frame.cells[x * CELL_WORDS + 3]! & CELL.selected) !== 0);
    expect(selected.slice(0, 6)).toEqual([true, true, true, true, true, false]);

    terminal.select('press', at(7, 0), { ms: 5000 });
    terminal.select('release', at(7, 0), { ms: 5050 });
    expect(terminal.selection()).toBeUndefined();
    expect(terminal.select('press', at(7, 0), { ms: 5150 })).toBe(true);
    expect(terminal.selection()).toBe('world');
    terminal.clearSelection();
    expect(terminal.selection()).toBeUndefined();
    terminal.close();
  });

  it('finds the address a cell links to', async () => {
    const ghostty = await load();
    const terminal = ghostty.terminal({ columns: 20, rows: 2 }, cell)!;
    terminal.write(bytes('a \x1b]8;;https://example.com/x\x1b\\link\x1b]8;;\x1b\\ b'));
    expect(terminal.link(3, 0)).toBe('https://example.com/x');
    expect(terminal.link(0, 0)).toBeUndefined();
    expect(terminal.frame()!.cells[2 * CELL_WORDS + 3]! & CELL.link).toBe(CELL.link);
    terminal.close();
  });

  it('keeps many terminals in one module, and grows as they need', async () => {
    const ghostty = await load();
    const terminals = Array.from({ length: 6 }, () => ghostty.terminal({ columns: 120, rows: 40 }, cell)!);
    const flood = bytes(`${'x'.repeat(119)}\r\n`.repeat(2000));
    for (const terminal of terminals) terminal.write(flood);
    for (const terminal of terminals) {
      expect(screenText(terminal.frame()!)[0]).toBe('x'.repeat(119));
      terminal.close();
    }
  });
});
