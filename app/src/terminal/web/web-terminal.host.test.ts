// @vitest-environment node
/// <reference types="bun" />
// The page's terminal against a real holder (WVE-205): the stream a dev Host serves, through a
// dev Dispatcher, restored into libghostty-vt in WebAssembly. It's the check that the 32-bit
// build reads a snapshot the holder's native one wrote, history and all, and that the screen it
// gives is the one the formatter's VT gives. Skipped unless the debug `weave`, its holder and
// the terminal's module are built (`bun scripts/ghostty.ts web`).
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TerminalTicket } from '@/app/app-controller';
import { HostConnection } from '@/host/connection';
import { DISPATCHER, dispatcherAuthMessage } from '@/host/dispatcher';
import type { HostStore } from '@/host/host-store';
import { devStore, startDevDispatcher, type DevDispatcher } from '@/host/testing/dev-dispatcher';
import { devHostHasTerminals, startDevHost, unixConnector, type DevHost } from '@/host/testing/dev-host';
import { CELL, CELL_WORDS, Ghostty, screenText, type TerminalCore } from './core';
import { openTerminalStream, type StreamSocket, type TerminalStream } from './stream';

const wasm = new URL('./generated/weave-terminal.wasm', import.meta.url);
const pin = new URL('./generated/pin.json', import.meta.url);

const waitFor = async <T,>(find: () => T | undefined | false, what: string, ms = 15_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await Bun.sleep(20);
  }
};

