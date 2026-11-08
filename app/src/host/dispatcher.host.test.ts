// @vitest-environment node
/// <reference types="bun" />
// happy-dom's WebSocket fails the Dispatcher's upgrade; this file uses Bun's own, as the app uses WebKit's.
// The TypeScript client against a dev Dispatcher and a dev Host that joined it
// (`testing/dev-dispatcher.ts`, ADR 0030): pairing with the Dispatcher, proving the device,
// listing the Hosts, and connections it carries to the Host, which list threads and attach after a
// journal position as the Host's own. A local client on the Host's Unix socket makes the threads,
// as the TUI would, and one on the Dispatcher's makes the offers and revokes, as `weave dispatcher
// pair` and `devices revoke` would. Skipped unless the debug `weave` and fake agent are built.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectError, HostConnection, type HostEvent, websocketConnector } from './connection';
import { webCryptoDeviceKey, type DeviceKey } from './device-key';
import { DISPATCHER, DispatcherConnection, type DispatcherPairing, carriedConnector } from './dispatcher';
import { HOST_PROTOCOL, type ThreadEventNotification } from './protocol';
import { devHostAvailable, startDevHost, unixConnector, type DevHost } from './testing/dev-host';
import { startDevDispatcher, type DevDispatcher } from './testing/dev-dispatcher';

const client = { name: 'weave-app-test', version: '0.0.0' };
const socket = (url: string, subprotocol: string) => websocketConnector(url, subprotocol);

const waitFor = async <T>(find: () => T | undefined, what: string, ms = 15_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await Bun.sleep(20);
  }
};

const threadEvents = (events: HostEvent[], threadId: string): ThreadEventNotification[] =>
  events.flatMap((event) =>
    event.type === 'notification' && event.method === 'thread/event' && event.params.threadId === threadId ? [event.params] : []);

