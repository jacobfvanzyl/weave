// @vitest-environment node
/// <reference types="bun" />
// happy-dom's WebSocket fails the Host's upgrade; this file uses Bun's own, as the app uses WebKit's.
// The TypeScript client against a real dev Host (`testing/dev-host.ts`): pairing, device
// authentication, listing sessions and attaching after a journal position. A local client on
// the Host's Unix socket makes the pairing offers and the sessions, as `weave pair` and the TUI
// would. Skipped unless the debug `weave` and fake agent are built.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectError, HostConnection, type Credentials, type HostEvent, websocketConnector } from './connection';
import { webCryptoDeviceKey, type DeviceKey } from './device-key';
import { HOST_PROTOCOL, type SessionEventNotification } from './protocol';
import { devHostAvailable, startDevHost, unixConnector, type DevHost } from './testing/dev-host';

const client = { name: 'weave-app-test', version: '0.0.0' };

/** A connection and everything the Host sent it, in order. */
async function connect(credentials: Credentials, transport: 'local' | 'remote', host: DevHost) {
  const events: HostEvent[] = [];
  const connection = await HostConnection.connect({
    connector: transport === 'local' ? unixConnector(host.socket) : websocketConnector(host.url),
    client,
    credentials,
    onEvent: (event) => events.push(event),
  });
  return { connection, events };
}

const waitFor = async <T>(find: () => T | undefined, what: string, ms = 15_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await Bun.sleep(20);
  }
};

const sessionEvents = (events: HostEvent[], sessionId: string): SessionEventNotification[] =>
  events.flatMap((event) =>
    event.type === 'notification' && event.method === 'session/event' && event.params.sessionId === sessionId ? [event.params] : []);

