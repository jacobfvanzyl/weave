import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
if (process.platform !== 'darwin') throw new Error('The desktop installer targets macOS.');
const source = resolve(import.meta.dir, `../release/Weave Alpha-darwin-${process.arch}/Weave Alpha.app`);
if (!await Bun.file(join(source, 'Contents/Info.plist')).exists()) throw new Error('Run bun run build:desktop first.');
const applications = join(homedir(), 'Applications');
await mkdir(applications, { recursive: true });
const target = join(applications, 'Weave Alpha.app');
const temporary = await mkdtemp(join(applications, '.weave-install-'));
try {
  await cp(source, join(temporary, 'Weave Alpha.app'), { recursive: true });
  if (await Bun.file(join(target, 'Contents/Info.plist')).exists()) {
    const check = Bun.spawnSync(['/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleIdentifier', join(target, 'Contents/Info.plist')]);
    if (check.exitCode !== 0 || check.stdout.toString().trim() !== 'com.veezee.alpha.macos') throw new Error('An unrelated application occupies the install path.');
    const backup = join(homedir(), '.local/share/weave/backups', `desktop-${Date.now()}`);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await rename(target, join(backup, 'Weave Alpha.app'));
  }
  await rename(join(temporary, 'Weave Alpha.app'), target);
  console.log(`Installed ${target}. The existing desktop profile is retained.`);
} finally { await rm(temporary, { recursive: true, force: true }); }
