// @vitest-environment node
/// <reference types="bun" />
// The app's Host store and a terminal's stream against a real dev Host, whose terminals run in
// real holders (WVE-153), both reached through a dev Dispatcher it joined
// (`testing/dev-dispatcher.ts`, ADR 0030). Skipped unless the debug `weave`, its holder and the
// fake agent are built.
import { realpathSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { threadKey } from '@/app/app-controller';
import { HostConnection } from './connection';
import { DISPATCHER, dispatcherAuthMessage } from './dispatcher';
import type { HostStore } from './host-store';
import { HOST_PROTOCOL, type TerminalStreamOpened } from './protocol';
import { devStore, startDevDispatcher, type DevDispatcher } from './testing/dev-dispatcher';
import { devHostHasTerminals, startDevHost, unixConnector, type DevHost } from './testing/dev-host';

const waitFor = async <T,>(find: () => T | undefined | false, what: string, ms = 15_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await Bun.sleep(20);
  }
};

describe.skipIf(!devHostHasTerminals())('terminals through the Host store with a dev Host', () => {
  let host: DevHost;
  let local: HostConnection;
  let store: HostStore;
  let dispatcher: DevDispatcher;
  let keys: ReturnType<typeof devStore>['keys'];

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
    await store.actions.pairDispatcher({ url: dispatcher.url, code: await dispatcher.offer(), name: 'Test iPad' });
  }, 60_000);

  afterAll(async () => {
    // Holders outlive the Host that started them, as they're meant to: end them first.
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

  it("lists the open thread's terminals, live, and starts, renames, streams and ends them", async () => {
    const [paired] = store.snapshot().hosts;
    expect(paired).toMatchObject({ status: 'connected', canTerminals: true });
    await store.actions.createThread({ hostId: paired.id, cwd: host.cwd, agentId: 'fake' });
    const thread = await waitFor(() => store.snapshot().thread, 'the thread');
    const threadId = thread.key.slice(thread.key.indexOf('/') + 1);
    expect(thread.key).toBe(threadKey(paired.id, threadId));
    expect(await waitFor(() => store.snapshot().thread?.terminals, "the thread's terminals")).toEqual([]);

    const id = await store.actions.newTerminal();
    const made = await waitFor(() => store.snapshot().thread?.terminals?.find((terminal) => terminal.id === id), 'the new terminal');
    expect(made).toMatchObject({ scope: realpathSync(host.cwd), openedFrom: threadId });

    // One another client starts in the worktree shows too.
    const { terminal: other } = await local.request('terminals/new', { directory: host.cwd, label: 'other' });
    await waitFor(() => store.snapshot().thread?.terminals?.some((terminal) => terminal.id === other.id), "the other client's terminal");

    await store.actions.renameTerminal(id, 'tests');
    await waitFor(() => store.snapshot().thread?.terminals?.find((terminal) => terminal.id === id)?.label === 'tests', 'the name');

    // The stream, as the native plugin opens it: through the Dispatcher, which this device proves
    // itself to and asks for the Host's terminal stream, then from a codec that isn't the holder's,
    // so the restore is the formatter's VT, at the size the stream opened with.
    const { url, ticket, carry } = await store.actions.attachTerminal(id);
    expect(url).toBe(dispatcher.url);
    expect(carry.host).toBe(paired.id);
    const socket = new WebSocket(url, DISPATCHER.carrySubprotocol);
    socket.binaryType = 'arraybuffer';
    const answers = new Map<number, { result?: Record<string, string>; error?: unknown }>();
    let carried = false;
    const texts: unknown[] = [];
    let restored = 0;
    let output = '';
    socket.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') {
        const message = JSON.parse(data);
        if (carried) texts.push(message);
        else answers.set(message.id, message);
        return;
      }
      const bytes = new Uint8Array(data as ArrayBuffer);
      if (bytes[0] === HOST_PROTOCOL.terminalStream.restore) restored += bytes.length - 1;
      if (bytes[0] === HOST_PROTOCOL.terminalStream.output) output += new TextDecoder().decode(bytes.subarray(1));
    });
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
    expect(await ask(3, 'hosts/open', { host: carry.host, stream: 'terminal' })).toMatchObject({ hostId: paired.id });
    // From here the stream is the Host's.
    carried = true;
    socket.send(JSON.stringify({ ticket, size: { cols: 70, rows: 20 }, codec: 'not the holder\'s' }));
    const opened = await waitFor(() => texts[0] as TerminalStreamOpened | undefined, 'the stream to open');
    expect(opened).toMatchObject({ restore: 'vt', terminal: { id, size: { cols: 70, rows: 20 } } });
    await waitFor(() => restored === opened.restoreBytes, 'the restore');
    socket.send(new Uint8Array([HOST_PROTOCOL.terminalStream.input, ...new TextEncoder().encode('echo hi-$((6*7))\r')]));
    await waitFor(() => output.includes('hi-42'), 'the output');
    // Typing made this device the one whose size the terminal takes.
    socket.send(JSON.stringify({ resize: { cols: 90, rows: 25 } }));
    await waitFor(() => texts.some((text) => JSON.stringify(text) === JSON.stringify({ resized: { cols: 90, rows: 25 } })), 'the new size, in order');
    await waitFor(() => store.snapshot().thread?.terminals?.find((terminal) => terminal.id === id)?.size.cols === 90, 'the listed size');
    socket.close();

    await store.actions.closeTerminal(id);
    await waitFor(() => !store.snapshot().thread?.terminals?.some((terminal) => terminal.id === id), 'the terminal to end');
    expect(store.snapshot().thread?.terminals?.map((terminal) => terminal.id)).toEqual([other.id]);
  }, 60_000);
});
