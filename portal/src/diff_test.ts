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

Deno.test('generateUnifiedDiff splits distant changes into separate hunks', () => {
  const oldLines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  const newLines = [...oldLines];
  newLines[3] = 'line 4 changed';
  newLines[25] = 'line 26 changed';

  assertEquals(
    generateUnifiedDiff(oldLines.join('\n'), newLines.join('\n')),
    [
      '@@ -1,7 +1,7 @@',
      ' line 1',
      ' line 2',
      ' line 3',
      '-line 4',
      '+line 4 changed',
      ' line 5',
      ' line 6',
      ' line 7',
      '@@ -23,7 +23,7 @@',
      ' line 23',
      ' line 24',
      ' line 25',
      '-line 26',
      '+line 26 changed',
      ' line 27',
      ' line 28',
      ' line 29',
    ].join('\n'),
  );
});
