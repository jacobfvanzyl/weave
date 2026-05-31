import type { ShortcutBinding, ShortcutChord } from './types';

export type ShortcutConflictRisk = 'medium' | 'high';

export type ShortcutConflict = {
  binding: ShortcutBinding;
  risk: ShortcutConflictRisk;
  reason: string;
};

const highRiskDirectChordSignatures = new Set([
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

export const getShortcutChordSignature = (chord: ShortcutChord) => [
  chord.control ? 'control' : undefined,
  chord.alt ? 'alt' : undefined,
  chord.shift ? 'shift' : undefined,
  chord.meta ? 'meta' : undefined,
  chord.mod ? 'mod' : undefined,
  chord.key.toLowerCase(),
].filter(Boolean).join('+');

const isFunctionKey = (key: string) => /^f\d{1,2}$/i.test(key);
const isArrowKey = (key: string) => /^arrow/i.test(key);

export const auditShortcutBindingConflicts = (bindings: readonly ShortcutBinding[]): ShortcutConflict[] => {
  const conflicts: ShortcutConflict[] = [];

  for (const binding of bindings) {
    if (binding.kind !== 'direct' || !binding.chord) continue;

    const signature = getShortcutChordSignature(binding.chord);
    if (highRiskDirectChordSignatures.has(signature)) {
      conflicts.push({ binding, risk: 'high', reason: `${signature} is commonly reserved by browsers, operating systems, or text editing.` });
      continue;
    }

    if (binding.chord.alt && !binding.chord.mod && !binding.chord.meta) {
      conflicts.push({ binding, risk: 'high', reason: 'Raw Alt/Option shortcuts are likely to conflict with browser or OS menu behavior.' });
      continue;
    }

    if (binding.chord.control && !binding.chord.mod && !binding.chord.meta) {
      conflicts.push({ binding, risk: 'medium', reason: 'Raw Control shortcuts are used heavily by accessibility, focus, terminal, and text systems.' });
      continue;
    }

    if (isFunctionKey(binding.chord.key) || isArrowKey(binding.chord.key)) {
      conflicts.push({ binding, risk: 'medium', reason: 'Function and arrow keys are frequently intercepted by browsers, systems, or focused controls.' });
    }
  }

  return conflicts;
};
