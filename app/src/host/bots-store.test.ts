// The store's Bots (WVE-178) against a scripted Dispatcher: watched where it offers that, the
// changes it tells before the watch's answer made again on that answer, watched again after a
// reconnect; listed where it only keeps them; nothing where it keeps none.
import { describe, expect, it } from 'vitest';
import type { TransportEvents } from './connection';
import { DISPATCHER, type SocketOpener } from './dispatcher';
import { HOST_PROTOCOL } from './protocol';
import type { Bot } from './protocol';
import { HostStore } from './host-store';
import { type DispatcherRecord, memoryStorage } from './storage';

const PAIRED: DispatcherRecord = { dispatcherId: 'dispatcher-1', name: 'homelab', url: 'wss://homelab', deviceId: 'd-1', keyId: 'k' };
const { bots: BOTS, botsHome: BOTS_HOME, botsWatch: BOTS_WATCH } = HOST_PROTOCOL.dispatcher.features;

const bot = (id: string, name: string, change: Partial<Bot> = {}): Bot => ({
  id, name, agentId: 'claude', hostId: 'host-1', hostName: 'mac', connected: true, home: `/home/jaco/bots/${name.toLowerCase()}`,
  policy: { otherwise: 'ask' }, zone: 'UTC', pauseAfter: 43_200_000, threads: [], state: 'idle', createdAt: 0, updatedAt: 0, ...change,
});

/** A Dispatcher's API with `features`, whose answers `answer` may change; `told` sends a notification. */
function scriptedDispatcher(features: string[], answer: (method: string, params: unknown, notify: (method: string, params: unknown) => void) => unknown = () => undefined) {
  let api: TransportEvents | undefined;
  const asked: string[] = [];
  const notify = (method: string, params: unknown) => api?.message(JSON.stringify({ jsonrpc: '2.0', method, params }));
  const socket: SocketOpener = (_url, subprotocol) => async (transport) => {
    if (subprotocol !== DISPATCHER.subprotocol) throw new Error('no Hosts here');
    api = transport;
    let open = true;
    return {
      send(text: string) {
        const { id, method, params } = JSON.parse(text) as { id: number; method: string; params: unknown };
        asked.push(method);
        const result = method === 'dispatcher/challenge'
          ? { dispatcherId: PAIRED.dispatcherId, nonce: 'n', expiresAt: 0 }
          : method === 'dispatcher/hello'
            ? { protocol: DISPATCHER.protocol, version: '0', id: PAIRED.dispatcherId, device: { id: 'd-1', name: 'iPad' }, features }
            : method === 'hosts/list'
              ? { hosts: [] }
              : answer(method, params, notify) ?? {};
        queueMicrotask(() => { if (open) transport.message(JSON.stringify({ jsonrpc: '2.0', id, result })); });
      },
      close() { open = false; },
    };
  };
  return { socket, asked, notify, close: () => api?.closed({ code: 1006 }) };
}

const storeFor = (socket: SocketOpener) => new HostStore({
  storage: memoryStorage(PAIRED),
  keyFor: () => ({ publicKey: async () => ({ kty: 'EC', crv: 'P-256', x: '', y: '' }), sign: async () => 'signature', forget: async () => {} }),
  newKey: () => Promise.reject(new Error('no pairing here')),
  socket,
  client: { name: 'test', version: '0' },
  deviceName: 'iPad',
  backoff: [5],
  schedule: (notify) => queueMicrotask(notify),
});

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the store's Bots", () => {
  it('watches them, making what was told before the answer again on it, and keeps them up to date', async () => {
    const dispatcher = scriptedDispatcher([BOTS, BOTS_HOME, BOTS_WATCH], (method, _params, notify) => {
      if (method !== 'bots/watch') return undefined;
      // A change the Dispatcher told before it answered, which the answer's list doesn't have yet.
      notify('bots/updated', { bot: bot('b-1', 'Scout', { state: 'working', thread: 't-1' }) });
      notify('bots/updated', { bot: bot('b-3', 'Newcomer') });
      return { bots: [bot('b-1', 'Scout'), bot('b-2', 'Archivist')] };
    });
    const store = storeFor(dispatcher.socket);
    await store.start();
    await settle();
    const model = store.snapshot();
    expect(model.bots?.map(({ name, state, thread }) => [name, state, thread])).toEqual([
      ['Archivist', 'idle', undefined],
      ['Newcomer', 'idle', undefined],
      ['Scout', 'working', 't-1'],
    ]);
    expect(model.canAddBots).toBe(true);
    expect(dispatcher.asked.filter((method) => method === 'bots/list')).toEqual([]);

    dispatcher.notify('bots/updated', { bot: bot('b-2', 'Archivist', { state: 'needsYou', connected: false }) });
    dispatcher.notify('bots/removed', { bot: 'b-3' });
    await settle();
    expect(store.snapshot().bots?.map(({ name, state, connected }) => [name, state, connected])).toEqual([
      ['Archivist', 'needsYou', false],
      ['Scout', 'working', true],
    ]);

    // Its connection drops: the store watches them again once it's back.
    dispatcher.close();
    await settle(60);
    expect(dispatcher.asked.filter((method) => method === 'bots/watch')).toHaveLength(2);
    store.stop();
  });

  it('lists them from a Dispatcher that keeps Bots but tells nothing of them, and offers no New Bot without homes', async () => {
    const dispatcher = scriptedDispatcher([BOTS], (method) => method === 'bots/list' ? { bots: [bot('b-1', 'Scout')] } : undefined);
    const store = storeFor(dispatcher.socket);
    await store.start();
    await settle();
    expect(store.snapshot().bots?.map(({ name }) => name)).toEqual(['Scout']);
    expect(store.snapshot().canAddBots).toBeUndefined();
    expect(dispatcher.asked).not.toContain('bots/watch');
    store.stop();
  });

  it('has no Bots from a Dispatcher that keeps none', async () => {
    const dispatcher = scriptedDispatcher([]);
    const store = storeFor(dispatcher.socket);
    await store.start();
    await settle();
    expect(store.snapshot().bots).toBeUndefined();
    expect(dispatcher.asked.filter((method) => method.startsWith('bots/'))).toEqual([]);
    store.stop();
  });

  it("asks the Dispatcher to add, change and remove one, saying why when it won't", async () => {
    const dispatcher = scriptedDispatcher([BOTS, BOTS_HOME, BOTS_WATCH], (method, params) => {
      if (method === 'bots/watch') return { bots: [] };
      if (method === 'bots/add') return { bot: bot('b-9', (params as { name: string }).name) };
      if (method === 'schedules/list') return { schedules: [] };
      return undefined;
    });
    const store = storeFor(dispatcher.socket);
    await store.start();
    await settle();
    const added = await store.actions.addBot?.({ name: 'Watcher', hostId: 'host-1', agentId: 'claude', job: '  Watch the builds.  ' });
    expect(added?.name).toBe('Watcher');
    expect(store.snapshot().bots?.map(({ name }) => name)).toEqual(['Watcher']);
    await store.actions.removeBot?.('b-9');
    expect(store.snapshot().bots).toEqual([]);
    expect(await store.actions.botSchedules?.('b-9')).toEqual([]);
    dispatcher.close();
    await expect(store.actions.updateBot?.('b-9', { name: 'Other' })).rejects.toThrow(/can't be reached now/);
    store.stop();
  });
});
