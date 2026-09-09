import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  runMacosBrowserAcceptance,
  runMacosBrowserRestartAcceptance,
} from './run-macos';

const option = (name: string) => {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
};

const output = resolve(
  option('--output') ??
    `acceptance/evidence/macos-${new Date().toISOString().replaceAll(':', '-')}`,
);
mkdirSync(output, { recursive: true });

const right = await runMacosBrowserAcceptance({
  dock: 'right',
  evidenceDirectory: resolve(output, 'right'),
});
const bottom = await runMacosBrowserAcceptance({
  dock: 'bottom',
  evidenceDirectory: resolve(output, 'bottom'),
});
const restart = await runMacosBrowserRestartAcceptance(resolve(output, 'restart'));

console.log(JSON.stringify({ bottom: bottom.report, output, restart, right: right.report }, null, 2));
