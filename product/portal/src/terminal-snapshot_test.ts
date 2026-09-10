import { expect, test } from 'bun:test';
import { terminalSnapshot, terminalSnapshotFormat } from './terminal-snapshot.ts';
const state = (overrides: Record<string, string> = {}) => terminalSnapshotFormat.replace(/#\{([^}]+)\}/g, (_, key) => ({ cursor_x: '7', cursor_y: '5', pane_width: '80', pane_height: '24', alternate_on: '1', alternate_saved_x: '2', alternate_saved_y: '3', keypad_cursor_flag: '1', keypad_flag: '1', bracket_paste_flag: '1', cursor_flag: '0', cursor_shape: 'bar', cursor_blinking: '0', scroll_region_upper: '2', scroll_region_lower: '20', origin_flag: '1', wrap_flag: '1', insert_flag: '0', mouse_standard_flag: '0', mouse_button_flag: '1', mouse_all_flag: '0', mouse_sgr_flag: '1', mouse_utf8_flag: '0', pane_key_mode: 'Ext 2', ...overrides } as Record<string, string>)[key]!);
test('restores saved primary screen before the alternate screen and supported input/display modes', async () => {
  const data = terminalSnapshot('ALT\n', 'PRIMARY\n', state());
  expect(data.indexOf('PRIMARY')).toBeLessThan(data.indexOf('\x1b[?1049h'));
  expect(data.indexOf('\x1b[?1049h')).toBeLessThan(data.indexOf('ALT'));
  for (const sequence of ['\x1b[?1h', '\x1b=', '\x1b[?2004h', '\x1b[?25l', '\x1b[6 q', '\x1b[?1002h', '\x1b[?1006h', '\x1b[>4;2m', '\x1b[3;21r']) expect(data).toContain(sequence);
  expect(data.endsWith('\x1b[4;8H')).toBe(true);
  if (process.env.WEAVE_SNAPSHOT_PROBE_INPUT) await Bun.write(process.env.WEAVE_SNAPSHOT_PROBE_INPUT, JSON.stringify({ data, cols: 80, rows: 24 }));
});
test('does not enable absent modes and rejects incomplete or invalid cursor/grid state', () => {
  expect(terminalSnapshot('shell', '', state({ alternate_on: '0', keypad_cursor_flag: '0', keypad_flag: '0', bracket_paste_flag: '0', pane_key_mode: 'VT10x' }))).not.toContain('\x1b[?1049h');
  expect(() => terminalSnapshot('', '', '0\t0')).toThrow('Incomplete');
  expect(() => terminalSnapshot('', '', state({ cursor_y: 'NaN' }))).toThrow('cursor_y');
  expect(() => terminalSnapshot('', '', state({ pane_width: '99999' }))).toThrow('dimensions');
});