describe.skipIf(!devHostHasTerminals() || !existsSync(wasm))("the page's terminal with a dev Host's holder", () => {
  let host: DevHost;
  let local: HostConnection;
  let store: HostStore;
  let dispatcher: DevDispatcher;
  let keys: ReturnType<typeof devStore>['keys'];
  let ghostty: Ghostty;
  let codec: string;

  beforeAll(async () => {
    [dispatcher, host] = await Promise.all([startDevDispatcher(), startDevHost()]);
    await dispatcher.join(host, 'studio');
    local = await HostConnection.connect({
      connector: unixConnector(host.socket),
      client: { name: 'weave-app-test', version: '0' },
      credentials: { method: 'local' },
      onEvent: () => {},
    });
    ({ store, keys } = devStore());
    await store.start();
    await store.actions.pairDispatcher({ url: dispatcher.url, code: await dispatcher.offer(), name: 'Test Mac' });
    ghostty = await Ghostty.load(readFileSync(wasm));
    codec = ghostty.codec((JSON.parse(readFileSync(pin, 'utf8')) as { commit: string }).commit);
  }, 60_000);

  afterAll(async () => {
    if (local && host) {
      const { terminals } = await local.request('terminals/list', { directory: host.cwd }).catch(() => ({ terminals: [] }));
      await Promise.all(terminals.map(({ id }) => local.request('terminals/close', { id }).catch(() => {})));
      for (let tries = 0; tries < 50; tries += 1) {
        const left = await local.request('terminals/list', { directory: host.cwd }).catch(() => ({ terminals: [] }));
        if (left.terminals.length === 0) break;
        await Bun.sleep(100);
      }
    }
    store?.stop();
    local?.close();
    await host?.stop();
    await dispatcher?.stop();
  }, 30_000);

  /**
   * The Dispatcher's WebSocket, carried to the Host's terminal stream: what the Mac's core hands
   * the page already done, said here by hand.
   */
  const carried = async ({ url, carry }: TerminalTicket): Promise<StreamSocket> => {
    if (!carry) throw new Error('The Dispatcher carries the stream.');
    const socket = new WebSocket(url, DISPATCHER.carrySubprotocol);
    socket.binaryType = 'arraybuffer';
    const answers = new Map<number, { result?: Record<string, string>; error?: unknown }>();
    const hear = ({ data }: MessageEvent) => {
      const message = JSON.parse(data as string);
      answers.set(message.id, message);
    };
    socket.addEventListener('message', hear);
    const ask = async (id: number, method: string, params: unknown) => {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      const answer = await waitFor(() => answers.get(id), `the answer to ${method}`);
      if (!answer.result) throw new Error(`${method} failed: ${JSON.stringify(answer.error)}`);
      return answer.result;
    };
    await new Promise((opened) => socket.addEventListener('open', opened, { once: true }));
    const { nonce } = await ask(1, 'dispatcher/challenge', {});
    const signature = await keys.get(carry.keyId)!.sign(dispatcherAuthMessage(carry.dispatcherId, carry.deviceId, nonce));
    await ask(2, 'dispatcher/hello', { protocol: DISPATCHER.protocol, client: { name: 'weave-app-test', version: '0' }, auth: { method: 'device', deviceId: carry.deviceId, signature } });
    await ask(3, 'hosts/open', { host: carry.host, stream: 'terminal' });
    socket.removeEventListener('message', hear);
    return socket as unknown as StreamSocket;
  };

  /** A replica fed by the terminal's stream, opened as a view of `size` that decodes `as`. */
  const attach = async (id: string, as: string, size: { cols: number; rows: number }) => {
    const ticket = await store.actions.attachTerminal(id);
    const socket = await carried(ticket);
    const core = ghostty.terminal({ columns: size.cols, rows: size.rows }, { width: 8, height: 17 }) as TerminalCore;
    const seen = { restore: undefined as 'snapshot' | 'vt' | undefined, restored: false, decoded: true, closed: undefined as number | undefined };
    const stream: TerminalStream = openTerminalStream({ url: ticket.url, ticket: ticket.ticket, size, codec: as }, {
      opened: (_, restore) => { seen.restore = restore; },
      restore: (screen) => {
        if (screen.kind === 'snapshot') {
          seen.decoded = core.restore(screen.bytes);
        } else {
          core.reset({ columns: screen.size.cols, rows: screen.size.rows });
          core.write(screen.bytes);
        }
        seen.restored = true;
      },
      output: (bytes) => core.write(bytes),
      resized: (next) => { core.resize({ columns: next.cols, rows: next.rows }, { width: 8, height: 17 }); },
      exited: () => {},
      closed: ({ code }) => { seen.closed = code; },
    }, () => {
      // Already open: the stream hears so once it has set its handlers.
      queueMicrotask(() => socket.onopen?.({}));
      return socket;
    });
    await waitFor(() => seen.restored, 'the restore');
    return { core, stream, seen };
  };

  it("reads the holder's snapshot, history and all, as the screen its VT gives, and types into it", async () => {
    const [paired] = store.snapshot().hosts;
    const created = await store.actions.createThread({ hostId: paired.id, cwd: host.cwd, agentId: 'fake' });
    store.actions.selectSession?.(created ? created.sessionKey : undefined);
    await waitFor(() => store.snapshot().session?.terminals, "the Session's terminals");
    const id = await store.actions.newTerminal();
    await waitFor(() => store.snapshot().session?.terminals?.some((terminal) => terminal.id === id), 'the new terminal');

    // Something on screen and something scrolled off it, with color and a wide character, before
    // anything attaches.
    const size = { cols: 70, rows: 20 };
    const first = await attach(id, 'not a codec', size);
    expect(first.seen.restore).toBe('vt');
    first.stream.input(new TextEncoder().encode("clear; for i in $(seq 1 60); do echo line-$i; done; printf '\\033[1;32mgreen\\033[0m 日本 done-%d\\n' $((6*7))\r"));
    await waitFor(() => screenText(first.core.frame()!).some((line) => line.includes('done-42')), 'the output');
    // The prompt after it, so both replicas are restored from a screen at rest.
    await Bun.sleep(500);

    const snapshot = await attach(id, codec, size);
    expect(snapshot.seen.restore).toBe('snapshot');
    expect(snapshot.seen.decoded).toBe(true);
    const plain = await attach(id, 'another codec', size);
    expect(plain.seen.restore).toBe('vt');

    // A frame's arrays are good only until the module's next call, so each is copied out.
    const drawn = (core: TerminalCore) => {
      const frame = core.frame()!;
      return { ...frame, text: screenText(frame), cells: [...frame.cells] };
    };
    const fromSnapshot = drawn(snapshot.core);
    const fromVt = drawn(plain.core);
    expect([fromSnapshot.columns, fromSnapshot.rows]).toEqual([70, 20]);
    expect(fromSnapshot.text).toEqual(fromVt.text);
    expect(fromSnapshot.text.some((line) => line.includes('green 日本 done-42'))).toBe(true);
    // The snapshot has the cursor's shape as the shell set it; the VT of a screen doesn't say.
    expect({ ...fromSnapshot.cursor, style: 0 }).toEqual({ ...fromVt.cursor, style: 0 });
    // Every cell alike in what it shows, its style and its width. Not its colors: the VT sets
    // the holder's palette over the app's, where a snapshot takes the app's.
    const shown = (cells: number[]) => cells.filter((_, word) => word % CELL_WORDS === 0 || word % CELL_WORDS >= 3);
    expect(shown(fromSnapshot.cells)).toEqual(shown(fromVt.cells));
    const green = fromSnapshot.text.findIndex((line) => line.includes('green 日本 done-42')) * 70 * CELL_WORDS;
    expect(fromSnapshot.cells[green + 3]! & CELL.bold).toBe(CELL.bold);
    expect(fromSnapshot.cells[green + 1]).toBe(0xa6e3a1);

    // The snapshot carries what scrolled off; the VT of the screen doesn't.
    expect(fromSnapshot.scroll.total).toBeGreaterThan(40);
    expect(fromVt.scroll.total).toBe(20);
    snapshot.core.scroll(-fromSnapshot.scroll.total);
    expect(screenText(snapshot.core.frame()!).join('\n')).toContain('line-1\n');
    snapshot.core.scrollToBottom();

    // Keys encoded in the replica reach the program, and its output comes back to every stream.
    const typed = [...'echo hi-$((40+2))'].map((character) => snapshot.core.key({ code: '', text: character, mods: 0 })!);
    for (const bytes of typed) snapshot.stream.input(bytes);
    snapshot.stream.input(snapshot.core.key({ code: 'Enter', mods: 0 })!);
    await waitFor(() => screenText(snapshot.core.frame()!).some((line) => line === 'hi-42'), 'what was typed to run');
    await waitFor(() => screenText(plain.core.frame()!).some((line) => line === 'hi-42'), 'the other stream to see it');

    for (const { stream, core } of [first, snapshot, plain]) {
      stream.close();
      core.close();
    }
    await store.actions.closeTerminal(id);
  }, 60_000);
});
