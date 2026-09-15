import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserProfiles } from './browser-service/profiles.ts';
import { ManagedBrowserPages, type ManagedRuntime } from './browser-service/managed-pages.ts';
import type { ManagedBrowserEvent, ManagedPage } from './browser-service/managed-process.ts';

class FixtureRuntime implements ManagedRuntime {
  available = true;
  pages = new Map<string, ManagedPage>();
  listeners = new Set<(event: ManagedBrowserEvent) => void>();
  creations = 0;
  subscribe(listener: (event: ManagedBrowserEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(method: string, params: ManagedPage) {
    for (const listener of this.listeners) listener({ method, params });
  }
  async request<T = any>(method: string, params: any = {}): Promise<T> {
    if (!this.available) throw new Error('Fixture runtime lost');
    if (method === 'page.create') {
      this.creations++;
      await Bun.sleep(5);
      const page = { ...params, title: '', width: 800, height: 600, rfbSocket: '/private/fixture.sock', canGoBack: false, canGoForward: false };
      this.pages.set(page.pageId, page);
      this.emit('page.created', page);
      return page;
    }
    if (method === 'page.close') {
      const page = this.pages.get(params.pageId)!;
      this.pages.delete(params.pageId);
      this.emit('page.closed', page);
    }
    return {} as T;
  }
  async close() {
    for (const page of this.pages.values()) this.emit('page.closed', page);
    this.pages.clear();
    this.available = false;
  }
}

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp('/tmp/weave-managed-pages-');
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const profiles = new BrowserProfiles(root);
  const a = await profiles.create('Work'), b = await profiles.create('Personal');
  const runtimes: FixtureRuntime[] = [];
  const factory = async () => { const runtime = new FixtureRuntime(); runtimes.push(runtime); return runtime; };
  const directory = join(root, 'managed-pages');
  const pages = new ManagedBrowserPages(directory, '/fixture', profiles, factory);
  cleanup.push(() => pages.close());
  return { pages, profiles, directory, a, b, runtimes, factory };
}

test('concurrent retries produce one live page; a Profile reuses its runtime and another Profile does not', async () => {
  const { pages, a, b, runtimes } = await fixture();
  const id = crypto.randomUUID();
  const [first, retry] = await Promise.all([
    pages.create(a.profileId, id, 'https://example.com/'),
    pages.create(a.profileId, id, 'https://example.com/'),
  ]);
  expect(retry.available).toBe(true);
  expect(retry.generation).toBe(first.generation);
  expect(runtimes[0]!.creations).toBe(1);
  const same = await pages.create(a.profileId, crypto.randomUUID(), 'about:blank');
  const other = await pages.create(b.profileId, crypto.randomUUID(), 'about:blank');
  expect(same.generation).toBe(first.generation);
  expect(other.generation).not.toBe(first.generation);
  await expect(pages.create(b.profileId, id, 'about:blank')).rejects.toThrow('another Profile');
});

test('shutdown retains identities and restart requires explicit Restore with a new command generation', async () => {
  const { pages, profiles, directory, factory, a } = await fixture();
  const original = await pages.create(a.profileId, crypto.randomUUID(), 'https://example.com/');
  await pages.close();
  const restarted = new ManagedBrowserPages(directory, '/fixture', profiles, factory);
  cleanup.push(() => restarted.close());
  expect((await restarted.list())[0]).toMatchObject({ pageId: original.pageId, available: false });
  const restored = await restarted.restore(original.pageId);
  expect(restored.generation).not.toBe(original.generation);
  await expect(restarted.command(original.pageId, original.generation!, 'page.reload')).rejects.toThrow('Stale');
  await restarted.closePage(restored.pageId, restored.generation);
  expect(await restarted.list()).toEqual([]);
});

test('runtime loss is visible and a retry cannot silently recreate live page state', async () => {
  const { pages, runtimes, a } = await fixture();
  const original = await pages.create(a.profileId, crypto.randomUUID(), 'about:blank');
  runtimes[0]!.available = false;
  expect((await pages.create(a.profileId, original.pageId, 'about:blank')).available).toBe(false);
  expect(runtimes).toHaveLength(1);
  const restored = await pages.restore(original.pageId);
  expect(restored.available).toBe(true);
  expect(restored.generation).not.toBe(original.generation);
  expect(runtimes).toHaveLength(2);
});

test('popups inherit the owning Profile; late title changes cannot resurrect a closed page', async () => {
  const { pages, runtimes, a } = await fixture();
  const origin = await pages.create(a.profileId, crypto.randomUUID(), 'about:blank');
  const popup = { ...runtimes[0]!.pages.get(origin.pageId)!, pageId: crypto.randomUUID(), openerPageId: origin.pageId };
  runtimes[0]!.emit('page.created', popup);
  expect((await pages.list()).find(page => page.pageId === popup.pageId)).toMatchObject({ profileId: a.profileId, openerPageId: origin.pageId });
  runtimes[0]!.emit('page.closed', popup);
  runtimes[0]!.emit('page.changed', { ...popup, title: 'Late title' });
  expect((await pages.list()).map(page => page.pageId)).toEqual([origin.pageId]);
});

test('failed catalog writes are not returned as persisted pages on retry', async () => {
  const { pages, directory, a, runtimes } = await fixture();
  await pages.list();
  // Make atomic replacement fail without relying on root-sensitive chmod behavior.
  await mkdir(join(directory, 'pages.json'));
  const id = crypto.randomUUID();
  await expect(pages.create(a.profileId, id, 'about:blank')).rejects.toThrow();
  expect(runtimes).toHaveLength(0);
  await rm(join(directory, 'pages.json'), { recursive: true });
  expect(await pages.list()).toEqual([]);
  expect((await pages.create(a.profileId, id, 'about:blank')).available).toBe(true);
});

test('invalid URLs cannot create a runtime and shutdown rejects new lifecycle work', async () => {
  const { pages, a, runtimes } = await fixture();
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:secret@example.com']) {
    await expect(pages.create(a.profileId, crypto.randomUUID(), url)).rejects.toThrow();
  }
  expect(runtimes).toHaveLength(0);
  await pages.close();
  await expect(pages.create(a.profileId, crypto.randomUUID(), 'about:blank')).rejects.toThrow('stopping');
});


