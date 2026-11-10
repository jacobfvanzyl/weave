import { describe, expect, it } from 'vitest';
import { ConnectError } from '@/host/connection';
import type { DispatcherHello } from '@/host/protocol';
import { type Core, type Incoming, MAC_KEY, macRoutes, macStorage, relayed } from './routes';

/** A channel as Tauri's: the core calls `onmessage` with what the connection says. */
type FakeChannel = { onmessage: (incoming: Incoming) => void };

/** The core, as the page sees it: what it was asked, and the channels it was given. */
function fakeCore(answers: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const channels: FakeChannel[] = [];
  const core: Core = {
    async invoke<T>(command: string, args?: Record<string, unknown>) {
      calls.push({ command, args });
      const answer = answers[command];
      return (answer ? await answer(args ?? {}) : undefined) as T;
    },
    channel: () => {
      const channel: FakeChannel = { onmessage: () => {} };
      channels.push(channel);
      return channel as never;
    },
  };
  return { core, calls, channels };
}

const sent = (calls: { command: string; args?: Record<string, unknown> }[]) =>
  calls.filter(({ command }) => command === 'relay_send').flatMap(({ args }) => args?.texts as string[]);

describe('a connection the core relays', () => {
  it('passes what arrives to the page in order, and its end once', async () => {
    const { core, channels } = fakeCore({ open_local: () => 7 });
    const heard: string[] = [];
    const ends: unknown[] = [];
    await relayed(core, (channel) => core.invoke('open_local', { channel }))({
      message: (text) => heard.push(text),
      closed: (close) => ends.push(close),
    });
    channels[0].onmessage({ type: 'messages', texts: ['a', 'b'] });
    channels[0].onmessage({ type: 'messages', texts: ['c'] });
    channels[0].onmessage({ type: 'closed', code: 4001, reason: 'behind' });
    channels[0].onmessage({ type: 'messages', texts: ['after'] });
    expect(heard).toEqual(['a', 'b', 'c']);
    expect(ends).toEqual([{ code: 4001, reason: 'behind' }]);
  });

  it('sends in order, what the page sent meanwhile together', async () => {
    let release = () => {};
    const { core, calls } = fakeCore({
      open_local: () => 3,
      relay_send: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    const transport = await relayed(core, (channel) => core.invoke('open_local', { channel }))({ message() {}, closed() {} });
    transport.send('1');
    transport.send('2');
    transport.send('3');
    expect(sent(calls)).toEqual(['1']);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent(calls)).toEqual(['1', '2', '3']);
    expect(calls.filter(({ command }) => command === 'relay_send').at(-1)?.args).toEqual({ id: 3, texts: ['2', '3'] });
  });

  it('closes once, after which the page hears nothing more of it', async () => {
    const { core, calls, channels } = fakeCore({ open_local: () => 5 });
    const heard: string[] = [];
    const transport = await relayed(core, (channel) => core.invoke('open_local', { channel }))({ message: (text) => heard.push(text), closed() {} });
    transport.close();
    transport.close();
    transport.send('late');
    channels[0].onmessage({ type: 'messages', texts: ['late'] });
    expect(calls.filter(({ command }) => command === 'relay_close')).toEqual([{ command: 'relay_close', args: { id: 5 } }]);
    expect(sent(calls)).toEqual([]);
    expect(heard).toEqual([]);
  });

  it("says why the core couldn't open it, as the page's ConnectError", async () => {
    const { core } = fakeCore({
      open_host: () => { throw { kind: 'unavailable', message: 'homelab is asleep', data: { status: 'unreachable', why: 'homelab is asleep' } }; },
    });
    const opening = macRoutes(core).host({ pairing: undefined as never, hostId: 'h-1', client: { name: 't', version: '0' } })({ message() {}, closed() {} });
    const error = await opening.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectError);
    expect(error).toMatchObject({ kind: 'unavailable', message: 'homelab is asleep', data: { status: 'unreachable', why: 'homelab is asleep' } });
  });
});

describe("the Mac's routes", () => {
  const hello: DispatcherHello = { protocol: 1, version: '0', id: 'd-1', device: { id: 'dev-1', name: 'Mac' }, features: [] };

  it("take the Dispatcher's API already proved, with its hello", async () => {
    const { core, calls } = fakeCore({ open_dispatcher: () => ({ id: 9, hello }) });
    const connection = await macRoutes(core).dispatcher({ pairing: undefined as never, client: { name: 't', version: '0' }, onClosed() {} });
    expect(connection.hello).toEqual(hello);
    // Nothing was signed in the page, nor said there before the API was the page's.
    expect(sent(calls)).toEqual([]);
  });

  it('pair through the core, which keeps the key', async () => {
    const { core, calls } = fakeCore({ pair_dispatcher: () => ({ id: 2, hello }) });
    const connection = await macRoutes(core).pair({ url: 'wss://d', code: 'ABC', name: 'Mac', key: undefined as never, client: { name: 't', version: '0' }, onClosed() {} });
    expect(connection.hello.device?.id).toBe('dev-1');
    expect(calls[0]).toMatchObject({ command: 'pair_dispatcher', args: { url: 'wss://d', code: 'ABC', name: 'Mac' } });
  });

  it("find this Mac's Host, if one answers", async () => {
    expect(await macRoutes(fakeCore({ local_host: () => ({ hostId: 'h-mac' }) }).core).local?.find()).toBe('h-mac');
    expect(await macRoutes(fakeCore({ local_host: () => null }).core).local?.find()).toBeUndefined();
  });
});

describe("the Mac's pairing", () => {
  it("is the computer's, with the Hosts last listed kept beside it", async () => {
    localStorage.clear();
    const { core, calls } = fakeCore({ pairing: () => ({ url: 'wss://homelab', dispatcherId: 'd-1', deviceId: 'dev-1', name: 'homelab' }) });
    const storage = macStorage(core);
    expect(await storage.load()).toEqual({ url: 'wss://homelab', dispatcherId: 'd-1', deviceId: 'dev-1', name: 'homelab', keyId: MAC_KEY });
    await storage.save({ url: 'wss://homelab', dispatcherId: 'd-1', deviceId: 'dev-1', name: 'homelab', keyId: MAC_KEY, hosts: [{ id: 'h-1', name: 'homelab' }] });
    expect((await storage.load())?.hosts).toEqual([{ id: 'h-1', name: 'homelab' }]);
    // Forgetting it is the core's: the CLI's goes with it.
    await storage.save(undefined);
    expect(calls.at(-1)).toEqual({ command: 'forget_pairing', args: undefined });
  });

  it("drops Hosts kept for another Dispatcher", async () => {
    localStorage.clear();
    localStorage.setItem('weave.mac.hosts', JSON.stringify({ dispatcherId: 'd-old', hosts: [{ id: 'h-old', name: 'old' }] }));
    const { core } = fakeCore({ pairing: () => ({ url: 'wss://new', dispatcherId: 'd-new', deviceId: 'dev-2', name: 'new' }) });
    expect((await macStorage(core).load())?.hosts).toBeUndefined();
  });

  it('is none until the computer pairs', async () => {
    expect(await macStorage(fakeCore({ pairing: () => null }).core).load()).toBeUndefined();
  });
});
