// @vitest-environment node
/// <reference types="bun" />
// Reconnecting against real dev Hosts (`testing/dev-host.ts`), WVE-105: a network dropped mid-turn,
// a Host restarting under the app, a revoked device pairing again, and two Hosts at once. Skipped
// unless the debug `weave` and fake agent are built.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppModel, OpenSession } from '@/app/app-controller';
import { blocksText, type TranscriptEntry } from '@/chat/acp-transcript';
import { type Connector, HostConnection, websocketConnector } from './connection';
import { type DeviceKey, webCryptoDeviceKey } from './device-key';
import { HostStore, type HostStoreOptions } from './host-store';
import { memoryStorage } from './storage';
import { devHostAvailable, startDevHost, unixConnector, type DevHost } from './testing/dev-host';

const waitFor = async <T,>(find: () => T | undefined | false, what: string, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await Bun.sleep(20);
  }
};

const line = (entry: TranscriptEntry) => {
  if (entry.kind === 'message') {
    return `${entry.role}: ${blocksText(entry.chunks.filter(({ kind }) => kind === 'message').flatMap(({ content }) => content))}`;
  }
  return entry.kind === 'diagnostic' ? `${entry.severity}: ${entry.title}` : entry.kind;
};

/** What the agent said in a session, every message of it together. */
const said = (open: OpenSession) => open.transcript.entries
  .flatMap((entry) => entry.kind === 'message' && entry.role === 'assistant' ? [line(entry).slice('assistant: '.length)] : [])
  .join('');

const slowChunks = (count: number) => Array.from({ length: count }, (_, index) => `Chunk ${index + 1} of ${count}.\n`).join('');

/**
 * WebSockets a test can take away as a network would: nothing more arrives either way, and the
 * app hears of it as an abnormal close. While `offline`, nothing connects.
 */
function network() {
  const live = new Set<() => void>();
  const state = { offline: false, opened: 0 };
  const connector = (url: string): Connector => async (events, signal) => {
    if (state.offline) throw new Error('the network is down');
    let gone = false;
    let drop = () => {};
    const transport = await websocketConnector(url)({
      message(text) { if (!gone) events.message(text); },
      closed(close) {
        live.delete(drop);
        if (!gone) events.closed(close);
      },
    }, signal);
    state.opened += 1;
    drop = () => {
      gone = true;
      live.delete(drop);
      transport.close();
      events.closed({ code: 1006, reason: 'the network went away' });
    };
    live.add(drop);
    return {
      send: (message) => { if (!gone) transport.send(message); },
      close: () => {
        live.delete(drop);
        transport.close();
      },
    };
  };
  return {
    connector,
    state,
    /** Takes the network away from every connection. */
    drop: () => { for (const drop of [...live]) drop(); },
  };
}

/** A store pairing with WebCrypto keys, which says which of them it forgot. */
function appStore(options: Partial<HostStoreOptions> = {}) {
  const keys = new Map<string, DeviceKey>();
  const forgotten: string[] = [];
  const store = new HostStore({
    storage: memoryStorage(),
    keyFor: (keyId) => keys.get(keyId)!,
    async newKey() {
      const keyId = crypto.randomUUID();
      const key = await webCryptoDeviceKey();
      keys.set(keyId, { ...key, forget: async () => { forgotten.push(keyId); } });
      return { keyId, key: keys.get(keyId)! };
    },
    connectorFor: (url) => websocketConnector(url),
    client: { name: 'weave-app-test', version: '0' },
    deviceName: 'Test iPhone',
    backoff: [50],
    schedule: (notify) => queueMicrotask(notify),
    ...options,
  });
  return { store, forgotten };
}

const local = (host: DevHost) => HostConnection.connect({
  connector: unixConnector(host.socket),
  client: { name: 'weave-tui', version: '0' },
  credentials: { method: 'local' },
  onEvent: () => {},
});

const pair = async (store: HostStore, host: DevHost, name = 'Test iPhone') => {
  const tui = await local(host);
  const { code } = await tui.request('devices/offer', {});
  tui.close();
  await store.actions.pairHost({ url: host.url, code, name });
};

