import './prepare-native-terminal';
import { prepareNodeApiHeaders } from '../../scripts/native-headers';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const manifest = await Bun.file(join(root, 'package.json')).json();
const headers = await prepareNodeApiHeaders(manifest.devDependencies.electron);
const run = async (command: string[]) => {
  const child = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`Native build failed: ${command[0]}`);
};
const native = join(root, 'native/.build/macos');
await run(['xcrun', 'clang++', '-std=c++17', `-DWEAVE_ACCEPTANCE=${process.env.VITE_ALPHA_ACCEPTANCE === '1' ? 1 : 0}`,  '-fobjc-arc', '-fmodules', '-shared', '-undefined', 'dynamic_lookup',
  '-I', headers, '-I', join(native, 'include'),
  join(root, 'native/ghostty/WeaveTerminalRenderer.mm'), join(root, 'native/ghostty/electron-terminal.mm'),
  join(native, 'lib/libghostty-vt.a'), '-framework', 'AppKit', '-framework', 'CoreText', '-o', join(native, 'weave-terminal.node')]);
