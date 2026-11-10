// @vitest-environment node
/// <reference types="bun" />
// A Session's layout, shared (ADR 0031, WVE-203): two devices paired with a dev Dispatcher reach a
// dev Host through it (`testing/dev-dispatcher.ts`), show the same Session, and each sees what the
// other does to its layout, with neither losing the other's change when both make one at once.
// The Session is the one a device started, with what it gave a Block: the Host makes none itself.
// Skipped unless the debug `weave` and fake agent are built.
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionKey } from '@/app/app-controller';
import { terminalBlock, threadBlock, threadOf } from '@/session/blocks';
import { layoutBlocks, placeBlock, removeBlock } from '@/session/layout';
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

describe.skipIf(!devHostAvailable())('a Session two devices show', () => {
  let dispatcher: DevDispatcher;
  let host: DevHost;
  let hostId: string;
  let pad: HostStore;
  let mac: HostStore;
  /** The Session's key on each device, which follows the directory its Host names it by. */
  const key = (store: HostStore) => store.snapshot().session!.key;
  const blocks = (store: HostStore) => layoutBlocks(store.snapshot().session!.layout).map((block) => threadOf(block) ?? `${block.type}:${block.id}`);

  beforeAll(async () => {
    [dispatcher, host] = await Promise.all([startDevDispatcher(), startDevHost()]);
    hostId = await dispatcher.join(host, 'studio');
    ({ store: pad } = devStore({ deviceName: 'Test iPad' }));
    ({ store: mac } = devStore({ deviceName: 'Test Mac' }));
    for (const store of [pad, mac]) {
      await store.start();
      await store.actions.pairDispatcher({ url: dispatcher.url, code: await dispatcher.offer() });
      await waitFor(() => store.snapshot().hosts[0]?.status === 'connected', 'the Host to connect');
    }
  }, 60_000);

  afterAll(async () => {
    pad?.stop();
    mac?.stop();
    await host?.stop();
    await dispatcher?.stop();
  });

  it('is the same layout on both, each seeing what the other changes, and kept by the Host', async () => {
    // A thread prompted in the directory makes no Session: its Host leaves that to a client.
    const created = await pad.actions.createThread({ hostId, cwd: host.cwd, agentId: 'fake' });
    if (!created) throw new Error('no thread');
    const threadId = created.key.slice(created.key.indexOf('/') + 1);
    await pad.actions.send('hello');
    await waitFor(() => pad.snapshot().thread?.transcript.turn.status === 'stopped', 'the turn to end');
    const directory = realpathSync(host.cwd);
    await waitFor(() => mac.snapshot().threads.length === 1, 'the Mac to list the thread');
    expect(mac.snapshot().known).toEqual([]);

    // The iPad starts one there, by giving the thread a Block: an empty tab until then.
    pad.actions.selectSession?.(sessionKey(hostId, directory));
    await waitFor(() => pad.snapshot().session, 'the iPad to show the directory');
    expect(blocks(pad)).toEqual([]);
    expect(pad.snapshot().session).toMatchObject({ saved: false, own: { threads: [], terminals: [] } });
    pad.actions.updateLayout?.(key(pad), (layout) => placeBlock(layout, threadBlock(threadId, 'b-first'), { tab: layout.tabs[0].id }));
    pad.actions.addToSession?.(key(pad), { threads: [threadId], terminals: [] });
    // The Host keeps it, with the thread as its own, and the Mac hears of both.
    await waitFor(() => mac.snapshot().known?.some((known) => known.directory === directory && known.threads.includes(threadId)), 'the Mac to hear of the Session and its thread');
    mac.actions.selectSession?.(sessionKey(hostId, directory));
    await waitFor(() => mac.snapshot().session && blocks(mac).length === 1, 'the Mac to show the Block');
    expect(blocks(mac)).toEqual([threadId]);
    expect(mac.snapshot().session?.own).toEqual({ threads: [threadId], terminals: [] });
    await waitFor(() => pad.snapshot().session?.own?.threads.includes(threadId), 'the iPad to hear the thread is the Session\'s');

    // The iPad splits it with a terminal's Block: the Mac shows that, and the Host keeps it.
    const first = layoutBlocks(pad.snapshot().session!.layout)[0];
    pad.actions.updateLayout?.(key(pad), (layout) => placeBlock(layout, terminalBlock('t-1', 'b-term'), { beside: first.id, side: 'right' }));
    await waitFor(() => blocks(mac).length === 2, 'the Mac to show the split');
    expect(mac.snapshot().session?.layout).toEqual(pad.snapshot().session?.layout);
    expect(mac.snapshot().session?.saved).toBe(true);
    await waitFor(() => pad.snapshot().session?.saved, 'the iPad to hear it was saved');

    // Both at once: the Mac adds a Block, the iPad closes one. Neither loses the other's.
    mac.actions.updateLayout?.(key(mac), (layout) => placeBlock(layout, threadBlock('elsewhere', 'b-else'), { beside: 'b-term', side: 'down' }));
    pad.actions.updateLayout?.(key(pad), (layout) => removeBlock(layout, first.id));
    await waitFor(() => JSON.stringify(blocks(mac)) === JSON.stringify(['weave.terminal:b-term', 'elsewhere'])
      && JSON.stringify(blocks(pad)) === JSON.stringify(blocks(mac)), 'both to show both changes');
    expect(mac.snapshot().session?.layout).toEqual(pad.snapshot().session?.layout);
  }, 60_000);

  it("goes by its Host's name for its directory, when the device reached it by another", async () => {
    // A directory through a symbolic link, as `/tmp` is on a Mac: the thread starts in it by that name.
    const real = join(realpathSync(host.cwd), '..', 'real');
    const linked = join(host.cwd, '..', 'linked');
    mkdirSync(real);
    symlinkSync(real, linked);
    const created = await pad.actions.createThread({ hostId, cwd: linked, agentId: 'fake' });
    if (!created) throw new Error('no thread');
    pad.actions.selectSession?.(created.sessionKey);
    await waitFor(() => pad.snapshot().session?.key === created.sessionKey, 'the Session by the name it was asked for');
    const threadId = created.key.slice(created.key.indexOf('/') + 1);
    // Its Host has no Session there yet: an empty tab, with nothing saved.
    expect(blocks(pad)).toEqual([]);
    expect(pad.snapshot().session?.saved).toBe(false);
    expect(pad.snapshot().known?.some((known) => known.directory === realpathSync(real))).toBe(false);
    // The thread is given a Block: now the Host keeps the Session, with the thread as its own.
    pad.actions.updateLayout?.(created.sessionKey, (layout) => placeBlock(layout, threadBlock(threadId, 'b-linked'), { tab: layout.tabs[0].id }));
    // Saved, it's the Host's Session, under the directory's real name, with what it showed.
    const session = await waitFor(() => pad.snapshot().session?.saved ? pad.snapshot().session : undefined, 'the Host to keep it');
    expect(session).toMatchObject({ key: sessionKey(hostId, realpathSync(real)), movedFrom: created.sessionKey });
    expect(blocks(pad)).toEqual([threadId]);
    pad.actions.addToSession?.(key(pad), { threads: [threadId], terminals: [] });
    await waitFor(() => pad.snapshot().session?.own?.threads.includes(threadId), 'the thread to be the Session\'s');
  }, 60_000);

  it('is there again for a device that starts later', async () => {
    expect(mac.snapshot().hosts[0].canEndSessions).toBe(true);
    const { store: late } = devStore({ deviceName: 'Late iPhone' });
    await late.start();
    await late.actions.pairDispatcher({ url: dispatcher.url, code: await dispatcher.offer() });
    late.actions.selectSession?.(key(mac));
    await waitFor(() => late.snapshot().session?.saved, 'the late device to show the Session');
    expect(late.snapshot().session?.layout).toEqual(mac.snapshot().session?.layout);
    late.stop();
  }, 60_000);
});

