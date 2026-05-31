import { describe, expect, it } from 'vitest';
import {
  auditShortcutBindingConflicts,
  createShortcutContext,
  defaultShortcutBindings,
  doesShortcutChordMatch,
  findDirectShortcutBinding,
  findLeaderShortcutBinding,
  inactiveShortcutLeaderState,
  normalizeKeyboardEvent,
  reduceShortcutLeaderKey,
  resolveShortcutPlatform,
  startShortcutLeader,
  type NormalizedShortcutEvent,
  type ShortcutBinding,
  type ShortcutChord,
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
}: Partial<Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'isComposing' | 'key' | 'metaKey' | 'repeat' | 'shiftKey' | 'target'>> = {}) =>
  normalizeKeyboardEvent({
    altKey,
    code,
    ctrlKey,
    isComposing,
    key,
    metaKey,
    repeat,
    shiftKey,
    target,
  } as KeyboardEvent);

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

const contextFor = (event: NormalizedShortcutEvent, now = 1_000) =>
  createShortcutContext(event, 'mac', now);

describe('shortcut matching', () => {
  it('resolves Mod to Command on Apple-like platforms and Control elsewhere', () => {
    const chord: ShortcutChord = { key: 'k', mod: true, shift: true };

    expect(doesShortcutChordMatch(chord, makeKeyEvent({ key: 'k', metaKey: true, shiftKey: true }), 'mac')).toBe(true);
    expect(doesShortcutChordMatch(chord, makeKeyEvent({ key: 'k', ctrlKey: true, shiftKey: true }), 'windows')).toBe(true);
    expect(doesShortcutChordMatch(chord, makeKeyEvent({ key: 'k', ctrlKey: true, shiftKey: true }), 'mac')).toBe(false);
  });

  it('normalizes KeyboardEvent.key without using deprecated keyCode', () => {
    const event = makeKeyEvent({ key: 'K', code: 'KeyK' });

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

  it('allows reserved globals inside text-heavy surfaces', () => {
    const target = makeTarget({ surface: 'chat', text: true });
    const event = makeKeyEvent({ key: 'k', metaKey: true, shiftKey: true, target });
    const binding = findDirectShortcutBinding(defaultShortcutBindings, event, contextFor(event));

    expect(binding?.commandId).toBe('shortcuts.open');
  });

  it('blocks non-reserved shortcuts inside text-heavy surfaces', () => {
    const target = makeTarget({ surface: 'chat', text: true });
    const event = makeKeyEvent({ key: 'b', metaKey: true, target });
    const bindings: ShortcutBinding[] = [{
      commandId: 'sidebar.toggle',
      kind: 'direct',
      chord: { key: 'b', mod: true },
    }];

    expect(findDirectShortcutBinding(bindings, event, contextFor(event))).toBeUndefined();
  });

  it('matches leader sequences', () => {
    const terminalToggle = makeKeyEvent({ key: 't' });
    const terminalExpand = makeKeyEvent({ key: 'T', shiftKey: true });

    expect(findLeaderShortcutBinding(defaultShortcutBindings, [terminalToggle], contextFor(terminalToggle))).toEqual({ type: 'exact', binding: expect.objectContaining({ commandId: 'terminal.toggle' }) });
    expect(findLeaderShortcutBinding(defaultShortcutBindings, [terminalExpand], contextFor(terminalExpand))).toEqual({ type: 'exact', binding: expect.objectContaining({ commandId: 'terminal.expandToggle' }) });
  });

  it('dismisses leader mode on valid keys and Escape without timing out', () => {
    const leader = startShortcutLeader();
    const exact = reduceShortcutLeaderKey({
      bindings: defaultShortcutBindings,
      context: contextFor(makeKeyEvent({ key: 'e' }), 1_100),
      event: makeKeyEvent({ key: 'e' }),
      state: leader,
    });
    expect(exact).toEqual({
      commandId: 'editor.toggle',
      consumed: true,
      state: inactiveShortcutLeaderState,
    });

    const stillOpenLater = reduceShortcutLeaderKey({
      bindings: defaultShortcutBindings,
      context: contextFor(makeKeyEvent({ key: 'z' }), 120_000),
      event: makeKeyEvent({ key: 'z' }),
      state: startShortcutLeader(),
    });
    expect(stillOpenLater.consumed).toBe(true);
    expect(stillOpenLater.state.active).toBe(true);
    expect(stillOpenLater.state.message).toBe('No command');

    const cancelled = reduceShortcutLeaderKey({
      bindings: defaultShortcutBindings,
      context: contextFor(makeKeyEvent({ key: 'Escape' }), 1_100),
      event: makeKeyEvent({ key: 'Escape' }),
      state: leader,
    });
    expect(cancelled).toEqual({ consumed: true, state: inactiveShortcutLeaderState });
  });

  it('flags high-risk direct bindings while leaving the default profile clean', () => {
    expect(auditShortcutBindingConflicts(defaultShortcutBindings)).toEqual([]);
    expect(auditShortcutBindingConflicts([{
      commandId: 'thread.new',
      kind: 'direct',
      chord: { key: 's', mod: true },
      reservedGlobal: true,
    }])).toEqual([expect.objectContaining({
      risk: 'high',
    })]);
  });
});
