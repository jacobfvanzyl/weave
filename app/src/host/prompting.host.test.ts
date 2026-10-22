// @vitest-environment node
/// <reference types="bun" />
// Prompting from the app against a real dev Host (`testing/dev-host.ts`), WVE-102: new sessions,
// prompts, steers, queued prompts, cancelling, modes and an agent that needs signing in. Skipped
// unless the debug `weave` and fake agent are built.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppModel, OpenSession } from '@/app/app-controller';
import { blocksText, type TranscriptEntry } from '@/chat/acp-transcript';
import { type Connector, HostConnection, websocketConnector } from './connection';
import { type DeviceKey, webCryptoDeviceKey } from './device-key';
import { HostStore } from './host-store';
import { memoryStorage } from './storage';
import { devHostAvailable, startDevHost, unixConnector, type DevHost } from './testing/dev-host';

const waitFor = async <T,>(find: () => T | undefined | false, what: string, ms = 15_000): Promise<T> => {
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
    const text = blocksText(entry.chunks.filter(({ kind }) => kind === 'message').flatMap(({ content }) => content));
    return `${entry.role}${entry.steer ? ' (steer)' : ''}${entry.optimistic ? ' (sending)' : ''}: ${text}`;
  }
  return entry.kind === 'diagnostic' ? `${entry.severity}: ${entry.title}` : entry.kind;
};