describe.skipIf(!devHostAvailable())('a Session that ends', () => {
  it('is gone on every device, for good, and its thread closes with it, but not one that was never its', async () => {
    const [dispatcher, host] = await Promise.all([startDevDispatcher(), startDevHost()]);
    const hostId = await dispatcher.join(host, 'studio');
    const { store: pad } = devStore({ deviceName: 'Test iPad' });
    const { store: mac } = devStore({ deviceName: 'Test Mac' });
    try {
      for (const store of [pad, mac]) {
        await store.start();
        await store.actions.pairDispatcher({ url: dispatcher.url, code: await dispatcher.offer() });
        await waitFor(() => store.snapshot().hosts[0]?.status === 'connected', 'the Host to connect');
      }
      const prompted = async () => {
        const made = await pad.actions.createThread({ hostId, cwd: host.cwd, agentId: 'fake' });
        if (!made) throw new Error('no thread');
        await pad.actions.send('hello');
        await waitFor(() => pad.snapshot().thread?.key === made.key && pad.snapshot().thread?.transcript.turn.status === 'stopped', 'the turn to end');
        return made;
      };
      // Two threads in the directory: one a device made the Session's, one it never did, as one
      // started from a terminal there.
      const elsewhere = await prompted();
      const created = await prompted();
      const key = sessionKey(hostId, realpathSync(host.cwd));
      pad.actions.addToSession?.(key, { threads: [created.key.slice(created.key.indexOf('/') + 1)], terminals: [] });
      mac.actions.selectSession?.(key);
      await waitFor(() => mac.snapshot().session, 'the Mac to show it');

      // The Mac ends it: the iPad hears, the thread it had open closes, and nothing is left of it.
      await mac.actions.endSession?.(key);
      expect(mac.snapshot().session).toBeUndefined();
      await waitFor(() => pad.snapshot().known?.length === 0, 'the iPad to hear it ended');
      await waitFor(() => pad.snapshot().threads.find((thread) => thread.key === created.key)?.state === 'closed', 'its thread to close');
      // What was never its carries on.
      expect(pad.snapshot().threads.find((thread) => thread.key === elsewhere.key)?.state).toBe('open');
      await expect(mac.actions.endSession?.(key)).rejects.toThrow(/Couldn't end the Session/);
    } finally {
      pad.stop();
      mac.stop();
      await host.stop();
      await dispatcher.stop();
    }
  }, 60_000);
});
