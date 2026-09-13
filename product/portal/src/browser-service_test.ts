import { afterEach, expect, test } from 'bun:test';
import { chmod, lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ChromiumProcess } from './browser-service/chromium.ts';
import { BrowserServiceClient } from './browser-service/client.ts';
import { serveBrowserService } from './browser-service/service.ts';
import { workspaceKey } from './browser-service/owner.ts';

const binary = resolve(import.meta.dir, 'test-fixtures/fake-chromium.ts');
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), 'wb-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function service() {
  const state = await mkdtemp('/tmp/wb-');
  cleanup.push(() => rm(state, { recursive: true, force: true }));
  const service = await serveBrowserService({ stateDirectory: state, binary });
  cleanup.push(() => service.close());
  const client = new BrowserServiceClient(state);
  cleanup.push(() => client.dispose());
  return { state, service, client };
}

test('independent callers retain the same browser and persistent Workspace profile', async () => {
  const { state, client } = await service();
  const [a, duplicate] = await Promise.all([client.openWorkspace('workspace-a'), client.openWorkspace('workspace-a')]);
  expect(duplicate).toEqual(a);
  await client.send('workspace-a', a.generation, 'Fixture.set', { value: 'retained' });
  client.dispose();
  const next = new BrowserServiceClient(state); cleanup.push(() => next.dispose());
  const restored = await next.openWorkspace('workspace-a');
  expect(restored.pid).toBe(a.pid);
  expect(restored.generation).toBe(a.generation);
  expect((await next.send('workspace-a', a.generation, 'Fixture.read')).value).toBe('retained');
  await next.closeWorkspace('workspace-a', a.generation);
  const reopened = await next.openWorkspace('workspace-a');
  expect(reopened.generation).not.toBe(a.generation);
  expect((await next.send('workspace-a', reopened.generation, 'Fixture.read')).value).toBe('retained');
  await expect(next.send('workspace-a', a.generation, 'Fixture.set', { value: 'stale' })).rejects.toThrow('Stale');
});

test('Workspace profiles and command generations are isolated', async () => {
  const { state, client, service: running } = await service();
  const a = await client.openWorkspace('../workspace-a');
  const b = await client.openWorkspace('workspace-b');
  await client.send('../workspace-a', a.generation, 'Fixture.set', { value: 'only-a' });
  expect((await client.send('workspace-b', b.generation, 'Fixture.read')).value).toBe('');
  await expect(client.send('workspace-b', a.generation, 'Fixture.read')).rejects.toThrow('Stale');
  expect((await lstat(running.path)).mode & 0o777).toBe(0o600);
  const profile = join(state, 'browser-service/profiles', workspaceKey('../workspace-a'));
  expect((await lstat(profile)).mode & 0o777).toBe(0o700);
  expect(await readFile(join(profile, 'fixture-state'), 'utf8')).toBe('only-a');
});

test('browser loss stays unavailable instead of silently replacing live state', async () => {
  const { client } = await service();
  const a = await client.openWorkspace('a');
  await expect(client.send('a', a.generation, 'Fixture.disconnect')).rejects.toThrow('disconnected');
  const lost = await client.openWorkspace('a');
  expect(lost.generation).toBe(a.generation);
  expect(lost.available).toBe(false);
  await expect(client.send('a', a.generation, 'Fixture.read')).rejects.toThrow('disconnected');
});

test('profile exclusion preserves files and startup failure releases only its lock', async () => {
  const directory = await temporary();
  const browser = await ChromiumProcess.launch({ binary, directory }); cleanup.push(() => browser.close());
  await expect(ChromiumProcess.launch({ binary, directory })).rejects.toThrow('already owned');
  expect(browser.available).toBe(true);
  await browser.close();
  await expect(ChromiumProcess.launch({ binary: '/nonexistent/weave-chromium', directory })).rejects.toThrow();
  const replacement = await ChromiumProcess.launch({ binary, directory }); cleanup.push(() => replacement.close());
  expect(replacement.available).toBe(true);
});

test('unsafe profiles are rejected; CDP events and errors retain upstream behavior', async () => {
  const directory = await temporary();
  await chmod(directory, 0o755);
  await expect(ChromiumProcess.launch({ binary, directory })).rejects.toThrow('private');
  await chmod(directory, 0o700);
  const linked = directory + '-link'; await symlink(directory, linked); cleanup.push(() => rm(linked));
  await expect(ChromiumProcess.launch({ binary, directory: linked })).rejects.toThrow('private');
  const browser = await ChromiumProcess.launch({ binary, directory }); cleanup.push(() => browser.close());
  const events: unknown[] = [];
  browser.subscribe(event => events.push(event));
  await browser.send('Fixture.event', {}, 'session-a');
  expect(events).toEqual([{ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'fixture' } }, sessionId: 'session-a' }]);
  await expect(browser.send('Fixture.fail')).rejects.toThrow('Fixture error');
});

test('existing live service is never replaced and closed clients cannot reopen', async () => {
  const { state, client } = await service();
  await expect(serveBrowserService({ stateDirectory: state, binary })).rejects.toThrow('Another Host');
  client.dispose();
  await expect(client.list()).rejects.toThrow('closed');
});

test('service restart requires a fresh handshake and oversized calls cannot mutate state', async () => {
  const { state, client, service: first } = await service();
  await client.open();
  await first.close();
  const next = await serveBrowserService({ stateDirectory: state, binary }); cleanup.push(() => next.close());
  await expect(client.list()).rejects.toThrow('Stale Browser Service');
  const fresh = new BrowserServiceClient(state); cleanup.push(() => fresh.dispose());
  const browser = await fresh.openWorkspace('a');
  await expect(fresh.send('a', browser.generation, 'Fixture.set', { value: 'x'.repeat(1024 * 1024) })).rejects.toThrow('too large');
  expect((await fresh.send('a', browser.generation, 'Fixture.read')).value).toBe('');
});

test('configured clients start one independent owner and disposing callers preserves it', async () => {
  const state = await mkdtemp('/tmp/wb-start-');
  const a = new BrowserServiceClient(state, binary), b = new BrowserServiceClient(state, binary);
  let pid: number | undefined;
  try {
    await Promise.all([a.open(), b.open()]);
    pid = a.ownerPid;
    expect(pid).toBe(b.ownerPid); expect(pid).not.toBe(process.pid);
    a.dispose(); b.dispose();
    expect(() => process.kill(pid!, 0)).not.toThrow();
  } finally {
    a.dispose(); b.dispose();
    if (pid) {
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); await Bun.sleep(20); }
        catch { break; }
      }
    }
    await rm(state, { recursive: true, force: true });
  }
});
