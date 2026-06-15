import { assertEquals } from 'jsr:@std/assert@1.0.19';
import { generateUnifiedDiff } from './main.ts';

Deno.test('generateUnifiedDiff renders insertions without duplicate numbered context', () => {
  const oldContent = [
    'one',
    'two',
    'three',
    'four',
    'five',
    '',
    '[build]',
    '',
    '[processes]',
    "app = 'run --allow-net --allow-env --allow-read ./main.ts'",
    '',
  ].join('\n');
  const newContent = [
    'one',
    'two',
    'three',
    'four',
    'five',
    '',
    '[build]',
    '',
    '[env]',
    "GOTENBERG_URL = 'http://kp-gotenberg-staging.internal:3000'",
    '',
    '[processes]',
    "app = 'run --allow-net --allow-env --allow-read ./main.ts'",
    '',
  ].join('\n');

  assertEquals(
    generateUnifiedDiff(oldContent, newContent),
    [
      '@@ -6,6 +6,9 @@',
      ' ',
      ' [build]',
      ' ',
      '+[env]',
      "+GOTENBERG_URL = 'http://kp-gotenberg-staging.internal:3000'",
      '+',
      ' [processes]',
      " app = 'run --allow-net --allow-env --allow-read ./main.ts'",
      ' ',
    ].join('\n'),
  );
});

Deno.test('generateUnifiedDiff renders replacements and deletions as unified hunks', () => {
  assertEquals(
    generateUnifiedDiff('alpha\nbeta\ngamma\ndelta', 'alpha\nbravo\ndelta'),
    [
      '@@ -1,4 +1,3 @@',
      ' alpha',
      '-beta',
      '-gamma',
      '+bravo',
      ' delta',
    ].join('\n'),
  );
});