describe.skipIf(!devHostAvailable())('reconnecting to a dev Host', () => {
  let host: DevHost;
  const net = network();
  let store: HostStore;
  let storage: ReturnType<typeof memoryStorage>;
  let forgotten: string[];
  let hostId: string;

  const model = (): AppModel => store.snapshot();
  const session = (): OpenSession => {
    const open = model().session;
    if (!open) throw new Error('No session is open.');
    return open;
  };
  const until = (what: string, done: (open: OpenSession) => boolean, ms?: number) =>
    waitFor(() => model().session && done(session()) ? session() : undefined, what, ms);
  const connected = () => waitFor(() => model().hosts.find(({ id }) => id === hostId)?.status === 'connected', 'the Host to be connected');

  beforeAll(async () => {
    host = await startDevHost();
    storage = memoryStorage();
    ({ store, forgotten } = appStore({ storage, connectorFor: net.connector }));
    await store.start();
    await pair(store, host);
    hostId = model().hosts[0].id;
  }, 60_000);

  afterAll(async () => {
    store?.stop();
    await host?.stop();
  });

  it('catches up after a network dropped mid-turn, with every chunk once and in order', async () => {
    await store.actions.createSession({ hostId, cwd: host.cwd, agentId: 'fake' });
    await store.actions.send('/slow 40');
    const before = await until('a few chunks', (open) => said(open).includes('Chunk 3 of 40.'));

    net.state.offline = true;
    net.drop();
    await waitFor(() => model().hosts[0].status === 'reconnecting', 'the app to notice');
    // The turn goes on in the Host while the app is away.
    await Bun.sleep(1_500);
    expect(said(session())).not.toContain('Chunk 15 of 40.');
    const opened = net.state.opened;
    net.state.offline = false;

    await connected();
    const ended = await until('the turn to end', (open) => open.transcript.turn.status !== 'running' && said(open).includes('Chunk 40 of 40.'), 30_000);
    expect(said(ended)).toBe(slowChunks(40));
    expect(net.state.opened).toBe(opened + 1);
    // Attached after its position: the transcript went on, rather than starting over.
    expect(ended.transcript.entries[0]).toBe(before.transcript.entries[0]);
  }, 60_000);

  it('catches up after the Host restarts under it, its interrupted turn ended', async () => {
    await store.actions.send('/slow 40');
    const before = await until('a few chunks', (open) => said(open).split('Chunk 3 of 40.').length === 3);

    await host.restart();
    await connected();
    const resumed = await until('the interrupted turn to end', (open) =>
      open.transcript.turn.status !== 'running' && open.transcript.entries.some((entry) => line(entry) === 'info: Turn cancelled'));
    // The Host continued the session's journal, and the app went on after its position.
    expect(resumed.transcript.entries[0]).toBe(before.transcript.entries[0]);
    const lines = resumed.transcript.entries.map(line);
    expect(lines.filter((entry) => entry === 'user: /slow 40')).toHaveLength(2);
    // Nothing repeated: the second turn's chunks run on from where the restart cut them.
    const second = said(resumed).slice(slowChunks(40).length);
    expect(slowChunks(40).startsWith(second)).toBe(true);

    await store.actions.send('after the restart');
    const answered = await until('the answer', (open) => open.transcript.entries.map(line).includes('assistant: You said: after the restart'));
    expect(answered.transcript.entries.map(line).slice(-2)).toEqual(['user: after the restart', 'assistant: You said: after the restart']);
  }, 60_000);

  it('forgets the pairing when the Host revokes the device, and pairs again', async () => {
    const tui = await local(host);
    const { devices } = await tui.request('devices/list', {});
    const device = devices.find(({ name }) => name === 'Test iPhone');
    expect(device).toBeDefined();
    await tui.request('devices/revoke', { deviceId: device!.id });
    tui.close();

    await waitFor(() => model().hosts[0]?.status === 'revoked', 'the app to hear of it');
    expect(model().hosts[0].error).toContain('Pair it again');
    expect(model().sessions).toEqual([]);
    expect(model().session).toBeUndefined();
    expect(await storage.load()).toEqual([]);
    expect(forgotten).toHaveLength(1);

    await pair(store, host);
    expect(model().hosts).toMatchObject([{ id: hostId, status: 'connected' }]);
    expect(await storage.load()).toHaveLength(1);
    await waitFor(() => model().sessions.length > 0 || undefined, 'its sessions again');
  }, 30_000);
});

describe.skipIf(!devHostAvailable())('two dev Hosts', () => {
  let first: DevHost;
  let second: DevHost;
  let store: HostStore;
  let forgotten: string[];
  const storage = memoryStorage();

  beforeAll(async () => {
    [first, second] = await Promise.all([startDevHost(), startDevHost()]);
    ({ store, forgotten } = appStore({ storage }));
    await store.start();
  }, 60_000);

  afterAll(async () => {
    store?.stop();
    await Promise.all([first?.stop(), second?.stop()]);
  });

  it('keeps a connection and a device id for each, and forgets one with its key', async () => {
    await pair(store, first);
    await pair(store, second);
    const hosts = store.snapshot().hosts;
    expect(hosts).toHaveLength(2);
    expect(hosts.every(({ status }) => status === 'connected')).toBe(true);
    expect(new Set(hosts.map(({ id }) => id)).size).toBe(2);
    const records = await storage.load();
    expect(new Set(records.map(({ deviceId }) => deviceId)).size).toBe(2);
    expect(new Set(records.map(({ keyId }) => keyId)).size).toBe(2);

    // A session on each, both in the one list: the first from its Host's listing, once the second is on screen.
    const keys: string[] = [];
    for (const [index, host] of hosts.entries()) {
      await store.actions.createSession({ hostId: host.id, cwd: [first, second][index].cwd, agentId: 'fake' });
      await store.actions.send('hello');
      keys.push(store.snapshot().session!.key);
    }
    await waitFor(() => keys.every((key) => store.snapshot().sessions.some((listed) => listed.key === key)) || undefined, 'both sessions in the list');

    await store.actions.forgetHost(hosts[0].id);
    expect(forgotten).toEqual([records.find(({ hostId }) => hostId === hosts[0].id)!.keyId]);
    expect(store.snapshot().hosts).toMatchObject([{ id: hosts[1].id, status: 'connected' }]);
    expect(store.snapshot().sessions.every(({ hostId }) => hostId === hosts[1].id)).toBe(true);
    expect((await storage.load()).map(({ hostId }) => hostId)).toEqual([hosts[1].id]);
  }, 60_000);
});
