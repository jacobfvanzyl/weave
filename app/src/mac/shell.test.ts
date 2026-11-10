import { describe, expect, it } from 'vitest';
import { COMMANDS } from '@/app/commands';
import { accelerator, menuGroups } from './shell';

describe("the Mac's menu bar", () => {
  it('lists every command of the app, a menu for each group, in the table’s order', () => {
    const groups = menuGroups();
    expect(groups.map(({ title }) => title)).toEqual(['Session', 'Tab', 'Block', 'Go']);
    expect(groups.flatMap(({ items }) => items.map(({ id }) => id)).sort()).toEqual(COMMANDS.map(({ id }) => id).sort());
    expect(groups[2].items.slice(0, 2)).toEqual([
      { id: 'block.splitRight', title: 'Split Right', accelerator: 'CmdOrCtrl+D' },
      { id: 'block.splitDown', title: 'Split Down', accelerator: 'CmdOrCtrl+Shift+D' },
    ]);
    // A command without a key is listed without one.
    expect(groups[1].items.find(({ id }) => id === 'tab.rename')).toEqual({ id: 'tab.rename', title: 'Rename Tab…' });
  });

  it('spells a command’s key as the menu bar takes it', () => {
    expect(accelerator('Mod+Alt+Left')).toBe('CmdOrCtrl+Alt+Left');
    expect(accelerator('Mod+Shift+]')).toBe('CmdOrCtrl+Shift+]');
    expect(accelerator('Mod+Shift+Enter')).toBe('CmdOrCtrl+Shift+Enter');
  });
});
