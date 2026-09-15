import { test, expect } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { BrowserGrantStore } from './browser-grants.ts';

test('Thread grants are explicit, durable, isolated and revision checked', async () => {
  const root = await mkdtemp('/tmp/weave-grants-'), a = crypto.randomUUID(), b = crypto.randomUUID(), profile = crypto.randomUUID();
  try {
    const store = await BrowserGrantStore.open(root);
    expect(store.get(a).profileIds).toEqual([]);
    const calls: string[] = []; store.subscribe(id => calls.push(id));
    await store.set(a, [profile], 0, async () => {});
    expect(store.get(b).profileIds).toEqual([]);
    expect(() => store.assert(b, profile)).toThrow();
    await expect(store.set(a, [], 0, async () => {})).rejects.toThrow('changed');
    await expect(store.set(a, [], 1, async () => { throw new Error('revoked human'); })).rejects.toThrow('revoked human');
    expect(store.get(a).profileIds).toEqual([profile]);
    const reopened = await BrowserGrantStore.open(root); expect(reopened.get(a)).toEqual(store.get(a));
    expect((await stat(root + '/browser-thread-grants.json')).mode & 0o777).toBe(0o600);
    await store.set(a, [], 1, async () => {}); expect(() => store.assert(a, profile)).toThrow();
    expect(calls).toEqual([a, a]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
