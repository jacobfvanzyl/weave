import { describe, expect, it } from 'vitest';
import {
  auditShortcutBindingConflicts,
  createShortcutContext,
  defaultShortcutBindings,
  doesShortcutHotkeyMatch,
  findHotkeyShortcutBinding,
  findSequenceTailShortcutBinding,
  formatShortcutForDisplay,
  formatShortcutSequenceForDisplay,
  getShortcutHotkeySignature,
  normalizeKeyboardEvent,
  resolveShortcutPlatform,
  shortcutLeaderHotkey,
  type ShortcutBinding,
  type ShortcutHotkey,
  type ShortcutSurface,
} from '@weave/client/lib/shortcuts';

const makeKeyEvent = ({
  altKey = false,
  code = 'KeyK',
  ctrlKey = false,
  isComposing = false,
  key = 'k',
  metaKey = false,
  repeat = false,
  shiftKey = false,
  target = null,
}: Partial<Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'isComposing' | 'key' | 'metaKey' | 'repeat' | 'shiftKey' | 'target'>> = {}) => ({
  altKey,
  code,
  ctrlKey,
  isComposing,
  key,
  metaKey,
  repeat,
  shiftKey,
  target,
}) as KeyboardEvent;

const makeTarget = ({ surface, text }: { surface?: ShortcutSurface; text?: boolean }) => ({
  closest: (selector: string) => {
    if (selector === '[data-weave-surface]' && surface) {
      return { getAttribute: () => surface };
    }
    if (text && selector.includes('[data-weave-text-surface="true"]')) {
      return {};
    }
    return null;
  },
}) as unknown as EventTarget;

const contextFor = (event: KeyboardEvent, now = 1_000) =>
  createShortcutContext(event, 'mac', now);

describe('shortcut matching', () => {
  it('resolves Mod to Command on Apple-like platforms and Control elsewhere', () => {
    expect(doesShortcutHotkeyMatch(shortcutLeaderHotkey, makeKeyEvent({ key: 'k', metaKey: true, shiftKey: true }), 'mac')).toBe(true);
    expect(doesShortcutHotkeyMatch(shortcutLeaderHotkey, makeKeyEvent({ key: 'k', ctrlKey: true, shiftKey: true }), 'windows')).toBe(true);
    expect(doesShortcutHotkeyMatch(shortcutLeaderHotkey, makeKeyEvent({ key: 'k', ctrlKey: true, shiftKey: true }), 'mac')).toBe(false);
  });

  it('normalizes KeyboardEvent.key without using deprecated keyCode', () => {
    const event = normalizeKeyboardEvent(makeKeyEvent({ key: 'K', code: 'KeyK' }));

    expect(event).toMatchObject({
      key: 'k',
      code: 'KeyK',
    });
    expect('keyCode' in event).toBe(false);
  });

  it('detects Apple-like iPad hardware keyboard platforms', () => {
    expect(resolveShortcutPlatform({
      platform: 'MacIntel',
      userAgent: 'Version/18.0 Mobile/15E148 Safari/604.1',
      maxTouchPoints: 5,
    })).toBe('ios');
  });

  it('allows explicitly intended leader shortcuts inside text-heavy surfaces', () => {
    const target = makeTarget({ surface: 'chat', text: true });
    const event = makeKeyEvent({ key: 'k', metaKey: true, shiftKey: true, target });
    const binding = findHotkeyShortcutBinding(defaultShortcutBindings, event, contextFor(event));

    expect(binding?.commandId).toBe('shortcuts.open');
  });

  it('blocks non-allowed hotkeys inside text-heavy surfaces', () => {
    const target = makeTarget({ surface: 'chat', text: true });
    const event = makeKeyEvent({ key: 'b', metaKey: true, target });
    const bindings: ShortcutBinding[] = [{
      commandId: 'sidebar.toggle',
      kind: 'hotkey',
      hotkey: 'Mod+B' satisfies ShortcutHotkey,
    }];

    expect(findHotkeyShortcutBinding(bindings, event, contextFor(event))).toBeUndefined();
  });

  it('matches leader semicolon for the global terminal inside text-heavy surfaces', () => {
    const textTarget = makeTarget({ surface: 'chat', text: true });
    const textEvent = makeKeyEvent({ key: ';', code: 'Semicolon', target: textTarget });

    expect(findHotkeyShortcutBinding(defaultShortcutBindings, textEvent, contextFor(textEvent))).toBeUndefined();
    expect(findSequenceTailShortcutBinding(defaultShortcutBindings, shortcutLeaderHotkey, textEvent, contextFor(textEvent))).toEqual(
      expect.objectContaining({ commandId: 'terminal.globalToggle' }),
    );
  });

  it('matches leader sequence tails', () => {
    const terminalToggle = makeKeyEvent({ key: 't' });
    const terminalExpand = makeKeyEvent({ key: 'T', shiftKey: true });

    expect(findSequenceTailShortcutBinding(defaultShortcutBindings, shortcutLeaderHotkey, terminalToggle, contextFor(terminalToggle))).toEqual(
      expect.objectContaining({ commandId: 'terminal.toggle' }),
    );
    expect(findSequenceTailShortcutBinding(defaultShortcutBindings, shortcutLeaderHotkey, terminalExpand, contextFor(terminalExpand))).toEqual(
      expect.objectContaining({ commandId: 'terminal.expandToggle' }),
    );
  });

  it('formats shortcuts through TanStack display helpers', () => {
    const macDisplay = formatShortcutForDisplay(shortcutLeaderHotkey, 'mac');

    expect(formatShortcutForDisplay(shortcutLeaderHotkey, 'windows')).toBe('Ctrl+Shift+K');
    expect(macDisplay).toContain('K');
    expect(macDisplay.includes('Mod')).toBe(false);
    expect(formatShortcutSequenceForDisplay([shortcutLeaderHotkey, ';'], 'windows')).toBe('Ctrl+Shift+K ;');
  });

  it('flags high-risk direct hotkeys while leaving the default profile clean', () => {
    expect(auditShortcutBindingConflicts(defaultShortcutBindings)).toEqual([]);
    expect(getShortcutHotkeySignature('Control+S')).toBe('control+s');
    expect(auditShortcutBindingConflicts([{
      commandId: 'thread.new',
      kind: 'hotkey',
      hotkey: 'Mod+S',
      allowInInputs: true,
    }])).toEqual([expect.objectContaining({
      risk: 'high',
    })]);
  });
});
