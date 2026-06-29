import { describe, expect, it } from 'vitest';
import { parseUnifiedDiffForPreview } from '../../packages/client/src/components/proposals/DiffViewer';

describe('DiffViewer helpers', () => {
  it('converts unified diff hunks into before and after buffers', () => {
    const parsed = parseUnifiedDiffForPreview([
      'diff --git a/src/app.dart b/src/app.dart',
      '--- a/src/app.dart',
      '+++ b/src/app.dart',
      '@@ -1,4 +1,5 @@',
      ' import a;',
      '-import old;',
      '+import new;',
      ' void main() {',
      '+  runApp(App());',
      ' }',
    ].join('\n'));

    expect(parsed.originalText).toBe([
      'import a;',
      'import old;',
      'void main() {',
      '}',
    ].join('\n'));
    expect(parsed.proposedText).toBe([
      'import a;',
      'import new;',
      'void main() {',
      '  runApp(App());',
      '}',
    ].join('\n'));
  });

  it('inserts separator markers between unified diff hunks', () => {
    const parsed = parseUnifiedDiffForPreview([
      'diff --git a/src/app.dart b/src/app.dart',
      '--- a/src/app.dart',
      '+++ b/src/app.dart',
      '@@ -1,2 +1,2 @@',
      ' one',
      '-two',
      '+deux',
      '@@ -20,2 +20,3 @@',
      ' twenty',
      '+twenty one',
      ' twenty two',
    ].join('\n'));

    expect(parsed.proposedText).toBe([
      'one',
      'deux',
      '// ---- 17 unchanged lines hidden ----',
      'twenty',
      'twenty one',
      'twenty two',
    ].join('\n'));
    expect(parsed.originalText).toContain('// ---- 17 unchanged lines hidden ----');
  });
});
