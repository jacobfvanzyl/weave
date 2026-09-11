import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from './host-files.ts';

export type DirectoryIdentity = {
  canonicalPath: string;
  device: string;
  inode: string;
  volumeId?: string;
};

const execute = promisify(execFile);
const command = async (file: string, args: string[]) => (await execute(file, args, {
  encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024,
  env: { ...process.env, LC_ALL: 'C' },
})).stdout;

// st_dev is mount-specific on macOS and can change at reboot. Resolve the
// backing device through df (including APFS firmlinks), then ask Disk Arbitration
// for its persistent volume UUID. No shell or device-number cache is involved.
async function volumeIdentity(path: string): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const output = await command('/bin/df', ['-P', path]);
  const device = output.trim().split('\n').at(-1)?.trim().split(/\s+/)[0];
  // Preserve the existing device/inode contract for non-disk filesystems.
  if (!device?.startsWith('/dev/')) return undefined;
  const plist = await command('/usr/sbin/diskutil', ['info', '-plist', device]);
  const uuid = plist.match(/<key>VolumeUUID<\/key>\s*<string>([0-9a-fA-F-]{36})<\/string>/)?.[1];
  if (!uuid || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new Error('The directory volume identity is unavailable.');
  }
  return `uuid:${uuid.toLowerCase()}`;
}

export async function inspectDirectory(path: string): Promise<DirectoryIdentity> {
  const canonicalPath = await realpath(path);
  const before = await stat(canonicalPath, { bigint: true });
  if (!before.isDirectory()) throw new Error('Workspace path must be a directory.');
  const volumeId = await volumeIdentity(canonicalPath);
  const after = await stat(canonicalPath, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || !after.isDirectory() || await realpath(path) !== canonicalPath) {
    throw new Error('The directory changed while checking its identity.');
  }
  return { canonicalPath, device: String(after.dev), inode: String(after.ino), ...(volumeId ? { volumeId } : {}) };
}

export function sameDirectoryIdentity(pin: DirectoryIdentity, current: DirectoryIdentity) {
  return pin.canonicalPath === current.canonicalPath && pin.inode === current.inode &&
    (pin.volumeId !== undefined ? pin.volumeId === current.volumeId : pin.device === current.device);
}