/** A PNG of one pixel. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe.skipIf(!devHostAvailable())('prompting from the app with a dev Host', () => {
  let host: DevHost;
  let local: HostConnection;
  let store: HostStore;
  let hostId: string;
  const keys = new Map<string, DeviceKey>();
  // Holds back the Host's notifications, but not its answers, while `held`.
  const gate = { held: false, queue: [] as (() => void)[] };
  const gated = (url: string): Connector => (events) => websocketConnector(url)({
    message(text) {
      const message = JSON.parse(text) as Record<string, unknown>;
      if (gate.held && 'method' in message && !('id' in message)) gate.queue.push(() => events.message(text));
      else events.message(text);
    },
    closed: events.closed,
  });
  const release = () => {
    gate.held = false;
    for (const deliver of gate.queue.splice(0)) deliver();
  };

  const model = (): AppModel => store.snapshot();
  const session = (): OpenSession => {
    const open = model().session;
    if (!open) throw new Error('No session is open.');
    return open;
  };
  const lines = () => session().transcript.entries.map(line);
  const until = (what: string, done: (lines: string[], open: OpenSession) => boolean, ms?: number) =>
    waitFor(() => model().session && done(lines(), session()) ? lines() : undefined, what, ms);
  const create = async (agentId: string) => {
    await store.actions.createSession({ hostId, cwd: host.cwd, agentId });
    return session();
  };
  const running = () => until('the turn to run, and the agent to answer', (current, open) =>
    open.transcript.turn.status === 'running' && current.some((entry) => entry.startsWith('assistant: Chunk')));

  beforeAll(async () => {
    host = await startDevHost();
    local = await HostConnection.connect({
      connector: unixConnector(host.socket),
      client: { name: 'weave-tui', version: '0' },
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
      connectorFor: gated,
      client: { name: 'weave-app-test', version: '0' },
      deviceName: 'Test iPad',
      backoff: [50],
      schedule: (notify) => queueMicrotask(notify),
    });
    await store.start();
    const { code } = await local.request('devices/offer', {});
    await store.actions.pairHost({ url: host.url, code });
    hostId = model().hosts[0].id;
  }, 60_000);

  afterAll(async () => {
    release();
    store?.stop();
    local?.close();
    await host?.stop();
  });

  it('starts a session and prompts it', async () => {
    const open = await create('fake');
    expect(open.transcript.entries).toEqual([]);
    expect(model().sessions.find(({ key }) => key === open.key)).toMatchObject({ agentId: 'fake', cwd: host.cwd, state: 'open' });
    expect(open.canAttachImages).toBe(true);
    await store.actions.send('hello there');
    expect(await until('the answer', (current) => current.includes('assistant: You said: hello there'))).toEqual([
      'user: hello there',
      'assistant: You said: hello there',
    ]);
    // Its own prompt carries no origin: it came from here.
    expect(session().transcript.entries[0]).not.toHaveProperty('origin');
  });

  it('sends photos with a prompt', async () => {
    await store.actions.send('What is this?', [{ mimeType: 'image/png', data: PIXEL }]);
    const shown = await until('the answer', (current) => current.some((entry) => entry.includes('You said: What is this? Attachments: image image/png')));
    // Shown once: the journaled prompt replaced the one shown while sending.
    expect(shown.slice(-2)).toEqual(['user: What is this?', 'assistant: You said: What is this? Attachments: image image/png.']);
    expect(shown.filter((entry) => entry === 'user: What is this?')).toHaveLength(1);
    const prompt = session().transcript.entries.at(-2);
    expect(prompt?.kind === 'message' && prompt.chunks[0].content.map(({ type }) => type)).toEqual(['text', 'image']);
  });

  it('steers a running turn', async () => {
    expect(session().canSteer).toBe(true);
    await store.actions.send('/slow 30');
    await running();
    await store.actions.send('Mention the steer.');
    const shown = await until('the steer to be answered', (current) => current.includes('assistant: You steered: Mention the steer.'));
    expect(shown).toContain('user (steer): Mention the steer.');
    await until('the turn to end', (_, open) => open.transcript.turn.status === 'stopped');
  });

  it('starts a turn with a steer that arrives after the turn ended', async () => {
    const sessionId = session().key.slice(hostId.length + 1);
    await store.actions.send('/slow 3');
    await running();
    // The app hears nothing more while the turn ends on the Host, so it still steers.
    gate.held = true;
    for (;;) {
      const { sessions } = await local.request('sessions/list', {});
      if (sessions.find(({ info }) => info.sessionId === sessionId)?.activity === 'idle') break;
      await Bun.sleep(50);
    }
    expect(session().transcript.turn.status).toBe('running');
    await store.actions.send('Too late to steer.');
    release();
    const shown = await until('the new turn', (current) => current.includes('assistant: You said: Too late to steer.'));
    expect(shown).toContain('user: Too late to steer.');
    expect(shown).not.toContain('user (steer): Too late to steer.');
  });

  it('cancels the running turn', async () => {
    await store.actions.send('/slow 50');
    await running();
    await store.actions.cancelTurn();
    const shown = await until('the turn to stop', (current, open) => open.transcript.turn.status === 'stopped' && current.includes('info: Turn cancelled'));
    expect(shown.at(-1)).toBe('info: Turn cancelled');
  });

  it('sets a mode and a config option, as every client sees them', async () => {
    await store.actions.setMode('code');
    await until('the mode', (_, open) => open.transcript.currentModeId === 'code');
    const model = session().transcript.configOptions.find(({ id }) => id === 'model');
    const other = model?.type === 'select'
      ? model.options.flatMap((item) => 'options' in item ? item.options : [item]).find(({ value }) => value !== model.currentValue)
      : undefined;
    expect(other).toBeDefined();
    await store.actions.setConfigOption('model', other!.value);
    await until('the config option', (_, open) =>
      open.transcript.configOptions.some((option) => option.id === 'model' && option.currentValue === other!.value));
  });

  it('queues a message while a turn runs in an agent that can\'t steer, and sends it after', async () => {
    await create('fake-minimal');
    await store.actions.send('/slow 4');
    await running();
    expect(session().canSteer).toBe(false);
    await store.actions.send('After that.');
    expect(session().queued).toMatchObject([{ text: 'After that.' }]);
    const shown = await until('the queued prompt to be answered', (current) => current.includes('assistant: You said: After that.'));
    expect(shown.filter((entry) => entry.startsWith('user'))).toEqual(['user: /slow 4', 'user: After that.']);
    expect(session().queued).toEqual([]);
  });

  it('closes a session nobody prompted when it leaves it', async () => {
    const blank = await create('fake');
    const sessionId = blank.key.slice(hostId.length + 1);
    store.actions.selectSession(undefined);
    for (let tries = 0; ; tries += 1) {
      const { sessions } = await local.request('host/status', {});
      if (!sessions.some(({ info }) => info.sessionId === sessionId)) break;
      if (tries > 200) throw new Error('The blank session stayed open.');
      await Bun.sleep(50);
    }
  });

  it('moves a session to a new agent process', async () => {
    await create('fake');
    await store.actions.send('before');
    await until('the answer', (current) => current.includes('assistant: You said: before'));
    await store.actions.reopenSession();
    expect(session().reopening).toBeUndefined();
    await until('the reopen', (current) => current.includes('info: Reopened this session in a new agent process'));
    await store.actions.send('after');
    await until('the answer from the new process', (current) => current.includes('assistant: You said: after'));
  });

  it('closes a session, then deletes it', async () => {
    const { key } = session();
    await store.actions.closeSession(key);
    expect(model().selectedKey).toBeUndefined();
    await waitFor(() => model().sessions.find((listed) => listed.key === key)?.state === 'closed', 'the session to close');
    await store.actions.deleteSession(key);
    expect(model().error).toBeUndefined();
    await waitFor(() => !model().sessions.some((listed) => listed.key === key), 'the session to go');
  });

  it('says to sign in on the Host\'s computer when the agent needs it', async () => {
    await expect(store.actions.createSession({ hostId, cwd: host.cwd, agentId: 'fake-auth' }))
      .rejects.toThrow(/needs signing in\. Run `weave login --agent fake-auth` on the Host's computer/);
  });

  it('lists the Host\'s directories, and starts a session in one picked there', async () => {
    expect(model().hosts[0].canBrowse).toBe(true);
    await mkdir(join(host.cwd, 'picked', 'deeper'), { recursive: true });
    const listed = await store.actions.listDirectory({ hostId, path: join(host.cwd, 'picked', '..') });
    expect(listed).toMatchObject({ path: host.cwd, directories: ['picked'], truncated: false });
    expect(listed.parent).toBe(dirname(host.cwd));
    const home = await store.actions.listDirectory({ hostId });
    expect(home.path).toBe(home.home);
    await expect(store.actions.listDirectory({ hostId, path: join(host.cwd, 'missing') }))
      .rejects.toThrow(`${join(host.cwd, 'missing')} doesn't exist`);

    await store.actions.createSession({ hostId, cwd: join(host.cwd, 'picked'), agentId: 'fake' });
    expect(model().sessions.find(({ key }) => key === session().key)?.cwd).toBe(join(host.cwd, 'picked'));
  });

  it('renames a session from the app, and its agent renames it through the Host too', async () => {
    const { key } = await create('fake');
    expect(model().hosts[0].canRename).toBe(true);
    await store.actions.send('hello');
    await until('the answer', (current) => current.includes('assistant: You said: hello'));
    const listedTitle = () => model().sessions.find((listed) => listed.key === key)?.title;

    await store.actions.renameSession(key, '  Named here ');
    await until('the rename', (current) => current.includes('info: You renamed this session to “Named here”'));
    await waitFor(() => listedTitle() === 'Named here', 'the listed title');
    await expect(store.actions.renameSession(key, ' ')).rejects.toThrow("Couldn't rename it: a title can't be empty.");

    await store.actions.send('/tool rename_session {"title": "Named by its agent"}');
    await until('the agent\'s rename', (current) => current.includes('info: The agent renamed this session to “Named by its agent”'));
    await waitFor(() => listedTitle() === 'Named by its agent', 'the agent\'s title');
    expect(session().transcript.title).toBe('Named by its agent');
  });
});
