import { spawn } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { privateDirectory } from './chromium.ts';

/** Serializes service startup across Portal processes; never replaces a live owner. */
export async function startBrowserService(stateDirectory: string, chromium: string, ready: () => Promise<void>, cefExecutable?: string) {
  await privateDirectory(stateDirectory);
  const directory = join(stateDirectory, 'browser-service'); await privateDirectory(directory);
  const lock = join(directory, 'start.lock');
  let acquired = false;
  try {
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (acquired) {
      // Another starter may have finished between our failed connection and lock.
      try { await ready(); return; } catch {}
      const packaged = process.execPath.includes('weave-portal');
      const executable = packaged ? join(dirname(await realpath(process.execPath)), 'weave-browser-service') : process.execPath;
      const args = [...(packaged ? [] : [join(import.meta.dir, 'main.ts')]), stateDirectory, chromium, ...(cefExecutable ? [cefExecutable] : [])];
      const log = openSync(join(directory, 'service.log'), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        const child = spawn(executable, args, { detached: true, stdio: ['ignore', 'ignore', log] });
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
      } finally { closeSync(log); }
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { await ready(); return; } catch { await Bun.sleep(50); }
    }
    throw new Error('Browser Service did not start; inspect its private service.log and startup lock');
  } finally { if (acquired) await rm(lock, { recursive: true }); }
}
