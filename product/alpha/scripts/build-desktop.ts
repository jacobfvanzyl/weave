import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { packager } from '@electron/packager';
const root = resolve(import.meta.dir, '..');
if (process.platform !== 'darwin') throw new Error('The supported Alpha desktop target is macOS.');
if (process.arch !== 'arm64' && process.arch !== 'x64') throw new Error('Unsupported macOS architecture.');
const stage = resolve(root, '.electron');
const run = async (command: string[]) => {
  const child = Bun.spawn(command, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`Failed: ${command.join(' ')}`);
};
await run(['bun', 'run', 'build']);
await run(['bun', 'run', 'check:desktop']);
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const [entry, name, format] of [['main', 'main.mjs', 'esm'], ['preload', 'preload.cjs', 'cjs']] as const) {
  const result = await Bun.build({ entrypoints: [resolve(root, 'electron', `${entry}.ts`)], outdir: stage, naming: name, target: 'node', format, external: ['electron'], define: { ALPHA_ACCEPTANCE: JSON.stringify(process.env.VITE_ALPHA_ACCEPTANCE === '1') } });
  if (!result.success) throw new AggregateError(result.logs, 'Electron build failed');
}
const manifest = await Bun.file(resolve(root, 'package.json')).json();
await writeFile(resolve(stage, 'package.json'), JSON.stringify({ name: 'weave-alpha', productName: 'Weave Alpha', version: manifest.version, main: 'main.mjs', type: 'module', private: true }));
await cp(resolve(root, 'dist'), resolve(stage, 'web'), { recursive: true });
if (process.argv.includes('--dev')) {
  await run(['bun', 'run', 'electron', stage]);
} else {
  const identity = process.env.WEAVE_ALPHA_CODESIGN_IDENTITY?.trim();
  const paths = await packager({
    dir: stage, out: resolve(root, 'release'), name: 'Weave Alpha', platform: 'darwin', arch: process.arch,
    electronVersion: manifest.devDependencies.electron, appBundleId: 'com.veezee.alpha.macos',
    appVersion: manifest.version, overwrite: true, asar: true, prune: false,
    ...(identity ? { osxSign: { identity, optionsForFile: () => ({ hardenedRuntime: false }) } } : {}),
  });
  console.log(paths.join('\n'));
}
