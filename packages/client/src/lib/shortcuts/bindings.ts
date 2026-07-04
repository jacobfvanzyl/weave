import type { ShortcutBinding, ShortcutHotkey } from './types';

export const shortcutLeaderHotkey = 'Mod+K' satisfies ShortcutHotkey;

const leaderSequence = (tail: ShortcutHotkey) => [shortcutLeaderHotkey, tail] as const;

export const defaultShortcutBindings = [
  {
    commandId: 'shortcuts.open',
    kind: 'hotkey',
    hotkey: shortcutLeaderHotkey,
    allowInInputs: true,
    reservedGlobal: true,
    scope: 'app',
    order: 0,
  },
  {
    commandId: 'sidebar.toggle',
    kind: 'sequence',
    sequence: leaderSequence('S'),
    allowInInputs: true,
    reservedGlobal: true,
    scope: 'app',
    order: 10,
  },
  {
    commandId: 'chat.focus',
    kind: 'sequence',
    sequence: leaderSequence('C'),
    allowInInputs: true,
    reservedGlobal: true,
    scope: 'app',
    order: 20,
  },
  {
    commandId: 'thread.new',
    kind: 'sequence',
    sequence: leaderSequence('N'),
    allowInInputs: true,
    reservedGlobal: true,
    scope: 'app',
    order: 30,
  },
  {
    commandId: 'plan.toggle',
    kind: 'sequence',
    sequence: leaderSequence('P'),
    allowInInputs: true,
    reservedGlobal: true,
    scope: 'app',
    order: 40,
  },
  {
    commandId: 'terminal.globalToggle',
    kind: 'sequence',
    sequence: leaderSequence(';'),
    allowInInputs: true,
    reservedGlobal: true,
    scope: 'app',
    order: 45,
  },
  {
    commandId: 'terminal.toggle',
    kind: 'sequence',
    sequence: leaderSequence('T'),
    allowInInputs: true,
    reservedGlobal: true,
    scope: 'app',
    order: 50,
  },
  {
    commandId: 'terminal.expandToggle',
    kind: 'sequence',
    sequence: leaderSequence('Shift+T'),
    allowInInputs: true,
    reservedGlobal: true,
    scope: 'app',
    order: 60,
  },
  {
    commandId: 'editor.toggle',
    kind: 'sequence',
    sequence: leaderSequence('E'),
    allowInInputs: true,
    reservedGlobal: true,
    scope: 'app',
    order: 70,
  },
  {
    commandId: 'editor.expandToggle',
    kind: 'sequence',
    sequence: leaderSequence('Shift+E'),
    allowInInputs: true,
    reservedGlobal: true,
    scope: 'app',
    order: 80,
  },
] as const satisfies readonly ShortcutBinding[];

export const defaultShortcutSequenceTimeoutMs = 1_000;
