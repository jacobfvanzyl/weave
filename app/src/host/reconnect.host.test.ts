// @vitest-environment node
/// <reference types="bun" />
// Reconnecting against a real dev Dispatcher and the dev Hosts that joined it
// (`testing/dev-dispatcher.ts`), WVE-105 and WVE-196: a network dropped mid-turn, a Host
// restarting under the app, the Dispatcher going away and coming back, a revoked device pairing
// again, and two Hosts at once. Skipped unless the debug `weave` and fake agent are built.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppModel, OpenThread } from '@/app/app-controller';
import { blocksText, type TranscriptEntry } from '@/chat/acp-transcript';
import { websocketConnector } from './connection';
import { DISPATCHER, type SocketOpener } from './dispatcher';
import type { HostStore } from './host-store';
import { devStore, startDevDispatcher, type DevDispatcher } from './testing/dev-dispatcher';
import { devHostAvailable, startDevHost, type DevHost } from './testing/dev-host';

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

/** What the agent said in a thread, every message of it together. */
const said = (open: OpenThread) => open.transcript.entries
  .flatMap((entry) => entry.kind === 'message' && entry.role === 'assistant' ? [line(entry).slice('assistant: '.length)] : [])
  .join('');

const slowChunks = (count: number) => Array.from({ length: count }, (_, index) => `Chunk ${index + 1} of ${count}.\n`).join('');

/**
 * WebSockets a test can take away as a network would: nothing more arrives either way, and the
 * app hears of it as an abnormal close. While `offline`, nothing connects.
 */
function network() {
  const live = new Set<() => void>();
  /** Connections opened: to the Dispatcher's API, and carried to a Host. */
  const state = { offline: false, opened: 0, api: 0 };
  const socket: SocketOpener = (url, subprotocol) => async (events, signal) => {
    if (state.offline) throw new Error('the network is down');
    let gone = false;
    let drop = () => {};
    const transport = await websocketConnector(url, subprotocol)({
      message(text) { if (!gone) events.message(text); },
      closed(close) {
        live.delete(drop);
        if (!gone) events.closed(close);
      },
    }, signal);
    if (subprotocol === DISPATCHER.subprotocol) state.api += 1;
    else state.opened += 1;
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
    socket,
    state,
    /** Takes the network away from every connection. */
    drop: () => { for (const drop of [...live]) drop(); },
  };
}

const pair = async (store: HostStore, dispatcher: DevDispatcher, name = 'Test iPhone') => {
  await store.actions.pairDispatcher({ url: dispatcher.url, code: await dispatcher.offer(), name });
};

