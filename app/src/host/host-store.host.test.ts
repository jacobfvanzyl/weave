// @vitest-environment node
/// <reference types="bun" />
// The app's Host store against a real dev Host (`testing/dev-host.ts`): pairing, the session list
// and a session's transcript, replayed and then live. Skipped unless the debug `weave` and fake
// agent are built.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppModel } from '@/app/app-controller';
import type { TranscriptEntry } from '@/chat/acp-transcript';
import { HostConnection, type HostEvent, websocketConnector } from './connection';
import { type DeviceKey, webCryptoDeviceKey } from './device-key';
import { HostStore } from './host-store';
import { memoryStorage } from './storage';
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

describe.skipIf(!devHostAvailable())('the Host store with a dev Host', () => {
  let host: DevHost;
  let local: HostConnection;
  const localEvents: HostEvent[] = [];
  let store: HostStore;
  let sessionId: string;
  const keys = new Map<string, DeviceKey>();

  const prompt = async (words: string) => {
    const before = localEvents.length;
    await local.request('turn/start', { sessionId, prompt: [{ type: 'text', text: words }] });
    await waitFor(() => localEvents.slice(before).some((event) =>
      event.type === 'notification' && event.method === 'session/event' && event.params.event.kind === 'turnEnded'), 'the turn to end');
  };

  beforeAll(async () => {
    host = await startDevHost();
    local = await HostConnection.connect({
      connector: unixConnector(host.socket),
      client: { name: 'weave-app-test', version: '0' },
      credentials: { method: 'local' },
      onEvent: (event) => localEvents.push(event),
    });
    local.open({ create: { agentId: 'fake', cwd: host.cwd } }, 1);
    const opened = await waitFor(() => localEvents.find((event) => event.type === 'opened'), 'the session');
    if (opened.type !== 'opened') throw new Error('unreachable');
    sessionId = opened.session.state.sessionId;
    await prompt('first words');

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
      deviceName: 'Test iPhone',
      backoff: [50],
    });
    await store.start();
  }, 60_000);

  afterAll(async () => {
    store?.stop();
    local?.close();
    await host?.stop();
  });

  it('pairs, then lists the Host\'s sessions', async () => {
    const { code } = await local.request('devices/offer', {});
    await store.actions.pairHost({ url: host.url, code, name: 'Test iPhone' });
    const model = store.snapshot();
    expect(model.hosts).toMatchObject([{ name: '127.0.0.1', status: 'connected' }]);
    expect(model.readOnly).toBe(true);
    const { devices } = await local.request('devices/list', {});
    expect(devices.map(({ name }) => name)).toContain('Test iPhone');
    const listed = await waitFor(() => store.snapshot().sessions.find((session) => session.sessionId === sessionId), 'the session in the list');
    expect(listed).toMatchObject({ agentId: 'fake', cwd: host.cwd, state: 'open' });
  });

  it('opens a session with its history, then follows it live', async () => {
    const key = store.snapshot().sessions.find((session) => session.sessionId === sessionId)!.key;
    store.actions.selectSession(key);
    const replayed = await waitFor(() => {
      const model: AppModel = store.snapshot();
      const lines = model.session?.transcript.entries.map(text).filter(Boolean) ?? [];
      return lines.length >= 2 ? lines : undefined;
    }, 'the replayed transcript');
    expect(replayed[0]).toBe('user: first words');
    expect(replayed[1]).toMatch(/^assistant: .*first words/);

    await prompt('second words');
    const live = await waitFor(() => {
      const lines = store.snapshot().session?.transcript.entries.map(text).filter(Boolean) ?? [];
      return lines.some((line) => line?.startsWith('assistant:') && line.includes('second words')) ? lines : undefined;
    }, 'the live turn');
    expect(live.filter((line) => line?.startsWith('user:'))).toEqual(['user: first words', 'user: second words']);
    expect(store.snapshot().session?.transcript.turn.status).toBe('stopped');
  });

  it('forgets a Host and its key', async () => {
    const [paired] = store.snapshot().hosts;
    await store.actions.forgetHost(paired.id);
    expect(store.snapshot().hosts).toEqual([]);
    expect(store.snapshot().sessions).toEqual([]);
    expect(store.snapshot().session).toBeUndefined();
  });
});
