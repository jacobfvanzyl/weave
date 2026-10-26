// @vitest-environment node
/// <reference types="bun" />
// The app's Host store and a terminal's stream against a real dev Host (`testing/dev-host.ts`),
// whose terminals run in real holders (WVE-153). Skipped unless the debug `weave`, its holder and
// the fake agent are built.
import { realpathSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionKey } from '@/app/app-controller';
import { HostConnection, websocketConnector } from './connection';
import { type DeviceKey, webCryptoDeviceKey } from './device-key';
import { HostStore } from './host-store';
import { HOST_PROTOCOL, type TerminalStreamOpened } from './protocol';
import { memoryStorage } from './storage';
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
  const keys = new Map<string, DeviceKey>();

  beforeAll(async () => {
    host = await startDevHost();
    local = await HostConnection.connect({
      connector: unixConnector(host.socket),
      client: { name: 'weave-app-test', version: '0' },
      credentials: { method: 'local' },
      onEvent: () => {},
    });
    store = new HostStore({
      storage: memoryStorage(),
      keyFor: (keyId) => keys.get(keyId)!,
      async newKey() {
        const keyId = crypto.randomUUID();
        keys.set(keyId, await webCryptoDeviceKey());
        return { keyId, key: keys.get(keyId)! };
      },
      connectorFor: (url) => websocketConnector(url),
      client: { name: 'weave-app-test', version: '0' },
      deviceName: 'Test iPad',
      backoff: [50],
    });
    await store.start();
    const { code } = await local.request('devices/offer', {});
    await store.actions.pairHost({ url: host.url, code, name: 'Test iPad' });
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
  }, 30_000);

  it("lists the open thread's terminals, live, and starts, renames, streams and ends them", async () => {
    const [paired] = store.snapshot().hosts;
    expect(paired).toMatchObject({ status: 'connected', canTerminals: true });
    await store.actions.createSession({ hostId: paired.id, cwd: host.cwd, agentId: 'fake' });
    const session = await waitFor(() => store.snapshot().session, 'the thread');
    const sessionId = session.key.slice(session.key.indexOf('/') + 1);
    expect(session.key).toBe(sessionKey(paired.id, sessionId));
    expect(await waitFor(() => store.snapshot().session?.terminals, "the thread's terminals")).toEqual([]);

    const id = await store.actions.newTerminal();
    const made = await waitFor(() => store.snapshot().session?.terminals?.find((terminal) => terminal.id === id), 'the new terminal');
    expect(made).toMatchObject({ scope: realpathSync(host.cwd), openedFrom: sessionId });

    // One another client starts in the worktree shows too.
    const { terminal: other } = await local.request('terminals/new', { directory: host.cwd, label: 'other' });
    await waitFor(() => store.snapshot().session?.terminals?.some((terminal) => terminal.id === other.id), "the other client's terminal");

    await store.actions.renameTerminal(id, 'tests');
    await waitFor(() => store.snapshot().session?.terminals?.find((terminal) => terminal.id === id)?.label === 'tests', 'the name');

    // The stream, as the native plugin opens it: from a codec that isn't the holder's, so the
    // restore is the formatter's VT, at the size the stream opened with.
    const { url, ticket } = await store.actions.attachTerminal(id);
    expect(url).toBe(host.url);
    const socket = new WebSocket(url, HOST_PROTOCOL.terminalStream.subprotocol);
    socket.binaryType = 'arraybuffer';
    const texts: unknown[] = [];
    let restored = 0;
    let output = '';
    socket.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') {
        texts.push(JSON.parse(data));
        return;
      }
      const bytes = new Uint8Array(data as ArrayBuffer);
      if (bytes[0] === HOST_PROTOCOL.terminalStream.restore) restored += bytes.length - 1;
      if (bytes[0] === HOST_PROTOCOL.terminalStream.output) output += new TextDecoder().decode(bytes.subarray(1));
    });
    await new Promise((opened) => socket.addEventListener('open', opened, { once: true }));
    socket.send(JSON.stringify({ ticket, size: { cols: 70, rows: 20 }, codec: 'not the holder\'s' }));
    const opened = await waitFor(() => texts[0] as TerminalStreamOpened | undefined, 'the stream to open');
    expect(opened).toMatchObject({ restore: 'vt', terminal: { id, size: { cols: 70, rows: 20 } } });
    await waitFor(() => restored === opened.restoreBytes, 'the restore');
    socket.send(new Uint8Array([HOST_PROTOCOL.terminalStream.input, ...new TextEncoder().encode('echo hi-$((6*7))\r')]));
    await waitFor(() => output.includes('hi-42'), 'the output');
    // Typing made this device the one whose size the terminal takes.
    socket.send(JSON.stringify({ resize: { cols: 90, rows: 25 } }));
    await waitFor(() => texts.some((text) => JSON.stringify(text) === JSON.stringify({ resized: { cols: 90, rows: 25 } })), 'the new size, in order');
    await waitFor(() => store.snapshot().session?.terminals?.find((terminal) => terminal.id === id)?.size.cols === 90, 'the listed size');
    socket.close();

    await store.actions.closeTerminal(id);
    await waitFor(() => !store.snapshot().session?.terminals?.some((terminal) => terminal.id === id), 'the terminal to end');
    expect(store.snapshot().session?.terminals?.map((terminal) => terminal.id)).toEqual([other.id]);
  }, 60_000);
});
