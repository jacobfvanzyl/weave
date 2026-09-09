import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'darwin') throw new Error('This probe requires macOS, Xcode and both Apple SDKs.');
const native = resolve(import.meta.dir, '../native/ghostty');
const pin = await Bun.file(join(native, 'pin.json')).json() as { repository: string; revision: string; zig: string };
const cache = join(homedir(), '.cache/weave/ghostty', pin.revision);
const source = process.env.WEAVE_GHOSTTY_SOURCE ? resolve(process.env.WEAVE_GHOSTTY_SOURCE) : join(cache, 'source');
await mkdir(cache, { recursive: true });
async function run(args: string[], cwd = cache) {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${args.slice(0, 2).join(' ')} failed (${code}):\n${stderr}\n${stdout}`);
  return stdout.trim();
}
if (await run(['zig', 'version']) !== pin.zig) throw new Error(`Install Zig ${pin.zig} for this pinned native probe.`);
if (!await Bun.file(join(source, '.git/HEAD')).exists()) {
  if (process.env.WEAVE_GHOSTTY_SOURCE) throw new Error('WEAVE_GHOSTTY_SOURCE must be an existing clean pinned checkout.');
  await mkdir(source, { recursive: true });
  await run(['git', 'init'], source);
  await run(['git', 'remote', 'add', 'origin', pin.repository], source);
  await run(['git', 'fetch', '--depth', '1', 'origin', pin.revision], source);
  await run(['git', 'checkout', '--detach', 'FETCH_HEAD'], source);
}
if (await run(['git', 'rev-parse', 'HEAD'], source) !== pin.revision || await run(['git', 'status', '--porcelain'], source)) {
  throw new Error('Ghostty source must exactly match the clean pinned revision.');
}
for (const target of ['macos', 'ios']) {
  console.log(`Building pinned libghostty-vt for ${target}...`);
  const output = join(cache, target);
  await run(['zig', 'build', '-Demit-lib-vt', '-Doptimize=ReleaseFast', '-Demit-xcframework=false',
    ...(target === 'ios' ? ['-Dtarget=aarch64-ios'] : []), '--prefix', output], source);
  const flags = ['-I', join(output, 'include'), join(native, 'probe.c'), join(output, 'lib/libghostty-vt.a')];
  if (target === 'macos') {
    const binary = join(output, 'weave-ghostty-probe');
    await run(['xcrun', 'clang', '-DWEAVE_PROBE_MAIN', ...flags, '-o', binary]);
    console.log(await run([binary]));
  } else {
    const sdk = await run(['xcrun', '--sdk', 'iphoneos', '--show-sdk-path']);
    await run(['xcrun', '--sdk', 'iphoneos', 'clang', '-target', 'arm64-apple-ios15.0', '-isysroot', sdk,
      '-dynamiclib', ...flags, '-o', join(output, 'weave-ghostty-probe.dylib')]);
    console.log('iOS arm64 native link passed (not a device rendering test).');
  }
}
await Bun.write(join(cache, 'probe.json'), JSON.stringify({ ...pin, macosExecuted: true, iosLinked: true, nativeViewAccepted: false }, null, 2) + '\n');
console.log(`Evidence: ${join(cache, 'probe.json')}`);