describe.skipIf(!devHostAvailable())('reconnecting through a dev Dispatcher', () => {
  let dispatcher: DevDispatcher;
  let host: DevHost;
  const net = network();
  let store: HostStore;
  let storage: ReturnType<typeof devStore>['storage'];
  let forgotten: string[];
  let hostId: string;

  const model = (): AppModel => store.snapshot();
  const thread = (): OpenThread => {
    const open = model().thread;
    if (!open) throw new Error('No thread is open.');
    return open;
  };
  const until = (what: string, done: (open: OpenThread) => boolean, ms?: number) =>
    waitFor(() => model().thread && done(thread()) ? thread() : undefined, what, ms);
  const connected = (ms?: number) => waitFor(() => model().hosts.find(({ id }) => id === hostId)?.status === 'connected', 'the Host to be connected', ms);

  beforeAll(async () => {
    [dispatcher, host] = await Promise.all([startDevDispatcher(), startDevHost()]);
    hostId = await dispatcher.join(host, 'studio');
    ({ store, storage, forgotten } = devStore({ socket: net.socket, deviceName: 'Test iPhone', schedule: (notify) => queueMicrotask(notify) }));
    await store.start();
    await pair(store, dispatcher);
    expect(model().hosts).toMatchObject([{ id: hostId, name: 'studio', status: 'connected' }]);
  }, 60_000);

  afterAll(async () => {
    store?.stop();
    await host?.stop();
    await dispatcher?.stop();
  });

  it('catches up after a network dropped mid-turn, with every chunk once and in order', async () => {
    await store.actions.createThread({ hostId, cwd: host.cwd, agentId: 'fake' });
    await store.actions.send('/slow 40');
    const before = await until('a few chunks', (open) => said(open).includes('Chunk 3 of 40.'));

    net.state.offline = true;
    net.drop();
    await waitFor(() => model().dispatcher?.status === 'reconnecting', 'the app to notice');
    // The turn goes on in the Host while the app is away.
    await Bun.sleep(1_500);
    expect(said(thread())).not.toContain('Chunk 15 of 40.');
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
    // It joins the Dispatcher again by itself, a second or more after it starts.
    await connected(30_000);
    const resumed = await until('the interrupted turn to end', (open) =>
      open.transcript.turn.status !== 'running' && open.transcript.entries.some((entry) => line(entry) === 'info: Interrupted: the weave Host stopped while this turn ran'));
    // The Host continued the thread's journal, and the app went on after its position.
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

  it("keeps the Hosts it last listed while the Dispatcher can't be reached, and goes on once it can", async () => {
    const key = thread().key;
    const threads = model().threads.length;
    await dispatcher.down();
    await waitFor(() => model().dispatcher?.status === 'reconnecting', 'the app to say the Dispatcher is away');
    expect(model().dispatcher?.error).toBeTruthy();
    // The last list stays, its threads with it.
    expect(model().hosts).toMatchObject([{ id: hostId, name: 'studio' }]);
    expect(model().threads).toHaveLength(threads);
    expect(storage.current()?.hosts).toEqual([{ id: hostId, name: 'studio' }]);

    await dispatcher.up();
    await waitFor(() => model().dispatcher?.status === 'connected', 'the Dispatcher again', 30_000);
    await connected(30_000);
    expect(thread().key).toBe(key);
    await store.actions.send('after the Dispatcher came back');
    await until('the answer', (open) => open.transcript.entries.map(line).includes('assistant: You said: after the Dispatcher came back'));
  }, 60_000);

  it('forgets the pairing when the Dispatcher revokes the device, and pairs again', async () => {
    const local = await dispatcher.local();
    const { devices } = await local.request('devices/list', {});
    const device = devices.find(({ name }) => name === 'Test iPhone');
    expect(device).toBeDefined();
    await local.request('devices/revoke', { deviceId: device!.id });

    await waitFor(() => model().dispatcher?.status === 'revoked', 'the app to hear of it');
    expect(model().dispatcher?.error).toContain('Pair it again');
    expect(model().hosts).toEqual([]);
    expect(model().threads).toEqual([]);
    expect(model().thread).toBeUndefined();
    expect(storage.current()).toBeUndefined();
    expect(forgotten).toHaveLength(1);

    await pair(store, dispatcher);
    expect(model().dispatcher?.status).toBe('connected');
    expect(model().hosts).toMatchObject([{ id: hostId, status: 'connected' }]);
    expect(storage.current()?.deviceId).not.toBe(device!.id);
    await waitFor(() => model().threads.length > 0 || undefined, 'its threads again');
  }, 30_000);
});

describe.skipIf(!devHostAvailable())('two dev Hosts through one Dispatcher', () => {
  let dispatcher: DevDispatcher;
  let first: DevHost;
  let second: DevHost;
  let store: HostStore;
  let storage: ReturnType<typeof devStore>['storage'];

  beforeAll(async () => {
    [dispatcher, first, second] = await Promise.all([startDevDispatcher(), startDevHost(), startDevHost()]);
    await dispatcher.join(first, 'mac');
    await dispatcher.join(second, 'homelab');
    ({ store, storage } = devStore({ schedule: (notify) => queueMicrotask(notify) }));
    await store.start();
  }, 60_000);

  afterAll(async () => {
    store?.stop();
    await Promise.all([first?.stop(), second?.stop()]);
    await dispatcher?.stop();
  });

  it('pairs once and reaches each, and drops one the Dispatcher removes, with its threads', async () => {
    await pair(store, dispatcher);
    const hosts = store.snapshot().hosts;
    expect(hosts.map(({ name }) => name).sort()).toEqual(['homelab', 'mac']);
    expect(hosts.every(({ status }) => status === 'connected')).toBe(true);
    // One pairing, for both.
    expect(storage.current()?.hosts?.map(({ name }) => name).sort()).toEqual(['homelab', 'mac']);

    // A thread on each, both in the one list: the first from its Host's listing, once the second is on screen.
    const keys: string[] = [];
    for (const host of hosts) {
      await store.actions.createThread({ hostId: host.id, cwd: (host.name === 'mac' ? first : second).cwd, agentId: 'fake' });
      await store.actions.send('hello');
      keys.push(store.snapshot().thread!.key);
    }
    await waitFor(() => keys.every((key) => store.snapshot().threads.some((listed) => listed.key === key)) || undefined, 'both threads in the list');

    // `weave hosts remove mac` on the Dispatcher's computer: what it carried there closes, and the Host goes.
    const removed = hosts.find(({ name }) => name === 'mac')!;
    const kept = hosts.find(({ name }) => name === 'homelab')!;
    await (await dispatcher.local()).request('hosts/remove', { host: 'mac' });
    await waitFor(() => store.snapshot().hosts.length === 1 || undefined, 'the removed Host to go');
    expect(store.snapshot().hosts).toMatchObject([{ id: kept.id, status: 'connected' }]);
    expect(store.snapshot().threads.every(({ hostId }) => hostId === kept.id)).toBe(true);
    expect(store.snapshot().threads.some(({ hostId }) => hostId === removed.id)).toBe(false);
  }, 60_000);
});
