import './prepare-native-terminal';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const output = await mkdtemp('/tmp/weave-renderer-benchmark-');
const source = process.env.WEAVE_RENDERER_BASELINE ?? join(root, 'native/ghostty/WeaveTerminalRenderer.mm');
const binary = join(output, 'benchmark');
const library = join(root, 'native/.build/macos');
const build = Bun.spawn(['xcrun', 'clang++', '-O2', '-std=c++17', '-fobjc-arc', '-fmodules', '-I', join(root, 'native/ghostty'), '-I', join(library, 'include'), source, join(root, 'native/ghostty/renderer-benchmark.mm'), join(library, 'lib/libghostty-vt.a'), '-framework', 'AppKit', '-framework', 'CoreText', '-o', binary], { stdout: 'inherit', stderr: 'inherit' });
if (await build.exited !== 0) throw new Error('Renderer benchmark build failed');
for (const scenario of ['hidden', 'cursor', 'row', 'text']) {
  for (let repetition = 0; repetition < 3; repetition++) {
    const child = Bun.spawn([binary, scenario, join(root, 'src/assets/fonts/TerminalFonts')], { stdout: 'pipe', stderr: 'inherit' });
    const result = JSON.parse(await new Response(child.stdout).text());
    if (await child.exited !== 0) throw new Error('Renderer benchmark failed');
    console.log(JSON.stringify({ ...result, repetition, build: process.env.WEAVE_RENDERER_BASELINE ? 'baseline' : 'current' }));
  }
}
