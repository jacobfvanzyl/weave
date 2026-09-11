import './prepare-native-terminal';
import { resolve, join } from 'node:path';
import { cp, mkdtemp } from 'node:fs/promises';
const root = resolve(import.meta.dir, '..');
const evidence = await mkdtemp('/tmp/weave-native-renderer-');
const native = join(root, 'native/.build/macos');
const run = async (command: string[]) => {
  const child = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`Renderer probe failed: ${command[0]}`);
};
await run(['xcrun', 'clang++', '-std=c++17', '-fobjc-arc', '-fmodules', '-I', join(native, 'include'),
  join(root, 'native/ghostty/WeaveTerminalRenderer.mm'), join(root, 'native/ghostty/renderer-probe.mm'), join(native, 'lib/libghostty-vt.a'),
  '-framework', 'Foundation', '-framework', 'CoreGraphics', '-framework', 'CoreText', '-framework', 'ImageIO', '-framework', 'UniformTypeIdentifiers', '-o', join(evidence, 'probe')]);
await cp(join(root, 'src/assets/fonts/TerminalFonts'), join(evidence, 'TerminalFonts'), { recursive: true });
await run([join(evidence, 'probe'), join(evidence, 'renderer.png')]);
console.log(`Evidence: ${evidence}`);
