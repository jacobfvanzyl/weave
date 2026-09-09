import { connect } from 'node:net';
import { lstat, unlink } from 'node:fs/promises';

export async function removeOwnedSocket(path: string, expected: { ino: number; dev: number }) {
  try {
    const current = await lstat(path);
    if (current.isSocket() && current.uid === process.getuid?.() && current.ino === expected.ino && current.dev === expected.dev) await unlink(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export async function recoverStaleSocket(path: string) {
  let original;
  try { original = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!original.isSocket() || original.uid !== process.getuid?.()) throw new Error('ACP socket path is not an owned Unix socket.');
  const stale = await new Promise<boolean>((resolve, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Existing ACP socket did not respond; refusing to remove it.')); }, 500);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    socket.once('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); socket.destroy(); if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(true); else reject(error); });
  });
  if (!stale) throw new Error('Another Host is serving the local ACP socket.');
  await removeOwnedSocket(path, original);
}
