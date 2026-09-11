const bytes = (text: string) => new TextEncoder().encode(text);
import { expect, it, vi } from 'vitest';
import { TerminalOutputStream, type TerminalOutputSink } from './output-stream';
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

it('orders snapshot and fragmented live output by renderer acknowledgement', async () => {
  const resync = vi.fn();
  const stream = new TerminalOutputStream(resync);
  const received: string[] = [];
  let acknowledge: (() => void) | undefined;
  stream.reset(bytes('snapshot'));
  stream.write(bytes('\x1b['));
  stream.write(bytes('32m界'));
  const stop = stream.subscribe({
    reset: async (data) => { received.push(new TextDecoder().decode(data)); await new Promise<void>((resolve) => { acknowledge = resolve; }); },
    write: async (data) => { received.push(new TextDecoder().decode(data)); },
  });
  expect(received).toEqual(['snapshot']);
  acknowledge!(); await drain();
  expect(received).toEqual(['snapshot', '\x1b[32m界']);
  expect(resync).not.toHaveBeenCalled();
  stop();
});

it('bounds pending bytes including in-flight writes and requests one fresh snapshot on overflow', async () => {
  const resync = vi.fn();
  const stream = new TerminalOutputStream(resync, 12);
  const received: string[] = [];
  let acknowledge: (() => void) | undefined;
  stream.subscribe({ reset: async (data) => { received.push(new TextDecoder().decode(data)); await new Promise<void>((resolve) => { acknowledge = resolve; }); }, write: async (data) => { received.push(new TextDecoder().decode(data)); } });
  stream.reset(bytes('initial')); // Bootstrap has its own bounded budget.
  stream.write(bytes('界界界')); // 9 bytes, not three UTF-16 code units.
  stream.write(bytes('界界')); // Overflows, discards the incomplete tail.
  stream.write(bytes('ignored'));
  expect(resync).toHaveBeenCalledTimes(1);
  stream.reset(bytes('fresh'));
  acknowledge!(); await drain();
  expect(received).toEqual(['initial', 'fresh']);
  acknowledge!(); await drain();
  stream.write(bytes('ok')); await drain();
  expect(received).toEqual(['initial', 'fresh', 'ok']);
});

it('requires a fresh snapshot when a renderer remounts and fences an old renderer failure', async () => {
  const resync = vi.fn();
  const stream = new TerminalOutputStream(resync);
  let reject: ((cause: Error) => void) | undefined;
  stream.reset(bytes('old'));
  const stop = stream.subscribe({ reset: () => new Promise<void>((_resolve, fail) => { reject = fail; }), write: async () => undefined });
  stop();
  stream.write(bytes('tail is insufficient'));
  const received: string[] = [];
  const sink: TerminalOutputSink = { reset: async (data) => { received.push(new TextDecoder().decode(data)); }, write: async (data) => { received.push(new TextDecoder().decode(data)); } };
  stream.subscribe(sink);
  expect(resync).toHaveBeenCalledTimes(1);
  stream.reset(bytes('current'));
  reject!(new Error('old renderer closed')); await drain();
  stream.write(bytes('live')); await drain();
  expect(received).toEqual(['current', 'live']);
  expect(resync).toHaveBeenCalledTimes(1);
});

it('resynchronizes a failed renderer write without replaying a truncated transcript', async () => {
  const resync = vi.fn();
  const stream = new TerminalOutputStream(resync);
  stream.reset(bytes('snapshot'));
  stream.subscribe({ reset: async () => undefined, write: async () => { throw new Error('bridge unavailable'); } });
  stream.write(bytes('one')); stream.write(bytes('two'));
  await drain();
  expect(resync).toHaveBeenCalledTimes(1);
});


it('allows live output while a large READY prefix is being consumed and settles history on detach', async () => {
  const resync = vi.fn();
  const stream = new TerminalOutputStream(resync);
  let acknowledge!: () => void;
  const write = vi.fn(async () => undefined);
  const stop = stream.subscribe({ reset: () => new Promise<void>(resolve => { acknowledge = resolve; }), write, history: async () => undefined });
  stream.reset(new Uint8Array(3 * 1024 * 1024));
  stream.write(bytes('live'));
  expect(resync).not.toHaveBeenCalled();
  acknowledge(); await drain();
  expect(write).toHaveBeenCalledWith(bytes('live'));
  stop();
  stream.reset(bytes('replacement'));
  const history = stream.history(bytes('page'));
  stream.clear();
  await expect(history).resolves.toBe(false);
});
