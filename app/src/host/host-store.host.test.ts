// @vitest-environment node
/// <reference types="bun" />
// The app's Host store against a real dev Dispatcher and a dev Host that joined it
// (`testing/dev-dispatcher.ts`, ADR 0030): pairing with the Dispatcher, the Hosts it lists, the
// thread list and a thread's transcript, replayed and then live, all through the Dispatcher.
// Skipped unless the debug `weave` and fake agent are built.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppModel } from '@/app/app-controller';
import type { TranscriptEntry } from '@/chat/acp-transcript';
import { HostConnection, type HostEvent } from './connection';
import type { HostStore } from './host-store';
import { devStore, startDevDispatcher, type DevDispatcher } from './testing/dev-dispatcher';
import { devHostAvailable, startDevHost, unixConnector, type DevHost } from './testing/dev-host';

const waitFor = async <T,>(find: () => T | undefined, what: string, ms = 15_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await Bun.sleep(20);
  }
};

const text = (entry: TranscriptEntry) =>
  entry.kind === 'message'
    ? `${entry.role}: ${entry.chunks.flatMap((chunk) => chunk.content).map((block) => block.type === 'text' ? block.text : '').join('')}`
    : undefined;

describe.skipIf(!devHostAvailable())('the Host store with a dev Dispatcher and Host', () => {
  let dispatcher: DevDispatcher;
  let host: DevHost;
  let hostId: string;
  let local: HostConnection;
  const localEvents: HostEvent[] = [];
  let store: HostStore;
  let storage: ReturnType<typeof devStore>['storage'];
  let forgotten: string[];
  let threadId: string;

  const prompt = async (words: string) => {
    const before = localEvents.length;
    await local.request('turn/start', { threadId, prompt: [{ type: 'text', text: words }] });
    await waitFor(() => localEvents.slice(before).some((event) =>
      event.type === 'notification' && event.method === 'thread/event' && event.params.event.kind === 'turnEnded'), 'the turn to end');
  };

  beforeAll(async () => {
    [dispatcher, host] = await Promise.all([startDevDispatcher(), startDevHost()]);
    hostId = await dispatcher.join(host, 'studio');
    local = await HostConnection.connect({
      connector: unixConnector(host.socket),
      client: { name: 'weave-app-test', version: '0' },
      credentials: { method: 'local' },
      onEvent: (event) => localEvents.push(event),
    });
    local.open({ create: { agentId: 'fake', cwd: host.cwd } }, 1);
    const opened = await waitFor(() => localEvents.find((event) => event.type === 'opened'), 'the thread');
    if (opened.type !== 'opened') throw new Error('unreachable');
    threadId = opened.thread.state.threadId;
    await prompt('first words');

    ({ store, storage, forgotten } = devStore({ deviceName: 'Test iPhone' }));
    await store.start();
  }, 60_000);

  afterAll(async () => {
    store?.stop();
    local?.close();
    await host?.stop();
    await dispatcher?.stop();
  });

  it("shows the pairing screen until it's paired", () => {
    expect(store.snapshot()).toMatchObject({ hosts: [], threads: [] });
    expect(store.snapshot().dispatcher).toBeUndefined();
  });

  it("pairs with the Dispatcher, then lists its Hosts and the Host's threads", async () => {
    await store.actions.pairDispatcher({ url: dispatcher.url, code: await dispatcher.offer(), name: 'Test iPhone' });
    const model = store.snapshot();
    expect(model.dispatcher).toMatchObject({ url: dispatcher.url, status: 'connected' });
    expect(model.hosts).toMatchObject([{ id: hostId, name: 'studio', status: 'connected' }]);
    // The Dispatcher pairs the device, and the Host keeps no record of it.
    const { devices } = await (await dispatcher.local()).request('devices/list', {});
    expect(devices.map(({ name }) => name)).toEqual(['Test iPhone']);
    expect((await local.request('devices/list', {})).devices).toEqual([]);
    const listed = await waitFor(() => store.snapshot().threads.find((thread) => thread.threadId === threadId), 'the thread in the list');
    expect(listed).toMatchObject({ hostId, agentId: 'fake', cwd: host.cwd, state: 'open' });
  });

  it('opens a thread with its history, then follows it live', async () => {
    const key = store.snapshot().threads.find((thread) => thread.threadId === threadId)!.key;
    store.actions.selectThread(key);
    const replayed = await waitFor(() => {
      const model: AppModel = store.snapshot();
      const lines = model.thread?.transcript.entries.map(text).filter(Boolean) ?? [];
      return lines.length >= 2 ? lines : undefined;
    }, 'the replayed transcript');
    expect(replayed[0]).toBe('user: first words');
    expect(replayed[1]).toMatch(/^assistant: .*first words/);

    await prompt('second words');
    const live = await waitFor(() => {
      const lines = store.snapshot().thread?.transcript.entries.map(text).filter(Boolean) ?? [];
      return lines.some((line) => line?.startsWith('assistant:') && line.includes('second words')) ? lines : undefined;
    }, 'the live turn');
    expect(live.filter((line) => line?.startsWith('user:'))).toEqual(['user: first words', 'user: second words']);
    expect(store.snapshot().thread?.transcript.turn.status).toBe('stopped');
  });

  it('pairs again in place of the pairing before', async () => {
    const before = storage.current()!;
    await store.actions.pairDispatcher({ url: dispatcher.url, code: await dispatcher.offer(), name: 'Test iPhone' });
    expect(storage.current()?.deviceId).not.toBe(before.deviceId);
    expect(forgotten).toEqual([before.keyId]);
    expect(store.snapshot().hosts).toMatchObject([{ id: hostId, status: 'connected' }]);
  });

  it('forgets the Dispatcher and its key', async () => {
    const { keyId } = storage.current()!;
    await store.actions.forgetDispatcher();
    expect(store.snapshot().dispatcher).toBeUndefined();
    expect(store.snapshot().hosts).toEqual([]);
    expect(store.snapshot().threads).toEqual([]);
    expect(store.snapshot().thread).toBeUndefined();
    expect(storage.current()).toBeUndefined();
    expect(forgotten.at(-1)).toBe(keyId);
  });
});
