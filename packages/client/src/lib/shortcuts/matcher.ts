import { isAppleLikeShortcutPlatform, resolveShortcutPlatform } from './platform';
import type {
  LeaderShortcutMatch,
  NormalizedShortcutEvent,
  ShortcutBinding,
  ShortcutChord,
  ShortcutContext,
  ShortcutPlatform,
  ShortcutSurface,
} from './types';

const shortcutSurfaceAttribute = 'data-weave-surface';
const textSurfaceSelector = [
  'input',
  'textarea',
  '[contenteditable="true"]',
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
  event: NormalizedShortcutEvent,
  platform: ShortcutPlatform = resolveShortcutPlatform(),
  now = Date.now(),
): ShortcutContext => ({
  platform,
  target: event.target,
  activeSurface: getActiveShortcutSurface(event.target),
  isTextInputTarget: isTextInputShortcutTarget(event.target),
  now,
});

export const isShortcutAllowedForTarget = (binding: ShortcutBinding, context: Pick<ShortcutContext, 'isTextInputTarget'>) =>
  !context.isTextInputTarget || binding.reservedGlobal === true;

export const doesShortcutChordMatch = (
  chord: ShortcutChord,
  event: Pick<NormalizedShortcutEvent, 'key' | 'shift' | 'alt' | 'control' | 'meta'>,
  platform: ShortcutPlatform,
) => {
  const isAppleLike = isAppleLikeShortcutPlatform(platform);
  const expectedControl = Boolean(chord.control) || (!isAppleLike && Boolean(chord.mod));
  const expectedMeta = Boolean(chord.meta) || (isAppleLike && Boolean(chord.mod));

  return normalizeShortcutKey(chord.key) === event.key
    && event.shift === Boolean(chord.shift)
    && event.alt === Boolean(chord.alt)
    && event.control === expectedControl
    && event.meta === expectedMeta;
};

const doesSequenceStartWithEvents = (
  sequence: readonly ShortcutChord[],
  events: readonly NormalizedShortcutEvent[],
  platform: ShortcutPlatform,
) => {
  if (events.length > sequence.length) return false;
  return events.every((event, index) => doesShortcutChordMatch(sequence[index], event, platform));
};

export const findDirectShortcutBinding = (
  bindings: readonly ShortcutBinding[],
  event: NormalizedShortcutEvent,
  context: ShortcutContext,
) => bindings.find(binding =>
  binding.kind === 'direct'
  && binding.chord
  && isShortcutAllowedForTarget(binding, context)
  && doesShortcutChordMatch(binding.chord, event, context.platform),
);

export const findLeaderShortcutBinding = (
  bindings: readonly ShortcutBinding[],
  events: readonly NormalizedShortcutEvent[],
  context: ShortcutContext,
): LeaderShortcutMatch => {
  let hasPartialMatch = false;

  for (const binding of bindings) {
    if (binding.kind !== 'leader' || !binding.sequence || !isShortcutAllowedForTarget(binding, context)) continue;
    if (!doesSequenceStartWithEvents(binding.sequence, events, context.platform)) continue;
    if (binding.sequence.length === events.length) return { type: 'exact', binding };
    hasPartialMatch = true;
  }

  return hasPartialMatch ? { type: 'partial' } : { type: 'none' };
};
