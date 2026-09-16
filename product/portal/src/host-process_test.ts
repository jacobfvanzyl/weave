import { expect, test } from 'bun:test';
import { signalProcess, spawnProcess } from './host-process.ts';

test('process signaling does not hide a persistent permission failure', async () => {
  const error = Object.assign(new Error('Permission denied'), { code: 'EPERM' });
  await expect(signalProcess({ kill() { throw error; } }, 'SIGKILL')).rejects.toBe(error);
});

test.skipIf(process.platform !== 'darwin')('Darwin exiting-group EPERM is retried until the group disappears', async () => {
  const signals: string[] = [];
  await signalProcess({ kill(signal) {
    signals.push(signal!);
    throw Object.assign(new Error('Exiting group'), { code: signals.length === 1 ? 'EPERM' : 'ESRCH' });
  } }, 'SIGKILL');
  expect(signals).toEqual(['SIGKILL', 'SIGKILL']);
});

test.skipIf(process.platform === 'win32')('a private launcher group terminates without touching an unrelated child', async () => {
  const unrelated = spawnProcess('/bin/sleep', { args: ['30'], detached: true });
  const child = spawnProcess('/bin/sh', { args: ['-c', 'sleep 30 & echo ready; wait'], detached: true });
  try {
    const reader = child.stdout.getReader();
    await reader.read(); reader.releaseLock();
    await signalProcess(child, 'SIGTERM');
    await child.status;
    await signalProcess(child, 'SIGKILL');
    expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
  } finally {
    await signalProcess(child, 'SIGKILL');
    await signalProcess(unrelated, 'SIGKILL');
    await unrelated.status;
  }
});
