import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TerminalManager, type TerminalPty, type TerminalPtySpawner, type TerminalWebContents } from '../src/main/terminal-manager';
import type { TerminalHostEvent } from '../src/shared/terminal';

class FakePty implements TerminalPty {
  pid = 4242;
  process = 'fake-shell';
  killed = false;
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: { exitCode: number; signal?: number | string }) => void>();

  write(data: string) {
    this.writes.push(data);
  }

  resize(cols: number, rows: number) {
    this.resizes.push({ cols, rows });
  }

  kill() {
    this.killed = true;
  }

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number | string }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event = { exitCode: 0 }) {
    for (const listener of this.exitListeners) listener(event);
  }
}

const createSender = (id: number): TerminalWebContents & {
  send: Mock<(channel: string, event: TerminalHostEvent) => void>;
} => {
  const send = vi.fn<(channel: string, event: TerminalHostEvent) => void>();
  return {
    id,
    isDestroyed: () => false,
    send,
  };
};

const withTerminalManager = async (callback: (context: {
  manager: TerminalManager;
  ptys: FakePty[];
  spawner: Mock<TerminalPtySpawner>;
  cwd: string;
}) => Promise<void>) => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'weave-terminal-'));
  const ptys: FakePty[] = [];
  const spawner = vi.fn<TerminalPtySpawner>(() => {
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  });
  const manager = new TerminalManager({
    resolveDemiplane: async () => ({ cwd }),
    spawner,
    outputBatchMs: 1,
    replayLimitBytes: 1024,
    env: { SHELL: '/bin/test-shell' },
  });

  try {
    await callback({ manager, ptys, spawner, cwd });
  } finally {
    manager.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
};

const startInput = { planeId: 'plane-1', demiplaneId: 'demiplane-1', cols: 100, rows: 30 };

describe('TerminalManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses a running PTY per Demiplane and replays buffered output on attach', async () => withTerminalManager(async ({ manager, ptys, spawner }) => {
    const firstSender = createSender(1);
    const firstStart = await manager.start(startInput, firstSender);
    expect(spawner).toHaveBeenCalledOnce();
    expect(firstSender.send).toHaveBeenCalledWith('terminal:event', expect.objectContaining({
      type: 'started',
      demiplaneId: 'demiplane-1',
      cols: 100,
      rows: 30,
    }));

    ptys[0].emitData('hello from shell');
    await vi.advanceTimersByTimeAsync(1);
    expect(firstSender.send).toHaveBeenCalledWith('terminal:event', {
      type: 'output',
      demiplaneId: 'demiplane-1',
      data: 'hello from shell',
    });

    const secondSender = createSender(2);
    const secondStart = await manager.start({ ...startInput, cols: 120 }, secondSender);
    expect(spawner).toHaveBeenCalledOnce();
    expect(secondStart.sessionId).toBe(firstStart.sessionId);
    expect(ptys[0].resizes).toEqual([{ cols: 120, rows: 30 }]);
    expect(secondSender.send).toHaveBeenCalledWith('terminal:event', expect.objectContaining({
      type: 'started',
      demiplaneId: 'demiplane-1',
    }));
    expect(secondSender.send).toHaveBeenCalledWith('terminal:event', {
      type: 'replay',
      demiplaneId: 'demiplane-1',
      data: 'hello from shell',
    });
  }));

  it('detaches a renderer subscription without killing the PTY', async () => withTerminalManager(async ({ manager, ptys }) => {
    const sender = createSender(1);
    await manager.start(startInput, sender);
    const initialSendCount = sender.send.mock.calls.length;

    manager.detach('demiplane-1', sender);
    ptys[0].emitData('after detach');
    await vi.advanceTimersByTimeAsync(1);

    expect(sender.send).toHaveBeenCalledTimes(initialSendCount);
    expect(ptys[0].killed).toBe(false);
  }));

  it('routes input and resize to the PTY and kills on close', async () => withTerminalManager(async ({ manager, ptys }) => {
    await manager.start(startInput, createSender(1));

    manager.input('demiplane-1', 'pwd\r');
    manager.resize('demiplane-1', 132, 40);
    manager.close('demiplane-1');

    expect(ptys[0].writes).toEqual(['pwd\r']);
    expect(ptys[0].resizes).toEqual([{ cols: 132, rows: 40 }]);
    expect(ptys[0].killed).toBe(true);
  }));
});