test('live runtime metadata cannot override the validated durable title and URL', async () => {
  const { pages, runtimes, a } = await fixture();
  const original = await pages.create(a.profileId, crypto.randomUUID(), 'https://example.com/');
  const changed = { ...runtimes[0]!.pages.get(original.pageId)!, title: 'x'.repeat(2000), url: 'chrome-error://chromewebdata/' };
  runtimes[0]!.emit('page.changed', changed);
  const page = (await pages.list())[0]!;
  expect(page.title).toHaveLength(1024);
  expect(page.url).toBe('https://example.com/');
  expect(page.available).toBe(true);
});

test('unprofiled Panes isolate storage and closing removes only their temporary identity', async () => {
  const { pages, profiles, a, runtimes } = await fixture();
  const first = await pages.create(undefined, crypto.randomUUID(), 'about:blank');
  const second = await pages.create(undefined, crypto.randomUUID(), 'about:blank');
  expect(first.temporary).toBe(true); expect(first.profileLocked).toBe(false);
  expect(second.profileId).not.toBe(first.profileId);
  const storage = await profiles.dataDirectory(first.profileId);
  await mkdir(storage, {recursive:true}); await Bun.write(join(storage,'cookie-fixture'),'signed in');
  await pages.closePage(first.pageId,first.generation);
  expect(await Bun.file(join(storage,'cookie-fixture')).exists()).toBe(false);
  expect((await profiles.list()).map(item=>item.profileId)).not.toContain(first.profileId);
  expect((await pages.list())[0]?.pageId).toBe(second.pageId);
  expect(await profiles.require(a.profileId)).toEqual(a);
  expect(runtimes[0]?.available).toBe(false);
});

test('a blank Pane can choose or clear a Profile; first named navigation locks selection durably', async () => {
  const { pages, profiles, directory, factory, a, b } = await fixture();
  const first = await pages.create(undefined, crypto.randomUUID(), 'about:blank');
  const selected = await pages.selectProfile(first.pageId,first.profileId,a.profileId);
  expect(selected.pageId).toBe(first.pageId); expect(selected.profileLocked).toBe(false);
  const cleared = await pages.selectProfile(selected.pageId,selected.profileId);
  expect(cleared.temporary).toBe(true);
  const named = await pages.selectProfile(cleared.pageId,cleared.profileId,b.profileId);
  await pages.command(named.pageId,named.generation!,'page.navigate',{url:'https://example.com/'});
  await pages.command(named.pageId,named.generation!,'page.navigate',{url:'about:blank'});
  await expect(pages.selectProfile(named.pageId,named.profileId,a.profileId)).rejects.toThrow('locked');
  await pages.close();
  const restarted = new ManagedBrowserPages(directory,'/fixture',profiles,factory); cleanup.push(()=>restarted.close());
  await expect(restarted.selectProfile(named.pageId,named.profileId)).rejects.toThrow('locked');
});

test('selecting a Profile after temporary browsing reopens the URL and locks it', async () => {
  const { pages, a } = await fixture();
  const first = await pages.create(undefined,crypto.randomUUID(),'https://example.com/');
  const selected = await pages.selectProfile(first.pageId,first.profileId,a.profileId);
  expect(selected).toMatchObject({pageId:first.pageId,url:first.url,temporary:false,profileLocked:true});
});
