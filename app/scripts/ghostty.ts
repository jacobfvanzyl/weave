// Puts libghostty-vt for Apple's platforms, its headers, Ghostty's license and the terminal fonts
// into the iOS project's ignored `ios/App/Native/`, for the native terminal (ADR 0022, WVE-153).
//
//   bun scripts/ghostty.ts
//
// They come from the Ghostty commit `../holder/ghostty.toml` pins, as weave-holder's do, so the
// app's snapshots decode the holder's: built once per pin into the cache weave-holder's build.rs
// uses (`$WEAVE_GHOSTTY_CACHE`, else `$XDG_CACHE_HOME/weave/ghostty`, else
// `~/.cache/weave/ghostty`), with the pinned Zig from `$ZIG`, from PATH, or downloaded there and
// checked against the pin's checksum. Ghostty's source is fetched with git at the pinned commit,
// and the fonts are the JetBrains Mono Nerd Font files in it (`src/font/res`).
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

type Pin = {
  ghostty: { repository: string; commit: string };
  zig: { version: string; downloads: Record<string, { url: string; sha256: string }> };
};

const root = resolve(import.meta.dir, '..');
const pin = Bun.TOML.parse(await readFile(resolve(root, '../holder/ghostty.toml'), 'utf8')) as Pin;
const native = resolve(root, 'ios/App/Native');
const fonts = ['Regular', 'Bold', 'Italic', 'BoldItalic'].map((style) => `JetBrainsMonoNerdFont-${style}.ttf`);
/** What a cached build holds; another layout is built again. */
const layout = '1';

const exists = (path: string) => stat(path).then(() => true, () => false);

const run = async (args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) => {
  const child = Bun.spawn(args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if ((await child.exited) !== 0) throw new Error(`${args.join(' ')} failed:\n${error.trim()}`);
  return output.trim();
};

const cacheDir = () => {
  if (process.env.WEAVE_GHOSTTY_CACHE) return process.env.WEAVE_GHOSTTY_CACHE;
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, 'weave/ghostty');
  return join(homedir(), '.cache/weave/ghostty');
};

const zigVersion = (zig: string) => run([zig, 'version']).catch(() => undefined);

/** A Zig of the pinned version: `$ZIG`, `zig` on PATH, or one downloaded into the cache. */
const zig = async (cache: string) => {
  if (process.env.ZIG) {
    const version = await zigVersion(process.env.ZIG);
    if (version !== pin.zig.version) throw new Error(`$ZIG is Zig ${version ?? 'of no version'}, but ghostty.toml needs ${pin.zig.version}`);
    return process.env.ZIG;
  }
  if ((await zigVersion('zig')) === pin.zig.version) return 'zig';
  const dir = join(cache, `zig-${pin.zig.version}`);
  if (await exists(join(dir, 'zig'))) return join(dir, 'zig');
  const host = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-macos`;
  const download = pin.zig.downloads[host];
  if (!download) throw new Error(`ghostty.toml has no Zig for ${host}; set ZIG`);
  console.log(`Downloading Zig ${pin.zig.version}…`);
  const bytes = new Uint8Array(await (await fetch(download.url)).arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== download.sha256) throw new Error(`${download.url} has checksum ${digest}, not ${download.sha256}`);
  const archive = join(cache, `zig-${pin.zig.version}-${host}.tar.xz`);
  const staging = `${dir}.partial`;
  await writeFile(archive, bytes);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await run(['tar', '-xJf', archive, '-C', staging, '--strip-components', '1']);
  await rename(staging, dir);
  await rm(archive, { force: true });
  return join(dir, 'zig');
};

/** Builds the Apple libraries and gathers the rest into `<cache>/<commit>/apple`, once per pin. */
const build = async (cache: string) => {
  const commitDir = join(cache, pin.ghostty.commit);
  const out = join(commitDir, 'apple');
  if ((await readFile(join(out, '.complete'), 'utf8').catch(() => '')) === layout) return out;
  console.log(`Building libghostty-vt for iOS at Ghostty ${pin.ghostty.commit.slice(0, 8)}, once per pin…`);
  const src = join(commitDir, 'src-apple');
  const local = join(commitDir, 'zig-local-apple');
  const staging = `${out}.partial`;
  await rm(src, { recursive: true, force: true });
  await mkdir(src, { recursive: true });
  await run(['git', 'init', '-q'], { cwd: src });
  await run(['git', 'fetch', '-q', '--depth', '1', pin.ghostty.repository, pin.ghostty.commit], { cwd: src });
  await run(['git', '-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], { cwd: src });
  const head = await run(['git', 'rev-parse', 'HEAD'], { cwd: src });
  if (head !== pin.ghostty.commit) throw new Error(`fetched Ghostty ${head}, but ghostty.toml pins ${pin.ghostty.commit}`);
  await rm(staging, { recursive: true, force: true });
  await run(
    [await zig(cache), 'build', '-Demit-lib-vt', '-Demit-xcframework=true', '-Doptimize=ReleaseFast', '--prefix', staging, '--cache-dir', local],
    { cwd: src, env: { ZIG_GLOBAL_CACHE_DIR: join(cache, 'zig-global') } },
  );
  await mkdir(join(staging, 'fonts'), { recursive: true });
  for (const file of [...fonts, 'OFL.txt']) await cp(join(src, 'src/font/res', file), join(staging, 'fonts', file));
  await cp(join(src, 'LICENSE'), join(staging, 'GHOSTTY-LICENSE'));
  await writeFile(
    join(staging, 'include/weave_ghostty_pin.h'),
    `// The Ghostty commit libghostty-vt was built from (holder/ghostty.toml), which names its snapshots.\n` +
      `#define WEAVE_GHOSTTY_COMMIT "${pin.ghostty.commit}"\n`,
  );
  await writeFile(join(staging, '.complete'), layout);
  await rm(out, { recursive: true, force: true });
  await rename(staging, out);
  await rm(src, { recursive: true, force: true });
  await rm(local, { recursive: true, force: true });
  return out;
};

const stamp = join(native, '.pin');
if ((await readFile(stamp, 'utf8').catch(() => '')) === `${pin.ghostty.commit} ${layout}`) {
  console.log(`ios/App/Native has Ghostty ${pin.ghostty.commit.slice(0, 8)} already.`);
} else {
  const cache = cacheDir();
  await mkdir(cache, { recursive: true });
  const out = await build(cache);
  await rm(native, { recursive: true, force: true });
  await mkdir(native, { recursive: true });
  await cp(join(out, 'lib/ghostty-vt.xcframework'), join(native, 'ghostty-vt.xcframework'), { recursive: true });
  await cp(join(out, 'include'), join(native, 'include'), { recursive: true });
  await cp(join(out, 'fonts'), join(native, 'TerminalFonts'), { recursive: true });
  await cp(join(out, 'GHOSTTY-LICENSE'), join(native, 'GHOSTTY-LICENSE'));
  await writeFile(stamp, `${pin.ghostty.commit} ${layout}`);
  console.log(`Put Ghostty ${pin.ghostty.commit.slice(0, 8)}'s libghostty-vt and fonts in ios/App/Native.`);
}
