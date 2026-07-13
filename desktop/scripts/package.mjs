import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const forgeCli = path.join(desktopRoot, 'node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge.js');
const majorVersion = executable => {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  const match = result.stdout.trim().match(/^v?(\d+)/);
  return match ? Number(match[1]) : undefined;
};
const candidates = [
  process.env.WEAVE_DESKTOP_NODE_BIN,
  process.execPath,
  '/opt/homebrew/opt/node@25/bin/node',
  '/opt/homebrew/opt/node@24/bin/node',
  '/usr/local/opt/node@25/bin/node',
  '/usr/local/opt/node@24/bin/node',
].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
const node = candidates.find(candidate => existsSync(candidate) && (majorVersion(candidate) ?? 99) < 26);
if (!node) {
  throw new Error('Electron Forge packaging requires Node 24 or 25. Set WEAVE_DESKTOP_NODE_BIN to a compatible Node executable.');
}

const result = spawnSync(node, [forgeCli, 'package'], {
  cwd: desktopRoot,
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const output = path.join(desktopRoot, 'out', `Weave-${process.platform}-${process.arch}`, 'Weave.app');
if (process.platform === 'darwin' && !existsSync(output)) {
  throw new Error(`Electron Forge exited without producing ${output}.`);
}
