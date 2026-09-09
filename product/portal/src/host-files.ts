import * as fs from 'node:fs/promises';
import { readFileSync, statSync, watch, type Stats, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
export { mkdir, chmod, rename, realpath, stat, lstat, link, symlink } from 'node:fs/promises';
export { statSync };
export type { Stats, Dirent };

export const isFsError = (error: unknown, code: string) =>
  error !== null && typeof error === 'object' && 'code' in error && error.code === code;
export const readText = (path: string | URL) => fs.readFile(path, 'utf8');
export const readTextSync = (path: string) => readFileSync(path, 'utf8');
export const readBytes = (path: string) => fs.readFile(path);
type WriteOptions = { mode?: number; append?: boolean; createNew?: boolean; create?: boolean };
export const writeBytes = (path: string, data: Uint8Array | string, options: WriteOptions = {}) =>
  fs.writeFile(path, data, { mode: options.mode, flag: options.createNew ? 'wx' : options.append ? 'a' : options.create === false ? 'r+' : 'w' });
export const writeText = writeBytes;
export const temporaryDirectory = (options: { prefix?: string; dir?: string } = {}) => fs.mkdtemp(join(options.dir ?? tmpdir(), options.prefix ?? 'weave-'));
export const removePath = async (path: string, options: { recursive?: boolean } = {}) => {
  if (!options.recursive && (await fs.lstat(path)).isDirectory()) await fs.rmdir(path);
  else await fs.rm(path, { recursive: options.recursive });
};
export async function* readDirectory(path: string) {
  yield* await fs.readdir(path, { withFileTypes: true });
}

export type FileChange = { kind: 'any' | 'access' | 'create' | 'modify' | 'remove' | 'other'; paths: string[]; flag?: 'rescan' };
// Node reports ambiguous renames, so consumers rescan rather than guessing create/delete.
export function watchPaths(paths: string | string[], options: { recursive: boolean }) {
  const pending: FileChange[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const roots = typeof paths === 'string' ? [paths] : paths;
  const queue = (event: FileChange) => {
    if (closed) return;
    if (pending.length >= 128) {
      pending.splice(0, pending.length, { kind: 'any', paths: roots, flag: 'rescan' });
    } else pending.push(event);
    wake?.();
  };
  const watchers: ReturnType<typeof watch>[] = [];
  try {
    for (const root of roots) {
      const watcher = watch(root, { recursive: options.recursive }, (kind, name) => queue({
        kind: kind === 'change' ? 'modify' : 'any',
        paths: name ? [resolve(root, String(name))] : [root],
        ...(kind === 'rename' || !name ? { flag: 'rescan' as const } : {}),
      }));
      watcher.on('error', () => queue({ kind: 'other', paths: [root], flag: 'rescan' }));
      watchers.push(watcher);
    }
  } catch (error) {
    watchers.forEach((watcher) => watcher.close());
    throw error;
  }
  return {
    close() { closed = true; watchers.forEach((watcher) => watcher.close()); wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (!pending.length) await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
        while (!closed && pending.length) yield pending.shift()!;
      }
    },
  };
}