describe.skipIf(!devHostAvailable())('a device paired with a dev Dispatcher', () => {
  let dispatcher: DevDispatcher;
  let host: DevHost;
  let local: HostConnection;
  let localEvents: HostEvent[];
  let key: DeviceKey;
  let pairing: DispatcherPairing;
  let hostId: string;
  let threadId: string;

  /** A connection the Dispatcher carries to the Host, and everything the Host sent it, in order. */
  const carried = async (as: DispatcherPairing = pairing, to = hostId) => {
    const events: HostEvent[] = [];
    const connection = await HostConnection.connect({
      connector: carriedConnector(socket, as, to, client),
      client,
      credentials: { method: 'dispatcher' },
      onEvent: (event) => events.push(event),
    });
    return { connection, events };
  };

  beforeAll(async () => {
    [dispatcher, host] = await Promise.all([startDevDispatcher(), startDevHost()]);
    localEvents = [];
    local = await HostConnection.connect({
      connector: unixConnector(host.socket),
      client,
      credentials: { method: 'local' },
      onEvent: (event) => localEvents.push(event),
    });
    hostId = await dispatcher.join(host, 'studio');
    expect(hostId).toBe(local.hello.host.id);
    key = await webCryptoDeviceKey();
  }, 60_000);

  afterAll(async () => {
    local?.close();
    await host?.stop();
    await dispatcher?.stop();
  });

  it('pairs once with a code, and is that device from then on', async () => {
    const code = await dispatcher.offer();
    const paired = await DispatcherConnection.connect({
      connector: socket(dispatcher.url, DISPATCHER.subprotocol),
      client,
      credentials: { method: 'pair', code, name: 'Test iPad', key },
    });
    expect(paired.hello.device?.name).toBe('Test iPad');
    pairing = { url: dispatcher.url, dispatcherId: paired.hello.id ?? '', deviceId: paired.hello.device?.id ?? '', key };
    expect(pairing.deviceId).not.toBe('');
    paired.close();

    const again = DispatcherConnection.connect({
      connector: socket(dispatcher.url, DISPATCHER.subprotocol),
      client,
      credentials: { method: 'pair', code, name: 'Another', key: await webCryptoDeviceKey() },
    });
    await expect(again).rejects.toMatchObject({ kind: 'unpaired' });
  });

  it('proves the device on every later connection, and lists the Hosts', async () => {
    const proved = await DispatcherConnection.connect({
      connector: socket(dispatcher.url, DISPATCHER.subprotocol),
      client,
      credentials: { method: 'device', ...pairing },
    });
    expect(proved.hello.device).toMatchObject({ id: pairing.deviceId, name: 'Test iPad' });
    const { hosts } = await proved.request('hosts/list', {});
    expect(hosts).toMatchObject([{ hostId, name: 'studio', connected: true, status: 'reachable' }]);
    proved.close();
  });

  it('is refused with the wrong key, or by another Dispatcher', async () => {
    const wrongKey = carried({ ...pairing, key: await webCryptoDeviceKey() });
    await expect(wrongKey).rejects.toBeInstanceOf(ConnectError);
    await expect(wrongKey).rejects.toMatchObject({ kind: 'unpaired' });

    const otherDispatcher = carried({ ...pairing, dispatcherId: 'another-dispatcher' });
    await expect(otherDispatcher).rejects.toMatchObject({ kind: 'unpaired' });
  });

  it('says why when the Dispatcher has no such Host', async () => {
    await expect(carried(pairing, 'no-such-host')).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('lists the threads a local client started, through the Dispatcher', async () => {
    local.open({ create: { agentId: 'fake', cwd: host.cwd } }, 1);
    const opened = await waitFor(() => localEvents.find((event) => event.type === 'opened' && event.tag === 1), 'the thread');
    if (opened.type !== 'opened') throw new Error('unreachable');
    threadId = opened.thread.state.threadId;
    await local.request('turn/start', { threadId, prompt: [{ type: 'text', text: 'hello from the test' }] });
    await waitFor(() => threadEvents(localEvents, threadId).find(({ event }) => event.kind === 'turnEnded'), 'the turn to end');

    const { connection } = await carried();
    // The Host takes the Dispatcher's word for the device.
    expect(connection.hello.device).toMatchObject({ id: pairing.deviceId, name: 'Test iPad' });
    expect(connection.hello.host.id).toBe(hostId);
    const { threads } = await connection.request('threads/list', {});
    expect(threads.map(({ info }) => info.sessionId)).toContain(threadId);
    expect(threads.find(({ info }) => info.sessionId === threadId)).toMatchObject({ agentId: 'fake', state: 'open' });
    connection.close();
  });

  it('attaches after a position and gets only what follows; from another journal, everything with reset', async () => {
    const { connection, events } = await carried();
    connection.open({ attach: { threadId } }, 1);
    const first = await waitFor(() => events.find((event) => event.type === 'opened' && event.tag === 1), 'the attach');
    if (first.type !== 'opened') throw new Error(`attach failed: ${JSON.stringify(first)}`);
    const { journal } = first.thread.state;
    expect(first.thread.replay).toEqual({ from: 1, reset: true });
    const all = await waitFor(() => {
      const replayed = threadEvents(events, threadId);
      return replayed.at(-1)?.seq === journal.head ? replayed : undefined;
    }, 'the whole journal');
    expect(all.map(({ seq }) => seq)).toEqual(Array.from({ length: journal.head }, (_, index) => index + 1));
    expect(all.some(({ event }) => event.kind === 'turnStarted')).toBe(true);
    await connection.request('thread/detach', { threadId });
    connection.close();

    const after = 2;
    const second = await carried();
    second.connection.open({ attach: { threadId, after: { journal: journal.id, seq: after } } }, 2);
    const reopened = await waitFor(() => second.events.find((event) => event.type === 'opened'), 'the second attach');
    if (reopened.type !== 'opened') throw new Error('attach failed');
    expect(reopened.thread.replay).toEqual({ from: after + 1, reset: false });
    const rest = await waitFor(() => {
      const replayed = threadEvents(second.events, threadId);
      return replayed.at(-1)?.seq === journal.head ? replayed : undefined;
    }, 'the rest of the journal');
    expect(rest.map(({ seq }) => seq)).toEqual(Array.from({ length: journal.head - after }, (_, index) => after + 1 + index));
    // The answer came ahead of the replay that follows it.
    const order = second.events.filter((event) => event.type === 'opened' || event.type === 'notification');
    expect(order[0]?.type).toBe('opened');
    await second.connection.request('thread/detach', { threadId });
    second.connection.close();

    const third = await carried();
    third.connection.open({ attach: { threadId, after: { journal: 'another-journal', seq: 1 } } }, 3);
    const reset = await waitFor(() => third.events.find((event) => event.type === 'opened'), 'the third attach');
    if (reset.type !== 'opened') throw new Error('attach failed');
    expect(reset.thread.replay).toEqual({ from: 1, reset: true });
    third.connection.close();
  });

  it('is forbidden to administer the Host', async () => {
    const { connection } = await carried();
    await expect(connection.request('devices/list', {})).rejects.toMatchObject({ code: HOST_PROTOCOL.errors.forbidden });
    connection.close();
  });

  it('is closed with 4000 when the Dispatcher revokes the device, and the last one turns its WebSocket off', async () => {
    const { connection, events } = await carried();
    const apiClosed: { code?: number }[] = [];
    const api = await DispatcherConnection.connect({
      connector: socket(dispatcher.url, DISPATCHER.subprotocol),
      client,
      credentials: { method: 'device', ...pairing },
      onClosed: (close) => apiClosed.push(close),
    });
    await (await dispatcher.local()).request('devices/revoke', { deviceId: pairing.deviceId });
    const closed = await waitFor(() => events.find((event) => event.type === 'disconnected'), 'the close');
    expect(closed).toMatchObject({ code: HOST_PROTOCOL.websocket.closeRevoked });
    expect(connection.closed).toBe(true);
    await waitFor(() => apiClosed[0], "the API's close");
    expect(apiClosed[0]).toMatchObject({ code: HOST_PROTOCOL.websocket.closeRevoked });
    expect(api.closed).toBe(true);
    expect((await (await dispatcher.local()).request('dispatcher/status', {})).remote).toBeUndefined();
    await expect(carried()).rejects.toMatchObject({ kind: 'connection' });
  });
});
