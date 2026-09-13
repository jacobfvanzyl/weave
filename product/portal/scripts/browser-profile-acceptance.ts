import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BrowserServiceClient } from '../src/browser-service/client.ts';

// Own all processes and disposable profiles. Never use installed Portal state or personal browser data.
const binary = process.env.CHROME_BINARY;
if (!binary) throw new Error('Set CHROME_BINARY to the explicitly selected Chromium executable');
const state = await mkdtemp('/tmp/weave-profile-acceptance-');
const owners: ReturnType<typeof Bun.spawn>[] = [];
const clients: BrowserServiceClient[] = [];
const output = new Map<number, Promise<string>>();
let passed = false;
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
async function start() {
  const command = process.env.BROWSER_SERVICE_BINARY
    ? [process.env.BROWSER_SERVICE_BINARY, state, binary!]
    : [process.execPath, resolve(import.meta.dir, '../src/browser-service/main.ts'), state, binary!];
  const owner = Bun.spawn(command, { stdout: 'ignore', stderr: 'pipe' }); owners.push(owner);
  output.set(owner.pid, new Response(owner.stderr).text());
  const client = new BrowserServiceClient(state); clients.push(client);
  for (let i = 0; i < 100; i++) {
    if (owner.exitCode !== null) throw new Error('Profile owner exited before readiness');
    try { await client.open(); return { owner, client }; } catch { await Bun.sleep(50); }
  }
  throw new Error('Profile owner startup timed out');
}
async function stop(owner: ReturnType<typeof Bun.spawn>) {
  if (owner.exitCode !== null) { assert(owner.exitCode === 0, 'Browser Service failed'); return; }
  owner.kill('SIGTERM');
  await Promise.race([owner.exited, Bun.sleep(15000)]);
  if (owner.exitCode === null) {
    owner.kill('SIGKILL'); await owner.exited;
    throw new Error('Browser Service shutdown timed out');
  }
  assert(owner.exitCode === 0, `Browser Service failed: ${await output.get(owner.pid)}`);
}
try {
  const first = await start(); let client = first.client;
  const { profile: work } = await client.profile('browser.profile.create', { name: 'Work' });
  const { profile: personal } = await client.profile('browser.profile.create', { name: 'Personal' });
  const [a, duplicate] = await Promise.all([client.openProfile(work.profileId), client.openProfile(work.profileId)]);
  const b = await client.openProfile(personal.profileId);
  assert(duplicate.pid === a.pid && duplicate.generation === a.generation, 'Concurrent requests replaced runtime');
  assert(a.pid !== b.pid, 'Profiles shared a browser process');
  const send = (method: string, params: object = {}, sessionId?: string) => client.sendProfile(work.profileId, a.generation, method, params, sessionId);
  await send('Storage.setCookies', { cookies: [{ name: 'profile_acceptance', value: 'work-only', domain: 'weave-acceptance.test', path: '/', expires: Math.floor(Date.now() / 1000) + 3600 }] });
  assert(!(await client.sendProfile(personal.profileId, b.generation, 'Storage.getCookies')).cookies.some((cookie: any) => cookie.name === 'profile_acceptance'), 'Cookie escaped Profile');
  const { targetId } = await send('Target.createTarget', { url: 'data:text/html,<script>window.ticks=0;setInterval(()=>ticks++,20)</script>', newWindow: true });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await Bun.sleep(300);
  const before = (await send('Runtime.evaluate', { expression: 'ticks', returnByValue: true }, sessionId)).result.value;
  assert(typeof before === 'number', 'Page did not start');
  await client.profile('browser.profile.rename', { profileId: work.profileId, name: 'Office', expectedRevision: 0 });
  client.dispose(); await Bun.sleep(500);
  client = new BrowserServiceClient(state); clients.push(client);
  assert((await client.openProfile(work.profileId)).pid === a.pid, 'Rename or disconnect replaced browser');
  const after = (await send('Runtime.evaluate', { expression: 'ticks', returnByValue: true }, sessionId)).result.value;
  assert(after > before, 'Unattended page stopped advancing');
  await stop(first.owner);
  const second = await start(); client = second.client;
  const profiles = (await client.profile('browser.profile.list', {})).profiles;
  assert(profiles.some(profile => profile.profileId === work.profileId && profile.name === 'Office'), 'Profile catalog lost after restart');
  const reopened = await client.openProfile(work.profileId);
  assert(reopened.generation !== a.generation, 'Runtime generation reused after restart');
  const cookies = await client.sendProfile(work.profileId, reopened.generation, 'Storage.getCookies');
  assert(cookies.cookies.some((cookie: any) => cookie.name === 'profile_acceptance' && cookie.value === 'work-only'), 'Persistent Profile cookie lost');
  let staleRejected = false;
  try { await send('Runtime.evaluate', { expression: '1' }, sessionId); } catch { staleRejected = true; }
  assert(staleRejected, 'Old runtime handle accepted');
  await stop(second.owner);
  passed = true;
  console.log(JSON.stringify({ passed, platform: process.platform, browser: a.version, packagedService: !!process.env.BROWSER_SERVICE_BINARY,
    independentService: first.owner.pid !== process.pid, isolatedProfileProcesses: true, isolatedCookies: true, sharedRuntime: true,
    renamePreservesLivePage: true, unattendedTicks: { before, after }, persistedCatalogAndCookies: true, staleRejected }));
} finally {
  for (const client of clients) client.dispose();
  try { for (const owner of owners) await stop(owner); }
  catch (error) { passed = false; throw error; }
  finally {
    if (passed) await rm(state, { recursive: true, force: true });
    else console.error(`Acceptance failed; retained owned state for diagnosis at ${state}`);
  }
}
