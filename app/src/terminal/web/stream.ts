// A terminal's stream, as the page speaks it (WVE-205; `docs/specs/wve-85-host-protocol.md`,
// "A terminal's stream"): `Open` with a ticket, the Host's `Opened`, a restore in binary frames,
// then the terminal's output as it comes, with what else the Host says in text frames between.
// On the Mac the WebSocket is one the app's core offered, which it passes through to the Host's
// stream; nothing here knows which.
import { HOST_PROTOCOL, type HostTerminal, type TerminalSize, type TerminalStreamClientMessage, type TerminalStreamMessage, type TerminalStreamOpened } from '@/host/protocol';

const KIND = HOST_PROTOCOL.terminalStream;

/** A restore larger than this is refused: the holder's scrollback is at most a quarter of it. */
const MAX_RESTORE = 64 * 1024 * 1024;

export type Restore = {
  /** `snapshot` is the holder's, history and all; `vt` draws on a blank screen of `size`. */
  kind: 'snapshot' | 'vt';
  bytes: Uint8Array;
  size: TerminalSize;
};

export type StreamEvents = {
  /** The stream is open; its restore follows. */
  opened(terminal: HostTerminal, restore: 'snapshot' | 'vt'): void;
  /** The whole screen, to put in place of what's drawn: at opening, and again when this end fell behind. */
  restore(restore: Restore): void;
  output(bytes: Uint8Array): void;
  /** The terminal's size now: this device's, or the one another device gave it by typing. */
  resized(size: TerminalSize): void;
  updated?(terminal: HostTerminal): void;
  bell?(): void;
  notification?(title: string, body: string): void;
  /** The program wrote to the clipboard, and this device typed last. */
  clipboard?(text: string): void;
  progress?(state: string, progress?: number): void;
  exited(exitCode: number): void;
  /** The stream ended: with the WebSocket's close code, 0 when the connection failed. */
  closed(close: { code: number; reason: string }): void;
};