describe.skipIf(!devHostAvailable())('a remote client of a dev Host', () => {
  let host: DevHost;
  let local: HostConnection;
  let localEvents: HostEvent[];
  let key: DeviceKey;
  let deviceId: string;
  let hostId: string;
  let sessionId: string;

  const offer = async () => (await local.request('devices/offer', {})).code;

  beforeAll(async () => {
    host = await startDevHost();
    ({ connection: local, events: localEvents } = await connect({ method: 'local' }, 'local', host));
    hostId = local.hello.host.id ?? '';
    key = await webCryptoDeviceKey();
  }, 60_000);

  afterAll(async () => {
    local?.close();
    await host?.stop();
  });

  it('pairs once with a code, and is that device from then on', async () => {
    const code = await offer();
    const { connection } = await connect({ method: 'pair', code, name: 'Test iPad', key }, 'remote', host);
    expect(connection.hello.device?.name).toBe('Test iPad');
    deviceId = connection.hello.device?.id ?? '';
    expect(deviceId).not.toBe('');
    expect(connection.hello.host.id).toBe(hostId);
    connection.close();

    const again = connect({ method: 'pair', code, name: 'Another', key: await webCryptoDeviceKey() }, 'remote', host);
    await expect(again).rejects.toMatchObject({ kind: 'refused' });
  });

  it('proves the device on every later connection', async () => {
    const { connection } = await connect({ method: 'device', deviceId, key, hostId }, 'remote', host);
    expect(connection.hello.device).toMatchObject({ id: deviceId, name: 'Test iPad' });
    connection.close();
  });

  it('is refused with the wrong key, and refuses a Host it did not pair with', async () => {
    const wrongKey = connect({ method: 'device', deviceId, key: await webCryptoDeviceKey() }, 'remote', host);
    await expect(wrongKey).rejects.toBeInstanceOf(ConnectError);
    await expect(wrongKey).rejects.toMatchObject({ kind: 'refused' });

    const otherHost = connect({ method: 'device', deviceId, key, hostId: 'another-host' }, 'remote', host);
    await expect(otherHost).rejects.toMatchObject({ kind: 'wrongHost' });
  });

  it('lists the sessions a local client started', async () => {
    local.open({ create: { agentId: 'fake', cwd: host.cwd } }, 1);
    const opened = await waitFor(() => localEvents.find((event) => event.type === 'opened' && event.tag === 1), 'the session');
    if (opened.type !== 'opened') throw new Error('unreachable');
    sessionId = opened.session.state.sessionId;
    await local.request('turn/start', { sessionId, prompt: [{ type: 'text', text: 'hello from the test' }] });
    await waitFor(() => sessionEvents(localEvents, sessionId).find(({ event }) => event.kind === 'turnEnded'), 'the turn to end');

    const { connection } = await connect({ method: 'device', deviceId, key, hostId }, 'remote', host);
    const { sessions } = await connection.request('sessions/list', {});
    expect(sessions.map(({ info }) => info.sessionId)).toContain(sessionId);
    expect(sessions.find(({ info }) => info.sessionId === sessionId)).toMatchObject({ agentId: 'fake', state: 'open' });
    connection.close();
  });

  it('attaches after a position and gets only what follows; from another journal, everything with reset', async () => {
    const { connection, events } = await connect({ method: 'device', deviceId, key, hostId }, 'remote', host);
    connection.open({ attach: { sessionId } }, 1);
    const first = await waitFor(() => events.find((event) => event.type === 'opened' && event.tag === 1), 'the attach');
    if (first.type !== 'opened') throw new Error(`attach failed: ${JSON.stringify(first)}`);
    const { journal } = first.session.state;
    expect(first.session.replay).toEqual({ from: 1, reset: true });
    const all = await waitFor(() => {
      const replayed = sessionEvents(events, sessionId);
      return replayed.at(-1)?.seq === journal.head ? replayed : undefined;
    }, 'the whole journal');
    expect(all.map(({ seq }) => seq)).toEqual(Array.from({ length: journal.head }, (_, index) => index + 1));
    expect(all.some(({ event }) => event.kind === 'turnStarted')).toBe(true);
    await connection.request('session/detach', { sessionId });
    connection.close();

    const after = 2;
    const second = await connect({ method: 'device', deviceId, key, hostId }, 'remote', host);
    second.connection.open({ attach: { sessionId, after: { journal: journal.id, seq: after } } }, 2);
    const reopened = await waitFor(() => second.events.find((event) => event.type === 'opened'), 'the second attach');
    if (reopened.type !== 'opened') throw new Error('attach failed');
    expect(reopened.session.replay).toEqual({ from: after + 1, reset: false });
    const rest = await waitFor(() => {
      const replayed = sessionEvents(second.events, sessionId);
      return replayed.at(-1)?.seq === journal.head ? replayed : undefined;
    }, 'the rest of the journal');
    expect(rest.map(({ seq }) => seq)).toEqual(Array.from({ length: journal.head - after }, (_, index) => after + 1 + index));
    // The answer came ahead of the replay that follows it.
    const order = second.events.filter((event) => event.type === 'opened' || event.type === 'notification');
    expect(order[0]?.type).toBe('opened');
    await second.connection.request('session/detach', { sessionId });
    second.connection.close();

    const third = await connect({ method: 'device', deviceId, key, hostId }, 'remote', host);
    third.connection.open({ attach: { sessionId, after: { journal: 'another-journal', seq: 1 } } }, 3);
    const reset = await waitFor(() => third.events.find((event) => event.type === 'opened'), 'the third attach');
    if (reset.type !== 'opened') throw new Error('attach failed');
    expect(reset.session.replay).toEqual({ from: 1, reset: true });
    third.connection.close();
  });

  it('is forbidden to administer the Host', async () => {
    const { connection } = await connect({ method: 'device', deviceId, key, hostId }, 'remote', host);
    await expect(connection.request('devices/list', {})).rejects.toMatchObject({ code: HOST_PROTOCOL.errors.forbidden });
    connection.close();
  });

  it('is closed with 4000 when its device is revoked, and the last one turns remote access off', async () => {
    const { connection, events } = await connect({ method: 'device', deviceId, key, hostId }, 'remote', host);
    await local.request('devices/revoke', { deviceId });
    const closed = await waitFor(() => events.find((event) => event.type === 'disconnected'), 'the close');
    expect(closed).toMatchObject({ code: HOST_PROTOCOL.websocket.closeRevoked });
    expect(connection.closed).toBe(true);
    expect((await local.request('host/status', {})).remote).toBeUndefined();
    await expect(connect({ method: 'device', deviceId, key, hostId }, 'remote', host)).rejects.toMatchObject({ kind: 'connection' });
  });
});
