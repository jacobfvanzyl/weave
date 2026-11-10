import { describe, expect, it, vi } from 'vitest';
import type { HostTerminal } from '@/host/protocol';
import { openTerminalStream, type StreamEvents, type StreamSocket } from './stream';

const terminal = (size = { cols: 80, rows: 24 }) => ({ id: 't-1', scope: '/work', size, programStatus: [], startedAt: 1 }) as unknown as HostTerminal;
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

/** The Host's end of a stream, by hand. */
const socketPair = () => {
  const sent: (string | Uint8Array)[] = [];
  const socket: StreamSocket = {
    binaryType: '',
    readyState: 0,
    bufferedAmount: 0,
    send: (data) => { sent.push(data); },
    close: vi.fn(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const host = {
    sent,
    open() {
      (socket as { readyState: number }).readyState = 1;
      socket.onopen?.({});
    },
    say: (message: unknown) => socket.onmessage?.({ data: JSON.stringify(message) }),
    frame: (kind: number, payload: Uint8Array) => {
      const frame = new Uint8Array(payload.length + 1);
      frame[0] = kind;
      frame.set(payload, 1);
      socket.onmessage?.({ data: frame.buffer });
    },
    close: (code: number, reason = '') => socket.onclose?.({ code, reason }),
  };
  return { socket, host };
};

const recorded = () => {
  const log: string[] = [];
  const events: StreamEvents = {
    opened: (_, restore) => log.push(`opened ${restore}`),
    restore: ({ kind, bytes: screen, size }) => log.push(`restore ${kind} ${size.cols}x${size.rows} ${text(screen)}`),
    output: (output) => log.push(`output ${text(output)}`),
    resized: (size) => log.push(`resized ${size.cols}x${size.rows}`),
    notification: (title, body) => log.push(`notification ${title}: ${body}`),
    clipboard: (copied) => log.push(`clipboard ${copied}`),
    bell: () => log.push('bell'),
    exited: (code) => log.push(`exited ${code}`),
    closed: ({ code, reason }) => log.push(`closed ${code} ${reason}`),
  };
  return { log, events };
};

describe("a terminal's stream", () => {
  const options = { url: 'ws://127.0.0.1:1/key', ticket: 'ticket-1', size: { cols: 90, rows: 30 }, codec: 'ghostty abc snapshot 1' };

  it('opens with its ticket, size and codec, and gives the restore whole before any output', () => {
    const { socket, host } = socketPair();
    const { log, events } = recorded();
    const connect = vi.fn(() => socket);
    openTerminalStream(options, events, connect);
    expect(connect).toHaveBeenCalledWith(options.url, 'weave-terminal');
    expect(socket.binaryType).toBe('arraybuffer');
    host.open();
    expect(JSON.parse(host.sent[0] as string)).toEqual({ ticket: 'ticket-1', size: { cols: 90, rows: 30 }, codec: options.codec });

    host.say({ terminal: terminal({ cols: 90, rows: 30 }), restore: 'snapshot', restoreBytes: 6 });
    host.frame(1, bytes('abc'));
    expect(log).toEqual(['opened snapshot']);
    host.frame(1, bytes('def'));
    host.frame(3, bytes('$ '));
    expect(log).toEqual(['opened snapshot', 'restore snapshot 90x30 abcdef', 'output $ ']);
  });

  it('holds what arrives during a restore, in order, and drops it when another restore overtakes', () => {
    const { socket, host } = socketPair();
    const { log, events } = recorded();
    openTerminalStream(options, events, () => socket);
    host.open();
    host.say({ terminal: terminal(), restore: 'vt', restoreBytes: 0 });
    expect(log).toEqual(['opened vt', 'restore vt 80x24 ']);
    log.length = 0;

    // This end fell behind: the Host starts the screen over.
    host.say({ resync: { restore: 'vt', restoreBytes: 4, size: { cols: 100, rows: 40 } } });
    host.frame(1, bytes('ab'));
    host.say({ resized: { cols: 100, rows: 41 } });
    host.frame(3, bytes('late'));
    host.say({ resync: { restore: 'vt', restoreBytes: 2, size: { cols: 100, rows: 41 } } });
    host.frame(1, bytes('zz'));
    host.say({ resized: { cols: 70, rows: 20 } });
    host.frame(3, bytes('next'));
    expect(log).toEqual(['restore vt 100x41 zz', 'resized 70x20', 'output next']);
  });

  it('passes on what the program asks of the device, and how the terminal ended', () => {
    const { socket, host } = socketPair();
    const { log, events } = recorded();
    openTerminalStream(options, events, () => socket);
    host.open();
    host.say({ terminal: terminal(), restore: 'vt', restoreBytes: 0 });
    log.length = 0;
    host.say({ bell: {} });
    host.say({ notification: { title: 'make', body: 'done' } });
    host.say({ clipboard: { text: 'copied' } });
    host.say({ updated: terminal() });
    host.say({ exited: { exitCode: 3 } });
    host.close(4011, 'exited');
    host.frame(3, bytes('after'));
    expect(log).toEqual(['bell', 'notification make: done', 'clipboard copied', 'exited 3', 'closed 4011 exited']);
    expect(socket.close).toHaveBeenCalled();
  });

  it('sends keys as input frames, and sizes and a request for the screen as text', () => {
    const { socket, host } = socketPair();
    const { events } = recorded();
    const stream = openTerminalStream(options, events, () => socket);
    // Nothing goes before the socket is open.
    stream.input(bytes('early'));
    host.open();
    stream.input(bytes('ls\r'));
    stream.input(new Uint8Array());
    stream.resize({ cols: 100, rows: 40 });
    stream.resync();
    expect(host.sent.length).toBe(4);
    expect([...(host.sent[1] as Uint8Array)]).toEqual([0x10, ...bytes('ls\r')]);
    expect(JSON.parse(host.sent[2] as string)).toEqual({ resize: { cols: 100, rows: 40 } });
    expect(JSON.parse(host.sent[3] as string)).toEqual({ resync: {} });
  });

  it('says nothing more once the page closes it', () => {
    const { socket, host } = socketPair();
    const { log, events } = recorded();
    const stream = openTerminalStream(options, events, () => socket);
    host.open();
    stream.close();
    expect(socket.close).toHaveBeenCalled();
    expect(socket.onmessage).toBeNull();
    host.close(1006);
    expect(log).toEqual([]);
  });

  it("ends when the connection fails, or the restore isn't what the Host said", () => {
    const failing = recorded();
    openTerminalStream(options, failing.events, () => {
      const { socket } = socketPair();
      queueMicrotask(() => socket.onerror?.({}));
      return socket;
    });
    return Promise.resolve().then(() => {
      expect(failing.log).toEqual(["closed 0 Couldn't reach the terminal's stream."]);
      const { socket, host } = socketPair();
      const { log, events } = recorded();
      openTerminalStream(options, events, () => socket);
      host.open();
      host.say({ terminal: terminal(), restore: 'snapshot', restoreBytes: 2 });
      host.frame(1, bytes('abc'));
      expect(log).toEqual(['opened snapshot', "closed 0 The terminal's screen came longer than the Host said."]);
    });
  });
});
