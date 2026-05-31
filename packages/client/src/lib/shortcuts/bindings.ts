import type { ShortcutBinding, ShortcutChord } from './types';

export const shortcutLeaderChord: ShortcutChord = { key: 'k', mod: true, shift: true };

const key = (value: string): ShortcutChord => ({ key: value });

export const defaultShortcutBindings = [
  {
    commandId: 'shortcuts.open',
    kind: 'direct',
    chord: shortcutLeaderChord,
    reservedGlobal: true,
  },
  {
    commandId: 'sidebar.toggle',
    kind: 'leader',
    sequence: [key('s')],
    reservedGlobal: true,
  },
  {
    commandId: 'chat.focus',
    kind: 'leader',
    sequence: [key('c')],
    reservedGlobal: true,
  },
  {
    commandId: 'thread.new',
    kind: 'leader',
    sequence: [key('n')],
    reservedGlobal: true,
  },
  {
    commandId: 'plan.toggle',
    kind: 'leader',
    sequence: [key('p')],
    reservedGlobal: true,
  },
  {
    commandId: 'terminal.globalToggle',
    kind: 'leader',
    sequence: [key(';')],
    reservedGlobal: true,
  },
  {
    commandId: 'terminal.toggle',
    kind: 'leader',
    sequence: [key('t')],
    reservedGlobal: true,
  },
  {
    commandId: 'terminal.expandToggle',
    kind: 'leader',
    sequence: [{ key: 't', shift: true }],
    reservedGlobal: true,
  },
  {
    commandId: 'editor.toggle',
    kind: 'leader',
    sequence: [key('e')],
    reservedGlobal: true,
  },
  {
    commandId: 'editor.expandToggle',
    kind: 'leader',
    sequence: [{ key: 'e', shift: true }],
    reservedGlobal: true,
  },
] as const satisfies readonly ShortcutBinding[];
