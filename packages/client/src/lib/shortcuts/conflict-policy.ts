import type { ShortcutBinding, ShortcutHotkey } from './types';

export type ShortcutConflictRisk = 'medium' | 'high';

export type ShortcutConflict = {
  binding: ShortcutBinding;
  risk: ShortcutConflictRisk;
  reason: string;
};

const highRiskDirectHotkeySignatures = new Set([
  'mod+a',
  'mod+c',
  'mod+d',
  'mod+f',
  'mod+h',
  'mod+l',
  'mod+n',
  'mod+o',
  'mod+p',
  'mod+q',
  'mod+r',
  'mod+s',
  'mod+t',
  'mod+u',
  'mod+v',
  'mod+w',
  'mod+x',
  'mod+y',
  'mod+z',
  'mod+shift+n',
  'mod+shift+r',
  'mod+shift+t',
  'mod+shift+w',
  'mod+space',
  'mod+tab',
  'control+space',
  'control+tab',
]);

const modifierAliases: Record<string, string> = {
  cmd: 'meta',
  command: 'meta',
  commandorcontrol: 'mod',
  control: 'control',
  ctrl: 'control',
  meta: 'meta',
  mod: 'mod',
  option: 'alt',
};

const modifierOrder = ['control', 'alt', 'shift', 'meta', 'mod'];

export const getShortcutHotkeySignature = (hotkey: ShortcutHotkey) => {
  const parts = hotkey.split('+').map(part => modifierAliases[part.toLowerCase()] ?? part.toLowerCase());
  const key = parts.at(-1) ?? '';
  const modifiers = parts.slice(0, -1).sort((a, b) => modifierOrder.indexOf(a) - modifierOrder.indexOf(b));
  return [...modifiers, key].join('+');
};

const isFunctionKey = (key: string) => /^f\d{1,2}$/i.test(key);
const isArrowKey = (key: string) => /^arrow/i.test(key);

export const auditShortcutBindingConflicts = (bindings: readonly ShortcutBinding[]): ShortcutConflict[] => {
  const conflicts: ShortcutConflict[] = [];

  for (const binding of bindings) {
    if (binding.kind !== 'hotkey' || !binding.hotkey) continue;

    const signature = getShortcutHotkeySignature(binding.hotkey);
    const parts = signature.split('+');
    const key = parts.at(-1) ?? '';
    const hasAlt = parts.includes('alt');
    const hasControl = parts.includes('control');
    const hasMeta = parts.includes('meta');
    const hasMod = parts.includes('mod');

    if (highRiskDirectHotkeySignatures.has(signature)) {
      conflicts.push({ binding, risk: 'high', reason: `${signature} is commonly reserved by browsers, operating systems, or text editing.` });
      continue;
    }

    if (hasAlt && !hasMod && !hasMeta) {
      conflicts.push({ binding, risk: 'high', reason: 'Raw Alt/Option shortcuts are likely to conflict with browser or OS menu behavior.' });
      continue;
    }

    if (hasControl && !hasMod && !hasMeta) {
      conflicts.push({ binding, risk: 'medium', reason: 'Raw Control shortcuts are used heavily by accessibility, focus, terminal, and text systems.' });
      continue;
    }

    if (isFunctionKey(key) || isArrowKey(key)) {
      conflicts.push({ binding, risk: 'medium', reason: 'Function and arrow keys are frequently intercepted by browsers, systems, or focused controls.' });
    }
  }

  return conflicts;
};
