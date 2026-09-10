import './prepare-native-terminal';
import { mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const manifest = await Bun.file(join(root, 'package.json')).json();
const version: string = manifest.devDependencies.electron;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Electron headers require an exact version.');
const cache = join(homedir(), '.cache/weave/electron-headers', version);
const header = join(cache, 'node_headers/include/node/node_api.h');
const run = async (command: string[]) => {
  const child = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`Native build failed: ${command[0]}`);
};
if (!await Bun.file(header).exists()) {
  await mkdir(cache, { recursive: true });
  const base = `https://artifacts.electronjs.org/headers/dist/v${version}`;
  const name = `node-v${version}-headers.tar.gz`;
  const [archive, checksums] = await Promise.all([fetch(`${base}/${name}`), fetch(`${base}/SHASUMS256.txt`)]);
  if (!archive.ok || !checksums.ok) throw new Error('Pinned Electron headers could not be downloaded.');
  const bytes = new Uint8Array(await archive.arrayBuffer());
  const expected = (await checksums.text()).split('\n').find((line) => line.trim().endsWith(` ${name}`))?.split(/\s+/)[0];
  if (!expected || new Bun.CryptoHasher('sha256').update(bytes).digest('hex') !== expected) throw new Error('Electron header checksum mismatch.');
  const tar = join(cache, 'verified-headers.tar.gz');
  await Bun.write(tar, bytes);
  const stage = join(cache, `extract-${process.pid}`);
  await mkdir(stage, { recursive: true });
  try {
    await run(['tar', '-xzf', tar, '-C', stage]);
    await rename(join(stage, 'node_headers'), join(cache, 'node_headers'));
  } finally { await rm(stage, { recursive: true, force: true }); }
}
const native = join(root, 'native/.build/macos');
await run(['xcrun', 'clang++', '-std=c++17', `-DWEAVE_ACCEPTANCE=${process.env.VITE_ALPHA_ACCEPTANCE === '1' ? 1 : 0}`,  '-fobjc-arc', '-fmodules', '-shared', '-undefined', 'dynamic_lookup',
  '-I', join(cache, 'node_headers/include/node'), '-I', join(native, 'include'),
  join(root, 'native/ghostty/WeaveTerminalRenderer.mm'), join(root, 'native/ghostty/electron-terminal.mm'),
  join(native, 'lib/libghostty-vt.a'), '-framework', 'AppKit', '-framework', 'CoreText', '-o', join(native, 'weave-terminal.node')]);
