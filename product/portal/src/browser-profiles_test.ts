import { afterEach, expect, test } from 'bun:test';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BrowserProfiles } from './browser-service/profiles.ts';
import { BrowserServiceClient } from './browser-service/client.ts';
import { serveBrowserService } from './browser-service/service.ts';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function state() {
  const path = await mkdtemp('/tmp/weave-profiles-');
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
const binary = resolve(import.meta.dir, 'test-fixtures/fake-chromium.ts');

test('named Profiles survive catalog recreation; concurrent renames reject lost updates', async () => {
  const root = await state(), profiles = new BrowserProfiles(root);
  const [work, personal] = await Promise.all([profiles.create('Work'), profiles.create('Personal')]);
  expect(work.profileId).not.toBe(personal.profileId);
  const results = await Promise.allSettled([profiles.rename(work.profileId, 'Office', 0), profiles.rename(work.profileId, 'Client', 0)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  const restarted = new BrowserProfiles(root);
  expect((await restarted.require(work.profileId)).revision).toBe(1);
  expect((await restarted.list()).map(profile => profile.profileId)).toEqual([work.profileId, personal.profileId]);
  await expect(restarted.create(' personal ')).rejects.toThrow('already exists');
  expect((await lstat(join(root, 'browser-service/profiles.json'))).mode & 0o777).toBe(0o600);
});

test('malformed and unsafe Profile catalogs fail closed without replacing data', async () => {
  const root = await state(), profiles = new BrowserProfiles(root);
  await profiles.create('Work');
  const path = join(root, 'browser-service/profiles.json');
  await chmod(path, 0o644);
  await expect(profiles.create('Personal')).rejects.toThrow('Unsafe');
  await chmod(path, 0o600);
  await writeFile(path, '{broken');
  await expect(profiles.create('Personal')).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe('{broken');
  await rm(path);
  const target = join(root, 'external.json'); await writeFile(target, '{}', { mode: 0o600 });
  await symlink(target, path);
  await expect(profiles.list()).rejects.toThrow('Unsafe');
  expect(await readFile(target, 'utf8')).toBe('{}');
});

test('Profile IPC shares one runtime per identity, isolates data and retains catalog after owner restart', async () => {
  const root = await state();
  const first = await serveBrowserService({ stateDirectory: root, binary }); cleanup.push(() => first.close());
  const client = new BrowserServiceClient(root); cleanup.push(() => client.dispose());
  const { profile: work } = await client.profile('browser.profile.create', { name: 'Work' });
  const { profile: personal } = await client.profile('browser.profile.create', { name: 'Personal' });
  const [a, same] = await Promise.all([client.openProfile(work.profileId), client.openProfile(work.profileId)]);
  expect(same).toEqual(a);
  const b = await client.openProfile(personal.profileId);
  expect(b.pid).not.toBe(a.pid);
  await client.sendProfile(work.profileId, a.generation, 'Fixture.set', { value: 'work-only' });
  expect((await client.sendProfile(personal.profileId, b.generation, 'Fixture.read')).value).toBe('');
  await expect(client.sendProfile(personal.profileId, a.generation, 'Fixture.read')).rejects.toThrow('Stale');
  await expect(client.openProfile(crypto.randomUUID())).rejects.toThrow('unavailable');
  await client.profile('browser.profile.rename', { profileId: work.profileId, name: 'Office', expectedRevision: 0 });
  expect((await client.openProfile(work.profileId)).pid).toBe(a.pid);
  // Caller loss does not own or close the Profile runtime.
  client.dispose();
  const other = new BrowserServiceClient(root); cleanup.push(() => other.dispose());
  expect((await other.openProfile(work.profileId)).generation).toBe(a.generation);
  await first.close();
  const next = await serveBrowserService({ stateDirectory: root, binary }); cleanup.push(() => next.close());
  await expect(other.profile('browser.profile.list', {})).rejects.toThrow('Stale Browser Service');
  const fresh = new BrowserServiceClient(root); cleanup.push(() => fresh.dispose());
  expect((await fresh.profile('browser.profile.list', {})).profiles).toEqual([{ ...work, name: 'Office', revision: 1 }, personal]);
  const reopened = await fresh.openProfile(work.profileId);
  expect(reopened.generation).not.toBe(a.generation);
  expect((await fresh.sendProfile(work.profileId, reopened.generation, 'Fixture.read')).value).toBe('work-only');
  await expect(fresh.sendProfile(work.profileId, a.generation, 'Fixture.read')).rejects.toThrow('Stale');
  const profilePath = join(root, 'browser-service/profile-data', work.profileId);
  expect((await lstat(profilePath)).mode & 0o777).toBe(0o700);
  expect(await readFile(join(profilePath, 'fixture-state'), 'utf8')).toBe('work-only');
});

test('Profile runtime loss remains unavailable and cannot be replaced by another open call', async () => {
  const root = await state();
  const service = await serveBrowserService({ stateDirectory: root, binary }); cleanup.push(() => service.close());
  const client = new BrowserServiceClient(root); cleanup.push(() => client.dispose());
  const { profile } = await client.profile('browser.profile.create', { name: 'Work' });
  const opened = await client.openProfile(profile.profileId);
  await expect(client.sendProfile(profile.profileId, opened.generation, 'Fixture.disconnect')).rejects.toThrow('disconnected');
  const lost = await client.openProfile(profile.profileId);
  expect(lost.generation).toBe(opened.generation);
  expect(lost.available).toBe(false);
});
