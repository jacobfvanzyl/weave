import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * The app's commands (WVE-203): everything the person does to a Session's layout, and what opens
 * a thread or a terminal, by name. Keys, the Mac's menu bar, a Block's own menu and the palette
 * all run the same ones, as extensions will. The table below is the whole of it: a command's
 * name, what it's called, where a menu puts it, and its key.
 *
 * A command does something only while a component handles it (`useCommand`): the Session on
 * screen handles the layout's, and so on. One nothing handles is off, and the palette leaves it out.
 */
export type CommandGroup = 'Session' | 'Tab' | 'Block' | 'Go';

export type CommandSpec = {
  id: string;
  title: string;
  group: CommandGroup;
  /**
   * Its key: `Mod` is ⌘ on Apple's devices and Ctrl elsewhere, then `Alt` and `Shift`, then a
   * letter, a digit, `[`, `]`, `=`, `-`, `Enter`, or `Left`, `Right`, `Up`, `Down`.
   */
  keys?: string;
};

const spec = (id: string, title: string, group: CommandGroup, keys?: string): CommandSpec => ({ id, title, group, ...(keys ? { keys } : {}) });

export const COMMANDS = [
  spec('thread.new', 'New Thread', 'Session', 'Mod+N'),
  spec('terminal.new', 'New Terminal', 'Session', 'Mod+Shift+N'),
  spec('block.add', 'New Block…', 'Session', 'Mod+O'),
  spec('session.new', 'New Session…', 'Session'),
  spec('session.end', 'End Session…', 'Session'),
  spec('project.add', 'Add Project…', 'Session'),
  spec('palette.open', 'Command Palette…', 'Session', 'Mod+K'),
  spec('tab.new', 'New Tab', 'Tab', 'Mod+T'),
  spec('tab.rename', 'Rename Tab…', 'Tab'),
  spec('tab.close', 'Close Tab', 'Tab'),
  spec('tab.moveLeft', 'Move Tab Left', 'Tab'),
  spec('tab.moveRight', 'Move Tab Right', 'Tab'),
  spec('block.splitRight', 'Split Right', 'Block', 'Mod+D'),
  spec('block.splitDown', 'Split Down', 'Block', 'Mod+Shift+D'),
  spec('block.zoom', 'Zoom', 'Block', 'Mod+Shift+Enter'),
  spec('block.float', 'Float or Dock', 'Block'),
  spec('block.minimize', 'Minimize', 'Block'),
  spec('block.toNewTab', 'Move to a New Tab', 'Block'),
  spec('block.close', 'Close', 'Block', 'Mod+W'),
  spec('terminal.larger', 'Larger Terminal Text', 'Block', 'Mod+='),
  spec('terminal.smaller', 'Smaller Terminal Text', 'Block', 'Mod+-'),
  spec('terminal.actualSize', 'Actual Terminal Text Size', 'Block', 'Mod+0'),
  spec('tab.next', 'Next Tab', 'Go', 'Mod+Shift+]'),
  spec('tab.previous', 'Previous Tab', 'Go', 'Mod+Shift+['),
  spec('block.focusLeft', 'Focus the Block to the Left', 'Go', 'Mod+Alt+Left'),
  spec('block.focusRight', 'Focus the Block to the Right', 'Go', 'Mod+Alt+Right'),
  spec('block.focusUp', 'Focus the Block Above', 'Go', 'Mod+Alt+Up'),
  spec('block.focusDown', 'Focus the Block Below', 'Go', 'Mod+Alt+Down'),
  spec('block.next', 'Next Block', 'Go', 'Mod+Alt+]'),
  spec('block.previous', 'Previous Block', 'Go', 'Mod+Alt+['),
  spec('session.next', 'Next Session', 'Go', 'Mod+Shift+Down'),
  spec('session.previous', 'Previous Session', 'Go', 'Mod+Shift+Up'),
  spec('composer.focus', 'Focus the Composer', 'Go', 'Mod+L'),
] as const satisfies readonly CommandSpec[];

export type CommandId = (typeof COMMANDS)[number]['id'];

export const COMMAND_GROUPS: readonly CommandGroup[] = ['Session', 'Tab', 'Block', 'Go'];

