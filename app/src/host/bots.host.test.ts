// @vitest-environment node
/// <reference types="bun" />
// Bots in the app (WVE-178), against a dev Dispatcher and a dev Host that joined it
// (`testing/dev-dispatcher.ts`): the store lists the Bots with their state as the Dispatcher
// watches them; a Bot's first prompt goes through `bots/send` and shows in the thread that starts;
// the Bot's Session is kept apart from the ordinary list; and its Thread Block follows it to a new
// thread. Each Bot's home is under the dev Host's directory, never the person's own `~/bots`.
// Skipped unless the debug `weave` and fake agent are built.
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionKey, threadKey } from '@/app/app-controller';
import { blocksText } from '@/chat/acp-transcript';
import { threadOf } from '@/session/blocks';
import { botLayout, lockedBlock } from '@/session/bots';
import { botSessionKey, ownThreads, sessionSummaries } from '@/session/sessions';
import type { HostStore } from './host-store';
import { HOST_PROTOCOL } from './protocol';
import { devStore, startDevDispatcher, type DevDispatcher } from './testing/dev-dispatcher';
import { devHostAvailable, startDevHost, type DevHost } from './testing/dev-host';

const waitFor = async <T,>(find: () => T | undefined | false, what: string, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await Bun.sleep(25);
  }
};

