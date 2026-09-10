/** tmux's authoritative pane state at the snapshot boundary. Keep this format
 * and bootstrap together: an empty/unknown field must not invent a mode. */
const fields = ['cursor_x', 'cursor_y', 'pane_width', 'pane_height', 'alternate_on', 'alternate_saved_x', 'alternate_saved_y', 'keypad_cursor_flag', 'keypad_flag', 'bracket_paste_flag', 'cursor_flag', 'cursor_shape', 'cursor_blinking', 'scroll_region_upper', 'scroll_region_lower', 'origin_flag', 'wrap_flag', 'insert_flag', 'mouse_standard_flag', 'mouse_button_flag', 'mouse_all_flag', 'mouse_sgr_flag', 'mouse_utf8_flag', 'pane_key_mode'] as const;
export const terminalSnapshotFormat = fields.map((field) => `#{${field}}`).join('\t');
export function terminalSnapshot(screen: string, savedScreen: string, state: string) {
  const values = state.split('\t');
  if (values.length !== fields.length) throw new Error('Incomplete tmux Terminal state.');
  const s = Object.fromEntries(fields.map((field, index) => [field, values[index]!])) as Record<typeof fields[number], string>;
  const number = (key: typeof fields[number]) => {
    if (!/^\d+$/.test(s[key])) throw new Error(`Invalid tmux Terminal ${key}.`);
    return Number(s[key]);
  };
  const flag = (key: typeof fields[number]) => s[key] === '1';
  const mode = (code: number, key: typeof fields[number], privateMode = true) => `\x1b[${privateMode ? '?' : ''}${code}${flag(key) ? 'h' : 'l'}`;
  const rows = number('pane_height'); const cols = number('pane_width');
  if (rows < 2 || rows > 300 || cols < 2 || cols > 500) throw new Error('Unsupported tmux Terminal snapshot dimensions.');
  const paint = (value: string) => `\x1b[2J\x1b[H${value.replace(/\r?\n$/, '').replace(/\r?\n/g, '\r\n')}\x1b[0m`;
  // Start in a known main screen. Populate the saved primary grid before
  // entering alternate-screen mode, so leaving a restored TUI reveals it.
  let data = '\x1b[?1049l\x1b[?6l\x1b[?7h\x1b[4l\x1b[r';
  if (flag('alternate_on')) data += paint(savedScreen) + `\x1b[${number('alternate_saved_y') + 1};${number('alternate_saved_x') + 1}H\x1b[?1049h`;
  data += paint(screen);
  data += mode(1, 'keypad_cursor_flag') + (flag('keypad_flag') ? '\x1b=' : '\x1b>') + mode(2004, 'bracket_paste_flag');
  data += mode(25, 'cursor_flag') + `\x1b[${({ block: 2, underline: 4, bar: 6 }[s.cursor_shape] ?? 2) - (flag('cursor_blinking') ? 1 : 0)} q`;
  data += mode(1000, 'mouse_standard_flag') + mode(1002, 'mouse_button_flag') + mode(1003, 'mouse_all_flag') + mode(1006, 'mouse_sgr_flag') + mode(1005, 'mouse_utf8_flag');
  data += `\x1b[>4;${s.pane_key_mode === 'Ext 2' ? 2 : s.pane_key_mode === 'Ext 1' ? 1 : 0}m`;
  data += `\x1b[${number('scroll_region_upper') + 1};${number('scroll_region_lower') + 1}r` + mode(6, 'origin_flag') + mode(7, 'wrap_flag') + mode(4, 'insert_flag', false);
  // CUP is relative to the scrolling region when DECOM is enabled.
  const y = number('cursor_y') - (flag('origin_flag') ? number('scroll_region_upper') : 0);
  data += `\x1b[${Math.max(0, y) + 1};${number('cursor_x') + 1}H`;
  return data;
}
