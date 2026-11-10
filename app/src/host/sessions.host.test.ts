// @vitest-environment node
/// <reference types="bun" />
// A Session's layout, shared (ADR 0031, WVE-203): two devices paired with a dev Dispatcher reach a
// dev Host through it (`testing/dev-dispatcher.ts`), show the same Session, and each sees what the
// other does to its layout, with neither losing the other's change when both make one at once.
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
    // A thread prompted in the directory: its Host makes the Session, with no layout yet.
    const created = await pad.actions.createThread({ hostId, cwd: host.cwd, agentId: 'fake' });
    if (!created) throw new Error('no thread');
    const threadId = created.key.slice(created.key.indexOf('/') + 1);
    await pad.actions.send('hello');
    await waitFor(() => pad.snapshot().thread?.transcript.turn.status === 'stopped', 'the turn to end');
    const directory = realpathSync(host.cwd);
    await waitFor(() => mac.snapshot().known?.some((known) => known.directory === directory), 'the Mac to hear of the Session');

    // Nobody arranged it: each shows its open thread in one pane, and nothing is saved.
    pad.actions.selectSession?.(sessionKey(hostId, directory));
    mac.actions.selectSession?.(sessionKey(hostId, directory));
    await waitFor(() => mac.snapshot().session && mac.snapshot().threads.length === 1, 'the Mac to list the thread');
    expect(blocks(pad)).toEqual([threadId]);
    expect(blocks(mac)).toEqual([threadId]);
    expect(pad.snapshot().session?.saved).toBe(false);

    // The iPad splits it with a terminal's Block: the Mac shows that, and the Host keeps it.
    const first = layoutBlocks(pad.snapshot().session!.layout)[0];
    pad.actions.updateLayout?.(key(pad), (layout) => placeBlock(layout, terminalBlock('t-1', 'b-term'), { beside: first.id, side: 'right' }));
    await waitFor(() => blocks(mac).length === 2, 'the Mac to show the split');
    expect(mac.snapshot().session?.layout).toEqual(pad.snapshot().session?.layout);
    expect(mac.snapshot().session?.saved).toBe(true);
    await waitFor(() => pad.snapshot().session?.saved, 'the iPad to hear it was saved');

    // Both at once: the Mac adds a Block, the iPad closes one. Neither loses the other's.
    mac.actions.updateLayout?.(key(mac), (layout) => placeBlock(layout, threadBlock('elsewhere', 'b-else'), { into: 'b-term' }));
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
    pad.actions.updateLayout?.(created.sessionKey, (layout) => placeBlock(layout, threadBlock(threadId, 'b-new'), { tab: layout.tabs[0].id }));
    // Saved, it's the Host's Session, under the directory's real name, with what was placed.
    const session = await waitFor(() => pad.snapshot().session?.saved ? pad.snapshot().session : undefined, 'the Host to keep it');
    expect(session).toMatchObject({ key: sessionKey(hostId, realpathSync(real)), movedFrom: created.sessionKey });
    expect(blocks(pad)).toEqual([threadId]);
  }, 60_000);

  it('is there again for a device that starts later', async () => {
    const { store: late } = devStore({ deviceName: 'Late iPhone' });
    await late.start();
    await late.actions.pairDispatcher({ url: dispatcher.url, code: await dispatcher.offer() });
    late.actions.selectSession?.(key(mac));
    await waitFor(() => late.snapshot().session?.saved, 'the late device to show the Session');
    expect(late.snapshot().session?.layout).toEqual(mac.snapshot().session?.layout);
    late.stop();
  }, 60_000);
});