describe.skipIf(!devHostAvailable())('Bots in the app', () => {
  let dispatcher: DevDispatcher;
  let host: DevHost;
  let hostId: string;
  let pad: HostStore;
  let bots: boolean;
  /** Where the dev Host keeps its Bots' homes. */
  let homes: string;

  beforeAll(async () => {
    [dispatcher, host] = await Promise.all([startDevDispatcher(), startDevHost()]);
    hostId = await dispatcher.join(host, 'studio');
    homes = join(realpathSync(join(host.cwd, '..')), 'bots');
    mkdirSync(homes, { recursive: true });
    ({ store: pad } = devStore({ deviceName: 'Test iPad' }));
    await pad.start();
    await pad.actions.pairDispatcher({ url: dispatcher.url, code: await dispatcher.offer() });
    await waitFor(() => pad.snapshot().hosts[0]?.status === 'connected', 'the Host to connect');
    const features = (await dispatcher.local()).hello.features ?? [];
    bots = features.includes(HOST_PROTOCOL.dispatcher.features.botsWatch) && features.includes(HOST_PROTOCOL.dispatcher.features.botsHome);
  }, 60_000);

  afterAll(async () => {
    pad?.stop();
    await host?.stop();
    await dispatcher?.stop();
  });

  /** Adds a Bot with its home under the dev Host's directory, as `weave bots add` would on its computer. */
  const add = async (name: string) => {
    const { bot } = await (await dispatcher.local()).request('bots/add', { name, host: hostId, agentId: 'fake', home: join(homes, name.toLowerCase()), job: `${name} is for tests.` });
    return bot;
  };
  const listed = (id: string) => pad.snapshot().bots?.find((bot) => bot.id === id);

  it('lists the Bots with their state, and sends a first prompt that shows in the thread it starts', async (context) => {
    if (!bots) context.skip();
    const scout = await add('Scout');
    // Watched: the store hears of it without listing again.
    const seen = await waitFor(() => listed(scout.id), 'the store to hear of the Bot');
    expect(seen).toMatchObject({ name: 'Scout', hostId, state: 'idle', connected: true, threads: [] });
    expect(seen.thread).toBeUndefined();
    expect(pad.snapshot().canAddBots).toBe(true);

    await pad.actions.sendToBot?.(scout.id, 'hello from the app');
    const thread = await waitFor(() => listed(scout.id)?.thread, "the Bot's first thread");
    const key = threadKey(hostId, thread);
    // Its thread is the person's, though no Session has it yet: it's told of as any of theirs.
    await waitFor(() => pad.snapshot().threads.some((listing) => listing.key === key), 'the Host to list its thread');
    expect(ownThreads(pad.snapshot()).map((listing) => listing.key)).toContain(key);

    // Opened as the app does: its Session at its home, the thread first, then its Block top left.
    const session = await waitFor(() => botSessionKey(listed(scout.id)!, pad.snapshot().threads), "the Bot's Session");
    expect(session).toBe(sessionKey(hostId, realpathSync(join(homes, 'scout'))));
    pad.actions.selectSession?.(session);
    await waitFor(() => pad.snapshot().session?.key === session, 'the Session to show');
    pad.actions.addToSession?.(session, { threads: [thread], terminals: [] });
    pad.actions.updateLayout?.(session, (layout) => botLayout(layout, thread));
    pad.actions.showThreads?.([key], key);
    const transcript = await waitFor(() => {
      const open = pad.snapshot().open?.[key];
      return open && !open.loading && open.transcript.entries.some((entry) => entry.kind === 'message' && entry.role === 'user') ? open.transcript : undefined;
    }, 'the prompt in its transcript');
    const said = transcript.entries.flatMap((entry) => entry.kind === 'message' ? [blocksText(entry.chunks.filter(({ kind }) => kind === 'message').flatMap(({ content }) => content))] : []);
    expect(said.join('\n')).toContain('hello from the app');

    // Its Host keeps the Session, with the thread its own; the list of Sessions leaves it out.
    await waitFor(() => pad.snapshot().known?.some((known) => sessionKey(known.hostId, known.directory) === session && known.threads.includes(thread)), 'the Host to keep the Session');
    expect(sessionSummaries(pad.snapshot()).map(({ key: listedKey }) => listedKey)).not.toContain(session);
    expect(sessionSummaries({ ...pad.snapshot(), bots: [] }).map(({ key: listedKey }) => listedKey)).toContain(session);
    await waitFor(() => listed(scout.id)?.state === 'idle', 'the Bot to be idle after its turn');
  }, 90_000);

  it("has its Thread Block follow it to a new thread, the old one's leaving the layout", async (context) => {
    if (!bots) context.skip();
    const bot = await waitFor(() => pad.snapshot().bots?.find(({ name }) => name === 'Scout' && name), 'Scout');
    const before = bot.thread!;
    const session = botSessionKey(bot, pad.snapshot().threads)!;
    await waitFor(() => {
      const top = pad.snapshot().session?.layout && lockedBlock(pad.snapshot().session!.layout);
      return top && threadOf(top) === before;
    }, 'its Block to show its thread');

    await pad.actions.newBotThread?.(bot.id);
    // The Dispatcher has the old thread save its notes, then starts the new one.
    const after = await waitFor(() => {
      const now = listed(bot.id);
      return now && now.thread !== before && !now.startingThread ? now.thread : undefined;
    }, 'the new thread', 60_000);
    expect(listed(bot.id)?.threads.find(({ threadId }) => threadId === before)?.endedAt).toBeGreaterThan(0);

    // As the Bot's Session does on hearing it: the new thread the Session's, and its Block top left.
    pad.actions.addToSession?.(session, { threads: [after!], terminals: [] });
    pad.actions.updateLayout?.(session, (layout) => botLayout(layout, after!));
    await waitFor(() => {
      const shown = pad.snapshot().session;
      const top = shown && lockedBlock(shown.layout);
      return shown?.saved && top && threadOf(top) === after;
    }, 'its Block to follow the new thread');
    const layout = pad.snapshot().session!.layout;
    expect(layout.tabs).toHaveLength(1);
    expect(JSON.stringify(layout)).not.toContain(before);
    // And the Host kept it so, for every device.
    await waitFor(() => pad.snapshot().known?.some((known) => sessionKey(known.hostId, known.directory) === session && known.threads.includes(after!)), 'the Host to count the new thread its own');

    // The earlier thread, read from the Bot's page: its transcript, beside what's on screen.
    const old = threadKey(hostId, before);
    pad.actions.showThreads?.([threadKey(hostId, after!)], threadKey(hostId, after!));
    pad.actions.peekThread?.(old);
    const read = await waitFor(() => {
      const open = pad.snapshot().open?.[old];
      return open && !open.loading && open.transcript.entries.length > 0 ? open.transcript : undefined;
    }, 'the earlier thread to read');
    expect(JSON.stringify(read.entries)).toContain('hello from the app');
    expect(pad.snapshot().open?.[threadKey(hostId, after!)]).toBeDefined();
    pad.actions.peekThread?.(undefined);
    await waitFor(() => !pad.snapshot().open?.[old], 'the earlier thread to leave the screen');
  }, 120_000);
});