/** As much of a `WebSocket` as a stream uses. */
export type StreamSocket = {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type TerminalStream = {
  /** Keys, as bytes for the terminal's program. */
  input(bytes: Uint8Array): void;
  /** The grid this view fits, which the terminal takes while this device typed last. */
  resize(size: TerminalSize): void;
  /** Asks for the whole screen again. */
  resync(): void;
  close(): void;
};

const isOne = <K extends string>(message: object, key: K): message is Record<K, unknown> => key in message;

/**
 * Opens the stream at `url` with `ticket`, for a view of `size` that decodes snapshots of
 * `codec`. Events come in the stream's order; output that arrives while a restore is still
 * coming is the restore's to come after, so it's held until then.
 */
export function openTerminalStream(
  options: { url: string; ticket: string; size: TerminalSize; codec: string; history?: boolean },
  events: StreamEvents,
  connect: (url: string, subprotocol: string) => StreamSocket = (url, subprotocol) => new WebSocket(url, subprotocol) as unknown as StreamSocket,
): TerminalStream {
  let socket: StreamSocket | undefined;
  let closed = false;
  let opened = false;
  /** The restore still arriving. */
  let pending: { kind: 'snapshot' | 'vt'; size: TerminalSize; left: number; chunks: Uint8Array[] } | undefined;
  let held: (() => void)[] = [];

  const end = (close: { code: number; reason: string }) => {
    if (closed) return;
    closed = true;
    const ended = socket;
    socket = undefined;
    if (ended) {
      ended.onopen = ended.onmessage = ended.onclose = ended.onerror = null;
      try {
        ended.close();
      } catch {
        // Already closed.
      }
    }
    events.closed(close);
  };

  const finish = () => {
    if (!pending || pending.left > 0) return;
    const { kind, size, chunks } = pending;
    pending = undefined;
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    events.restore({ kind, bytes, size });
    const after = held;
    held = [];
    for (const run of after) run();
  };

  const expect = (kind: 'snapshot' | 'vt', size: TerminalSize, length: number) => {
    if (length > MAX_RESTORE) {
      end({ code: 0, reason: "The terminal's screen is larger than this app takes." });
      return;
    }
    // A restore that another overtakes is dropped, with what was held for it.
    pending = { kind, size, left: length, chunks: [] };
    held = [];
    finish();
  };

  /** In the stream's order: now, or after the restore that's arriving. */
  const inOrder = (run: () => void) => {
    if (pending) held.push(run);
    else run();
  };

  const text = (data: string) => {
    let message: TerminalStreamOpened | TerminalStreamMessage;
    try {
      message = JSON.parse(data) as TerminalStreamOpened | TerminalStreamMessage;
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    if (!opened) {
      if (!('terminal' in message) || !('restore' in message)) return;
      opened = true;
      events.opened(message.terminal, message.restore);
      expect(message.restore, message.terminal.size, message.restoreBytes);
      return;
    }
    if (isOne(message, 'resync')) {
      const { restore, restoreBytes, size } = (message as Extract<TerminalStreamMessage, { resync: unknown }>).resync;
      expect(restore, size, restoreBytes);
    } else if (isOne(message, 'resized')) {
      const size = (message as Extract<TerminalStreamMessage, { resized: unknown }>).resized;
      inOrder(() => events.resized(size));
    } else if (isOne(message, 'updated')) {
      events.updated?.((message as Extract<TerminalStreamMessage, { updated: unknown }>).updated);
    } else if (isOne(message, 'bell')) {
      events.bell?.();
    } else if (isOne(message, 'notification')) {
      const { title, body } = (message as Extract<TerminalStreamMessage, { notification: unknown }>).notification;
      events.notification?.(title, body);
    } else if (isOne(message, 'clipboard')) {
      events.clipboard?.((message as Extract<TerminalStreamMessage, { clipboard: unknown }>).clipboard.text);
    } else if (isOne(message, 'progress')) {
      const { state, progress } = (message as Extract<TerminalStreamMessage, { progress: unknown }>).progress;
      events.progress?.(state, progress ?? undefined);
    } else if (isOne(message, 'exited')) {
      events.exited((message as Extract<TerminalStreamMessage, { exited: unknown }>).exited.exitCode);
    }
  };

  const binary = (frame: Uint8Array) => {
    const kind = frame[0];
    const payload = frame.subarray(1);
    if (kind === KIND.restore) {
      if (!pending) return;
      pending.chunks.push(payload.slice());
      pending.left -= payload.length;
      if (pending.left < 0) {
        end({ code: 0, reason: "The terminal's screen came longer than the Host said." });
        return;
      }
      finish();
    } else if (kind === KIND.output) {
      if (pending) {
        const copy = payload.slice();
        held.push(() => events.output(copy));
      } else {
        events.output(payload);
      }
    }
  };

  const say = (message: TerminalStreamClientMessage | { ticket: string; size: TerminalSize; codec: string; history?: boolean }) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(message));
  };

  try {
    socket = connect(options.url, KIND.subprotocol);
  } catch (error) {
    queueMicrotask(() => end({ code: 0, reason: error instanceof Error ? error.message : String(error) }));
    return { input() {}, resize() {}, resync() {}, close() { closed = true; } };
  }
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => say({ ticket: options.ticket, size: options.size, codec: options.codec, ...(options.history ? { history: true } : {}) });
  socket.onmessage = ({ data }) => {
    if (closed) return;
    if (typeof data === 'string') text(data);
    else if (data instanceof ArrayBuffer) binary(new Uint8Array(data));
    else if (ArrayBuffer.isView(data)) binary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  };
  socket.onclose = ({ code, reason }) => end({ code, reason });
  socket.onerror = () => end({ code: 0, reason: "Couldn't reach the terminal's stream." });

  return {
    input(bytes) {
      if (socket?.readyState !== 1 || bytes.length === 0) return;
      const frame = new Uint8Array(bytes.length + 1);
      frame[0] = KIND.input;
      frame.set(bytes, 1);
      socket.send(frame);
    },
    resize: (size) => say({ resize: size }),
    resync: () => say({ resync: {} }),
    close() {
      if (closed) return;
      closed = true;
      const ending = socket;
      socket = undefined;
      if (ending) {
        ending.onopen = ending.onmessage = ending.onclose = ending.onerror = null;
        try {
          ending.close();
        } catch {
          // Already closed.
        }
      }
    },
  };
}
