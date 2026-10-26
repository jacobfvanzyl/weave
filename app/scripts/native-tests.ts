// Builds the native terminal's renderer and its tests for macOS, against the macOS slice of the
// same libghostty-vt the app links, and runs them (WVE-153).
//
//   bun scripts/native-tests.ts
//
// The renderer imports no UIKit, so it builds here as it does for iOS. With a holder built
// (`cargo build -p weave-holder`), the tests also check that its codec is the app's.
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const native = resolve(root, 'ios/App/Native');
const binary = resolve(native, 'renderer-tests');

const run = async (args: string[], env: Record<string, string> = {}) => {
  const child = Bun.spawn(args, { cwd: root, env: { ...process.env, ...env }, stdout: 'inherit', stderr: 'inherit' });
  if ((await child.exited) !== 0) process.exit(1);
};

await run(['bun', 'scripts/ghostty.ts']);
await run([
  'xcrun', 'clang++', '-std=c++17', '-fobjc-arc', '-O1', '-Wall', '-Wno-unused-function',
  '-I', resolve(native, 'include'), '-I', resolve(root, 'ios/App/App'),
  resolve(root, 'ios/App/App/WeaveTerminalRenderer.mm'),
  resolve(root, 'ios/App/Tests/WeaveTerminalRendererTests.mm'),
  resolve(native, 'ghostty-vt.xcframework/macos-arm64_x86_64/libghostty-vt.a'),
  '-framework', 'Foundation', '-framework', 'CoreText', '-framework', 'CoreGraphics',
  '-o', binary,
]);

const holder = resolve(root, '../target/debug/weave-holder');
let codec = '';
if (await stat(holder).then(() => true, () => false)) {
  const version = Bun.spawnSync([holder, '--version']).stdout.toString();
  codec = version.match(/\((ghostty .*)\)/)?.[1] ?? '';
}
await run([binary], { WEAVE_TERMINAL_FONTS: resolve(native, 'TerminalFonts'), WEAVE_HOLDER_CODEC: codec });
