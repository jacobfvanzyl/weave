import { prepareTerminalCodecHeader } from '../../scripts/terminal-codec';
import { prepareNodeApiHeaders } from '../../scripts/native-headers';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const pin = await Bun.file(join(root, '../alpha/native/ghostty/pin.json')).json();
const cache = join(homedir(), '.cache/weave/ghostty', pin.revision);
const crossLinux = process.argv.includes('--linux');
const platform = crossLinux ? 'linux-x64' : process.platform === 'darwin' ? 'macos' : 'linux';
const output = join(root, 'dist', ...(crossLinux ? ['linux-x64'] : []));
const library = join(cache, platform);
const run = async (args: string[], cwd = root) => {
  const child = Bun.spawn(args, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`Terminal Service build failed: ${args[0]}`);
};
if (!await Bun.file(join(library, 'lib/libghostty-vt.a')).exists()) {
  const source = join(cache, 'source');
  if (!await Bun.file(join(source, '.git/HEAD')).exists()) {
    await mkdir(source, { recursive: true });
    await run(['git', 'init'], source);
    await run(['git', 'remote', 'add', 'origin', pin.repository], source);
    await run(['git', 'fetch', '--depth', '1', 'origin', pin.revision], source);
    await run(['git', 'checkout', '--detach', 'FETCH_HEAD'], source);
  }
  if (Bun.spawnSync(['zig', 'version']).stdout.toString().trim() !== pin.zig) throw new Error(`Install Zig ${pin.zig}`);
  const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: source }).stdout.toString().trim();
  if (revision !== pin.revision || Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: source }).stdout.length) throw new Error('Prepare the clean pinned Ghostty source first');
  await run(['zig', 'build', '-Demit-lib-vt', '-Doptimize=ReleaseFast', '-Demit-xcframework=false', ...(crossLinux ? ['-Dtarget=x86_64-linux-gnu'] : []), '--prefix', library], source);
}
// Node-API is ABI stable in Bun and Electron. Use the already pinned header set.
const electron = (await Bun.file(join(root, '../alpha/package.json')).json()).devDependencies.electron;
const headers = process.env.WEAVE_NODE_HEADERS ?? await prepareNodeApiHeaders(electron);
if (!await Bun.file(join(headers, 'node_api.h')).exists()) throw new Error('Prepare pinned Node-API headers with the native desktop build, or set WEAVE_NODE_HEADERS');
await mkdir(output, { recursive: true });
await prepareTerminalCodecHeader(output, pin.revision);
await run([...(crossLinux ? ['zig', 'c++', '-target', 'x86_64-linux-gnu'] : platform === 'macos' ? ['xcrun', 'clang++'] : ['c++']), '-std=c++17', '-O2', '-shared', '-fPIC', ...(platform === 'macos' ? ['-undefined', 'dynamic_lookup'] : []), '-I', headers, '-I', output, '-I', join(library, 'include'), join(root, 'native/terminal-vt.cc'), join(library, 'lib/libghostty-vt.a'), '-o', join(output, 'terminal-vt.node')]);
await run(['bun', 'build', '--compile', ...(crossLinux ? ['--target=bun-linux-x64'] : []), '--outfile', join(output, 'weave-terminal-service'), join(root, 'src/terminal-service/main.ts')]);