export const commandSpec = (id: string): CommandSpec | undefined => COMMANDS.find((command) => command.id === id);
export const isCommand = (id: unknown): id is CommandId => typeof id === 'string' && commandSpec(id) !== undefined;

const handlers = new Map<CommandId, Set<() => void>>();
const listeners = new Set<() => void>();
let version = 0;

const changed = () => {
  version += 1;
  for (const listener of listeners) listener();
};

/** Whether anything handles `id` now. */
export const commandOn = (id: CommandId) => (handlers.get(id)?.size ?? 0) > 0;

/** Runs `id`: its latest handler, as the component deepest on screen registers last. Whether one did. */
export function runCommand(id: CommandId): boolean {
  const latest = [...(handlers.get(id) ?? [])].at(-1);
  latest?.();
  return latest !== undefined;
}

/** Runs `handler` for `id` until the returned function stops it. */
export function onCommand(id: CommandId, handler: () => void): () => void {
  let registered = handlers.get(id);
  if (!registered) {
    registered = new Set();
    handlers.set(id, registered);
  }
  registered.add(handler);
  changed();
  return () => {
    registered.delete(handler);
    changed();
  };
}

/** Runs the latest `handler` for `id` while the component is mounted and `on`. */
export function useCommand(id: CommandId, handler: () => void, on = true) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => on ? onCommand(id, () => latest.current()) : undefined, [id, on]);
}

/** The commands something handles now, kept up to date: what a palette or a menu lists. */
export function useCommandsOn(): CommandSpec[] {
  useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => version);
  return COMMANDS.filter(({ id }) => commandOn(id));
}

/** Whether ⌘ is the device's command key: Apple's devices, where Ctrl belongs to the terminal. */
export const appleKeys = (platform = globalThis.navigator?.platform ?? '') => /Mac|iPhone|iPad/i.test(platform);

const CODES: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Equal: '=',
  Minus: '-',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
};

/** A key press as a command's `keys` spells it, or nothing for one that can't be a command's. */
export function keysOf(event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, apple = appleKeys()): string | undefined {
  const mod = apple ? event.metaKey : event.ctrlKey;
  // Without the command key it's typing, and with the other one it's the terminal's or the system's.
  if (!mod || (apple ? event.ctrlKey : event.metaKey)) return undefined;
  const key = CODES[event.code] ?? (/^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit\d$/.test(event.code) ? event.code.slice(5) : undefined);
  if (!key) return undefined;
  return `Mod+${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${key}`;
}

/** The command a key press runs, if a command has that key. */
export const commandForKeys = (keys: string): CommandId | undefined => COMMANDS.find((command) => 'keys' in command && command.keys === keys)?.id;

/** A command's key as the device shows it: `⌘⇧D`, or `Ctrl+Shift+D`. */
export function keysLabel(keys: string, apple = appleKeys()): string {
  const parts = keys.split('+');
  const key = parts.at(-1) ?? '';
  const named = { Left: '←', Right: '→', Up: '↑', Down: '↓', Enter: '↩' }[key] ?? key;
  if (!apple) return [...parts.slice(0, -1).map((part) => part === 'Mod' ? 'Ctrl' : part), named].join('+');
  return `${parts.slice(0, -1).map((part) => ({ Mod: '⌘', Alt: '⌥', Shift: '⇧' }[part] ?? part)).join('')}${named}`;
}

/**
 * Runs commands from the keyboard, for a hardware keyboard on the iPad and in a browser. On the
 * Mac the menu bar has the keys (`src/mac/shell.ts`), so `on` is false there.
 */
export function useCommandKeys(on = true) {
  useEffect(() => {
    if (!on) return;
    const pressed = (event: KeyboardEvent) => {
      const keys = keysOf(event);
      const id = keys ? commandForKeys(keys) : undefined;
      if (!id || !commandOn(id)) return;
      event.preventDefault();
      event.stopPropagation();
      runCommand(id);
    };
    window.addEventListener('keydown', pressed, true);
    return () => window.removeEventListener('keydown', pressed, true);
  }, [on]);
}
