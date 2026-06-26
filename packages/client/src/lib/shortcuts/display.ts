import { formatForDisplay, formatHotkeySequence } from '@tanstack/react-hotkeys';
import { resolveShortcutPlatform, toTanStackShortcutPlatform } from './platform';
import type { ShortcutHotkey, ShortcutPlatform, ShortcutSequence } from './types';

const displayKeyLabelReplacements: Record<string, string> = {
  Backquote: '`',
  Backslash: '\\',
  Comma: ',',
  Equal: '=',
  'Left Bracket': '[',
  Minus: '-',
  Period: '.',
  'Right Bracket': ']',
  Semicolon: ';',
};

const replaceDisplayKeyLabels = (value: string) =>
  Object.entries(displayKeyLabelReplacements).reduce(
    (displayValue, [label, key]) => displayValue.split(label).join(key),
    value,
  );

export const formatShortcutForDisplay = (
  hotkey: ShortcutHotkey,
  platform: ShortcutPlatform = resolveShortcutPlatform(),
) => replaceDisplayKeyLabels(formatForDisplay(
  hotkey,
  {
    platform: toTanStackShortcutPlatform(platform),
    useSymbols: platform === 'mac' || platform === 'ios',
  },
));

export const formatShortcutSequenceForDisplay = (
  sequence: ShortcutSequence,
  platform: ShortcutPlatform = resolveShortcutPlatform(),
) => sequence.map(hotkey => formatShortcutForDisplay(hotkey, platform)).join(' ');

export const formatShortcutSequenceSignature = (sequence: ShortcutSequence) =>
  formatHotkeySequence([...sequence]);

export const formatShortcutForDisplayParts = (
  hotkey: ShortcutHotkey,
  platform: ShortcutPlatform = resolveShortcutPlatform(),
) => {
  const useSymbols = platform === 'mac' || platform === 'ios';
  return replaceDisplayKeyLabels(formatForDisplay(
    hotkey,
    {
      platform: toTanStackShortcutPlatform(platform),
      separatorToken: useSymbols ? ' ' : '+',
      useSymbols,
    },
  )).split(useSymbols ? ' ' : '+').filter(Boolean);
};
