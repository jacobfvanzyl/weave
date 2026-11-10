// @vitest-environment node
/// <reference types="bun" />
// This computer's own Host, as the Mac's app reaches it (ADR 0032, WVE-204): over its socket,
// as a local client (ADR 0030), with the Dispatcher listing it beside the person's other Hosts,
// which it carries. The local Host keeps working while the Dispatcher is away, and comes back on
// its socket after a restart without it. Against a real dev Dispatcher and two dev Hosts that
// joined it (`testing/dev-dispatcher.ts`); skipped unless the debug `weave` and fake agent are
// built.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppModel } from '@/app/app-controller';
import { websocketConnector } from './connection';
import type { HostStore } from './host-store';
import { type Routes, webRoutes } from './routes';
import { devStore, startDevDispatcher, type DevDispatcher } from './testing/dev-dispatcher';
import { devHostAvailable, devHostHasTerminals, startDevHost, unixConnector, type DevHost } from './testing/dev-host';

const waitFor = async <T,>(find: () => T | undefined | false, what: string, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await Bun.sleep(20);
  }
};

describe.skipIf(!devHostAvailable())("this computer's own Host, over its socket", () => {
  let dispatcher: DevDispatcher;
  let mac: DevHost;
  let homelab: DevHost;
  let macId: string;
  let homelabId: string;
  let store: HostStore;
  /** The Hosts the store had the Dispatcher carry a connection to, and how often it opened the socket. */
  const carried: string[] = [];
  const socketOpened = { count: 0 };
  /** The terminals' streams the store asked the core for. */
  const streams: { hostId: string; local: boolean }[] = [];
  const model = (): AppModel => store.snapshot();
  const host = (id: string) => model().hosts.find((summary) => summary.id === id);

  beforeAll(async () => {
    [dispatcher, mac, homelab] = await Promise.all([startDevDispatcher(), startDevHost(), startDevHost()]);
    macId = await dispatcher.join(mac, 'mac');
    homelabId = await dispatcher.join(homelab, 'homelab');
    const web = webRoutes((url, subprotocol) => websocketConnector(url, subprotocol));
    const local = unixConnector(mac.socket);
    const routes: Routes = {
      ...web,
      host(options) {
        carried.push(options.hostId);
        return web.host(options);
      },
      local: {
        find: async () => macId,
        connector: (events, signal) => {
          socketOpened.count += 1;
          return local(events, signal);
        },
      },
      terminalStream: async (options) => {
        streams.push(options);
        return `ws://127.0.0.1:1/${streams.length}`;
      },
    };
    ({ store } = devStore({ routes, deviceName: 'Test Mac' }));
    await store.start();
    await store.actions.pairDispatcher({ url: dispatcher.url, code: await dispatcher.offer() });
  }, 60_000);

  afterAll(async () => {
    store?.stop();
    await Promise.all([mac?.stop(), homelab?.stop(), dispatcher?.stop()]);
  });

  it('lists it with the Hosts the Dispatcher carries, and reaches it on its socket alone', async () => {
    await waitFor(() => host(macId)?.status === 'connected' && host(homelabId)?.status === 'connected', 'both Hosts to connect');
    expect(model().hosts.map(({ id }) => id).sort()).toEqual([macId, homelabId].sort());
    // The Dispatcher names it as it does every Host.
    expect(host(macId)?.name).toBe('mac');
    expect(carried).toContain(homelabId);
    expect(carried).not.toContain(macId);
    expect(socketOpened.count).toBe(1);
  });

  it.skipIf(!devHostHasTerminals())("opens a terminal's stream where the core offers it: on this Mac's socket, or carried", async () => {
    for (const [hostId, cwd, local] of [[macId, mac.cwd, true], [homelabId, homelab.cwd, false]] as const) {
      const created = await store.actions.createThread({ hostId, cwd, agentId: 'fake' });
      store.actions.selectSession?.(created?.sessionKey);
      await waitFor(() => model().session?.hostId === hostId && model().session?.terminals, "the Session's terminals");
      const id = await store.actions.newTerminal();
      // The Host's ticket, and the core's address in place of the Dispatcher's: nothing to carry.
      const ticket = await store.actions.attachTerminal(id);
      expect(ticket).toEqual({ url: `ws://127.0.0.1:1/${streams.length}`, ticket: expect.any(String) });
      expect(streams.at(-1)).toEqual({ hostId, local });
      await store.actions.closeTerminal(id);
    }
    store.actions.selectSession?.(undefined);
  });

  it('keeps working while the Dispatcher is away, and the Hosts it carries wait for it', async () => {
    await dispatcher.down();
    await waitFor(() => model().dispatcher?.status === 'reconnecting', 'the store to see the Dispatcher go');
    await waitFor(() => host(homelabId)?.status !== 'connected', 'homelab to drop with the Dispatcher');
    expect(host(macId)?.status).toBe('connected');
    await store.actions.createThread({ hostId: macId, cwd: mac.cwd, agentId: 'fake' });
    await waitFor(() => model().threads.some((thread) => thread.hostId === macId), 'a thread on this Mac');
  });

  it('comes back on its socket when it restarts, the Dispatcher still away', async () => {
    const before = socketOpened.count;
    await mac.restart();
    await waitFor(() => host(macId)?.status === 'connected' && socketOpened.count > before, 'this Mac to reconnect on its socket');
    expect(model().dispatcher?.status).not.toBe('connected');
    expect(carried).not.toContain(macId);
  });

  it('has the Dispatcher carry the others again once it comes back', async () => {
    await dispatcher.up();
    await waitFor(() => model().dispatcher?.status === 'connected', 'the Dispatcher to come back');
    await waitFor(() => host(homelabId)?.status === 'connected', 'homelab to reconnect through it');
    expect(host(macId)?.status).toBe('connected');
    expect(carried).not.toContain(macId);
  });
});
