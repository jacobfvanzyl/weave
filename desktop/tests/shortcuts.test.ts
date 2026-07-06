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
  isShortcutCommandEnabled,
  isShortcutCommandVisible,
  normalizeKeyboardEvent,
  resolveShortcutCommandLabel,
  resolveShortcutPlatform,
  shortcutLeaderHotkey,
  type ShortcutBinding,
  type ShortcutCommand,
  type ShortcutHotkey,
  type ShortcutSurface,
} from '@weave/client/lib/shortcuts';
import {
  getStateAwarePaneShortcutLabel,
  runStateAwarePaneShortcut,
} from '../../packages/client/src/components/app-shell/useAppShortcuts';

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
    expect(doesShortcutHotkeyMatch(shortcutLeaderHotkey, makeKeyEvent({ key: 'k', metaKey: true }), 'mac')).toBe(true);
    expect(doesShortcutHotkeyMatch(shortcutLeaderHotkey, makeKeyEvent({ key: 'k', ctrlKey: true }), 'windows')).toBe(true);
    expect(doesShortcutHotkeyMatch(shortcutLeaderHotkey, makeKeyEvent({ key: 'k', ctrlKey: true }), 'mac')).toBe(false);
    expect(doesShortcutHotkeyMatch(shortcutLeaderHotkey, makeKeyEvent({ key: 'k', metaKey: true, shiftKey: true }), 'mac')).toBe(false);
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
    const event = makeKeyEvent({ key: 'k', metaKey: true, target });
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

    expect(formatShortcutForDisplay(shortcutLeaderHotkey, 'windows')).toBe('Ctrl+K');
    expect(macDisplay).toContain('K');
    expect(macDisplay.includes('Mod')).toBe(false);
    expect(formatShortcutSequenceForDisplay([shortcutLeaderHotkey, ';'], 'windows')).toBe('Ctrl+K ;');
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

  it('resolves dynamic shortcut command labels from the active DOM surface', () => {
    const target = makeTarget({ surface: 'sidebar' });
    const context = contextFor(makeKeyEvent({ target }));

    expect(resolveShortcutCommandLabel({
      id: 'terminal.toggle',
      label: labelContext => labelContext.activeSurface === 'sidebar' ? 'Focus terminal pane' : 'Toggle terminal pane',
      surface: 'terminal',
      run: () => undefined,
    }, context)).toBe('Focus terminal pane');
  });

  it('treats invisible shortcut commands as hidden and unavailable', () => {
    const editorContext = contextFor(makeKeyEvent({ target: makeTarget({ surface: 'editor' }) }));
    const chatContext = contextFor(makeKeyEvent({ target: makeTarget({ surface: 'chat' }) }));
    const command: ShortcutCommand = {
      id: 'editor.expandToggle' as const,
      label: 'Expand editor pane',
      surface: 'editor' as const,
      isEnabled: () => true,
      isVisible: context => context.activeSurface === 'editor',
      run: () => undefined,
    };

    expect(isShortcutCommandVisible(command, editorContext)).toBe(true);
    expect(isShortcutCommandEnabled(command, editorContext)).toBe(true);
    expect(isShortcutCommandVisible(command, chatContext)).toBe(false);
    expect(isShortcutCommandEnabled(command, chatContext)).toBe(false);
  });

  it('labels open pane shortcuts as focus until that pane owns keyboard focus', () => {
    expect(getStateAwarePaneShortcutLabel(
      { activeSurface: 'chat' },
      {
        focusLabel: 'Focus terminal pane',
        isOpen: true,
        surface: 'terminal',
        toggleLabel: 'Toggle terminal pane',
      },
    )).toBe('Focus terminal pane');

    expect(getStateAwarePaneShortcutLabel(
      { activeSurface: 'terminal' },
      {
        focusLabel: 'Focus terminal pane',
        isOpen: true,
        surface: 'terminal',
        toggleLabel: 'Toggle terminal pane',
      },
    )).toBe('Toggle terminal pane');

    expect(getStateAwarePaneShortcutLabel(
      { activeSurface: 'editor' },
      {
        focusLabel: 'Focus chat',
        isOpen: false,
        surface: 'chat',
        toggleLabel: 'Toggle chat pane',
      },
    )).toBe('Toggle chat pane');
  });

  it('runs focus for open unfocused panes and toggle for closed or focused panes', () => {
    const calls: string[] = [];
    const input = {
      focus: () => calls.push('focus'),
      focusLabel: 'Focus editor pane',
      isOpen: true,
      surface: 'editor' as const,
      toggle: () => calls.push('toggle'),
      toggleLabel: 'Toggle editor pane',
    };

    runStateAwarePaneShortcut({ activeSurface: 'chat' }, input);
    runStateAwarePaneShortcut({ activeSurface: 'editor' }, input);
    runStateAwarePaneShortcut({ activeSurface: 'chat' }, { ...input, isOpen: false });

    expect(calls).toEqual(['focus', 'toggle', 'toggle']);
  });
});
