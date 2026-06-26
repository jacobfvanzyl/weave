import { matchesKeyboardEvent, parseHotkey } from '@tanstack/react-hotkeys';
import { resolveShortcutPlatform, toTanStackShortcutPlatform } from './platform';
import type {
  NormalizedShortcutEvent,
  ShortcutBinding,
  ShortcutContext,
  ShortcutHotkey,
  ShortcutPlatform,
  ShortcutSurface,
} from './types';

const shortcutSurfaceAttribute = 'data-weave-surface';
const textSurfaceSelector = [
  'input:not([type="button"]):not([type="submit"]):not([type="reset"])',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[data-weave-text-surface="true"]',
  '.cm-editor',
  '.cm-content',
].join(',');

const modifierKeys = new Set(['alt', 'control', 'ctrl', 'meta', 'os', 'shift', 'command']);

type ClosestCapableTarget = {
  closest: (selector: string) => Element | null;
};

const canUseClosest = (target: EventTarget | null): target is EventTarget & ClosestCapableTarget =>
  Boolean(target && typeof (target as Partial<ClosestCapableTarget>).closest === 'function');

export const normalizeShortcutKey = (key: string) => {
  if (key === ' ') return 'space';
  if (key === 'Esc') return 'escape';
  if (key.length === 1) return key.toLowerCase();
  return key.toLowerCase();
};

export const isModifierOnlyShortcutKey = (event: Pick<NormalizedShortcutEvent, 'key'>) =>
  modifierKeys.has(normalizeShortcutKey(event.key));

export const normalizeKeyboardEvent = (
  event: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'repeat' | 'isComposing' | 'target'>,
): NormalizedShortcutEvent => ({
  key: normalizeShortcutKey(event.key),
  code: event.code,
  shift: event.shiftKey,
  alt: event.altKey,
  control: event.ctrlKey,
  meta: event.metaKey,
  repeat: event.repeat,
  isComposing: event.isComposing,
  target: event.target,
});

export const isTextInputShortcutTarget = (target: EventTarget | null) => {
  if (!canUseClosest(target)) return false;
  return Boolean(target.closest(textSurfaceSelector));
};

export const getActiveShortcutSurface = (target: EventTarget | null): ShortcutSurface | undefined => {
  if (!canUseClosest(target)) return undefined;
  const surface = target.closest(`[${shortcutSurfaceAttribute}]`)?.getAttribute(shortcutSurfaceAttribute);
  if (
    surface === 'app'
    || surface === 'sidebar'
    || surface === 'chat'
    || surface === 'plan'
    || surface === 'terminal'
    || surface === 'editor'
  ) {
    return surface;
  }
  return undefined;
};

export const createShortcutContext = (
  event: Pick<KeyboardEvent, 'target'> | NormalizedShortcutEvent,
  platform: ShortcutPlatform = resolveShortcutPlatform(),
  now = Date.now(),
): ShortcutContext => ({
  platform,
  tanStackPlatform: toTanStackShortcutPlatform(platform),
  target: event.target,
  activeSurface: getActiveShortcutSurface(event.target),
  isTextInputTarget: isTextInputShortcutTarget(event.target),
  now,
});

export const isShortcutAllowedForTarget = (binding: ShortcutBinding, context: Pick<ShortcutContext, 'isTextInputTarget'>) =>
  !context.isTextInputTarget || binding.allowInInputs === true;

export const doesShortcutHotkeyMatch = (
  hotkey: ShortcutHotkey,
  event: KeyboardEvent,
  platform: ShortcutPlatform = resolveShortcutPlatform(),
) => matchesKeyboardEvent(
  event,
  parseHotkey(hotkey, toTanStackShortcutPlatform(platform)),
  toTanStackShortcutPlatform(platform),
);

export const findHotkeyShortcutBinding = (
  bindings: readonly ShortcutBinding[],
  event: KeyboardEvent,
  context: ShortcutContext,
) => bindings.find(binding =>
  binding.kind === 'hotkey'
  && binding.hotkey
  && isShortcutAllowedForTarget(binding, context)
  && doesShortcutHotkeyMatch(binding.hotkey, event, context.platform),
);

export const findSequenceTailShortcutBinding = (
  bindings: readonly ShortcutBinding[],
  leaderHotkey: ShortcutHotkey,
  event: KeyboardEvent,
  context: ShortcutContext,
) => bindings.find(binding =>
  binding.kind === 'sequence'
  && binding.sequence?.length === 2
  && binding.sequence[0] === leaderHotkey
  && isShortcutAllowedForTarget(binding, context)
  && doesShortcutHotkeyMatch(binding.sequence[1], event, context.platform),
);
