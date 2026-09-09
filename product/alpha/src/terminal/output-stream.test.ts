import { expect, it, vi } from 'vitest';
import { TerminalOutputStream, type TerminalOutputSink } from './output-stream';
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

it('orders snapshot and fragmented live output by renderer acknowledgement', async () => {
  const resync = vi.fn();
  const stream = new TerminalOutputStream(resync);
  const received: string[] = [];
  let acknowledge: (() => void) | undefined;
  stream.reset('snapshot');
  stream.write('\x1b[');
  stream.write('32m界');
  const stop = stream.subscribe({
    reset: async (data) => { received.push(data); await new Promise<void>((resolve) => { acknowledge = resolve; }); },
    write: async (data) => { received.push(data); },
  });
  expect(received).toEqual(['snapshot']);
  acknowledge!(); await drain();
  expect(received).toEqual(['snapshot', '\x1b[', '32m界']);
  expect(resync).not.toHaveBeenCalled();
  stop();
});

it('bounds pending bytes including in-flight writes and requests one fresh snapshot on overflow', async () => {
  const resync = vi.fn();
  const stream = new TerminalOutputStream(resync, 12);
  const received: string[] = [];
  let acknowledge: (() => void) | undefined;
  stream.subscribe({ reset: async (data) => { received.push(data); await new Promise<void>((resolve) => { acknowledge = resolve; }); }, write: async (data) => { received.push(data); } });
  stream.reset('initial'); // 7 bytes remain in flight.
  stream.write('界'); // 3 bytes, not one UTF-16 code unit.
  stream.write('界'); // Overflows, discards the incomplete tail.
  stream.write('ignored');
  expect(resync).toHaveBeenCalledTimes(1);
  stream.reset('fresh');
  acknowledge!(); await drain();
  expect(received).toEqual(['initial', 'fresh']);
  acknowledge!(); await drain();
  stream.write('ok'); await drain();
  expect(received).toEqual(['initial', 'fresh', 'ok']);
});

it('requires a fresh snapshot when a renderer remounts and fences an old renderer failure', async () => {
  const resync = vi.fn();
  const stream = new TerminalOutputStream(resync);
  let reject: ((cause: Error) => void) | undefined;
  stream.reset('old');
  const stop = stream.subscribe({ reset: () => new Promise<void>((_resolve, fail) => { reject = fail; }), write: async () => undefined });
  stop();
  stream.write('tail is insufficient');
  const received: string[] = [];
  const sink: TerminalOutputSink = { reset: async (data) => { received.push(data); }, write: async (data) => { received.push(data); } };
  stream.subscribe(sink);
  expect(resync).toHaveBeenCalledTimes(1);
  stream.reset('current');
  reject!(new Error('old renderer closed')); await drain();
  stream.write('live'); await drain();
  expect(received).toEqual(['current', 'live']);
  expect(resync).toHaveBeenCalledTimes(1);
});

it('resynchronizes a failed renderer write without replaying a truncated transcript', async () => {
  const resync = vi.fn();
  const stream = new TerminalOutputStream(resync);
  stream.reset('snapshot');
  stream.subscribe({ reset: async () => undefined, write: async () => { throw new Error('bridge unavailable'); } });
  stream.write('one'); stream.write('two');
  await drain();
  expect(resync).toHaveBeenCalledTimes(1);
});
