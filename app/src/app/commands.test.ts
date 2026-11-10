import { describe, expect, it, vi } from 'vitest';
import { COMMANDS, COMMAND_GROUPS, commandForKeys, commandOn, isCommand, keysLabel, keysOf, onCommand, runCommand } from './commands';

const press = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
  ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe('the table of commands', () => {
  it('names each once, in a group a menu has, and gives no key to two', () => {
    const ids = COMMANDS.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(COMMANDS.every(({ group }) => COMMAND_GROUPS.includes(group))).toBe(true);
    const keys = COMMANDS.flatMap((command) => 'keys' in command ? [command.keys] : []);
    expect(new Set(keys).size).toBe(keys.length);
    expect(isCommand('block.splitRight')).toBe(true);
    expect(isCommand('block.nonsense')).toBe(false);
  });

  it('has the keys of a Mac’s terminals', () => {
    expect(commandForKeys('Mod+D')).toBe('block.splitRight');
    expect(commandForKeys('Mod+Shift+D')).toBe('block.splitDown');
    expect(commandForKeys('Mod+W')).toBe('block.close');
    expect(commandForKeys('Mod+T')).toBe('tab.new');
    expect(commandForKeys('Mod+Shift+]')).toBe('tab.next');
    expect(commandForKeys('Mod+Alt+Left')).toBe('block.focusLeft');
    expect(commandForKeys('Mod+Shift+Enter')).toBe('block.zoom');
    expect(commandForKeys('Mod+N')).toBe('thread.new');
    expect(commandForKeys('Mod+Shift+N')).toBe('terminal.new');
    expect(commandForKeys('Mod+K')).toBe('palette.open');
    expect(commandForKeys('Mod+J')).toBeUndefined();
  });
});

describe('a command', () => {
  it('runs while something handles it, the one that came last when several do', () => {
    const first = vi.fn();
    const second = vi.fn();
    expect(commandOn('tab.rename')).toBe(false);
    expect(runCommand('tab.rename')).toBe(false);
    const stopFirst = onCommand('tab.rename', first);
    const stopSecond = onCommand('tab.rename', second);
    expect(commandOn('tab.rename')).toBe(true);
    expect(runCommand('tab.rename')).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    stopSecond();
    runCommand('tab.rename');
    expect(first).toHaveBeenCalledTimes(1);
    stopFirst();
    expect(commandOn('tab.rename')).toBe(false);
  });
});

describe('a key press', () => {
  it('is a command’s with the device’s command key: ⌘ on Apple’s, Ctrl elsewhere', () => {
    expect(keysOf(press('KeyD', { metaKey: true }), true)).toBe('Mod+D');
    expect(keysOf(press('KeyD', { metaKey: true, shiftKey: true }), true)).toBe('Mod+Shift+D');
    expect(keysOf(press('ArrowLeft', { metaKey: true, altKey: true }), true)).toBe('Mod+Alt+Left');
    expect(keysOf(press('BracketRight', { metaKey: true, shiftKey: true }), true)).toBe('Mod+Shift+]');
    expect(keysOf(press('Enter', { metaKey: true, shiftKey: true }), true)).toBe('Mod+Shift+Enter');
    expect(keysOf(press('Digit2', { ctrlKey: true }), false)).toBe('Mod+2');
  });

  it('isn’t one without it, or with the other, which is the terminal’s', () => {
    expect(keysOf(press('KeyD'), true)).toBeUndefined();
    expect(keysOf(press('KeyD', { ctrlKey: true }), true)).toBeUndefined();
    expect(keysOf(press('KeyC', { ctrlKey: true, metaKey: true }), true)).toBeUndefined();
    expect(keysOf(press('KeyD', { metaKey: true }), false)).toBeUndefined();
    expect(keysOf(press('F5', { metaKey: true }), true)).toBeUndefined();
  });

  it('reads as the device writes it', () => {
    expect(keysLabel('Mod+Shift+D', true)).toBe('⌘⇧D');
    expect(keysLabel('Mod+Alt+Left', true)).toBe('⌘⌥←');
    expect(keysLabel('Mod+Shift+Enter', true)).toBe('⌘⇧↩');
    expect(keysLabel('Mod+Shift+D', false)).toBe('Ctrl+Shift+D');
  });
});
