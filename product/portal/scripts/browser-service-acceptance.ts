import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BrowserServiceClient } from '../src/browser-service/client.ts';

// Isolated real-browser acceptance; never uses configured Host state or personal profiles.
const binary = process.env.CHROME_BINARY;
if (!binary) throw new Error('Set CHROME_BINARY to the explicitly selected Chromium executable');
const state = await mkdtemp('/tmp/weave-browser-acceptance-');
const owner = Bun.spawn([process.execPath, resolve(import.meta.dir, '../src/browser-service/main.ts'), state, binary], { stdout: 'pipe', stderr: 'pipe' });
let client = new BrowserServiceClient(state);
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (owner.exitCode !== null) throw new Error('Browser Service exited before readiness');
    try { await client.open(); ready = true; break; } catch { await Bun.sleep(50); }
  }
  assert(ready, 'Browser Service did not become ready');
  const a = await client.openWorkspace('acceptance-a');
  const b = await client.openWorkspace('acceptance-b');
  assert(a.pid !== b.pid, 'Workspace browsers shared a process');
  const send = (method: string, params: object = {}, sessionId?: string) => client.send(a.workspaceId, a.generation, method, params, sessionId);
  await send('Storage.setCookies', { cookies: [{ name: 'weave_acceptance', value: 'profile-a', domain: 'weave-acceptance.test', path: '/', expires: Math.floor(Date.now() / 1000) + 3600 }] });
  const other = await client.send(b.workspaceId, b.generation, 'Storage.getCookies');
  assert(!other.cookies.some((cookie: any) => cookie.name === 'weave_acceptance'), 'Cookie escaped Workspace profile');
  const { targetId } = await send('Target.createTarget', { url: 'data:text/html,<script>window.ticks=0;setInterval(()=>ticks++,20)</script>', newWindow: true });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await Bun.sleep(300);
  const first = (await send('Runtime.evaluate', { expression: 'ticks', returnByValue: true }, sessionId)).result.value;
  assert(typeof first === 'number', 'Page timer did not start');
  client.dispose();
  await Bun.sleep(500);
  client = new BrowserServiceClient(state);
  const retained = await client.openWorkspace(a.workspaceId);
  assert(retained.pid === a.pid && retained.generation === a.generation, 'Caller disconnect replaced browser');
  const later = (await send('Runtime.evaluate', { expression: 'ticks', returnByValue: true }, sessionId)).result.value;
  assert(later > first, 'Unattended page stopped advancing');
  await client.closeWorkspace(a.workspaceId, a.generation);
  const reopened = await client.openWorkspace(a.workspaceId);
  const restoredCookies = await client.send(reopened.workspaceId, reopened.generation, 'Storage.getCookies');
  assert(restoredCookies.cookies.some((cookie: any) => cookie.name === 'weave_acceptance' && cookie.value === 'profile-a'), 'Persistent cookie was lost');
  let staleRejected = false;
  try { await send('Runtime.evaluate', { expression: '1' }, sessionId); } catch { staleRejected = true; }
  assert(staleRejected, 'Old generation was accepted after browser restart');
  console.log(JSON.stringify({ passed: true, platform: process.platform, browser: a.version, independentServiceProcess: owner.pid !== process.pid,
    isolatedProfiles: true, unattendedTicks: { before: first, after: later }, sameBrowserAfterReconnect: true, cookieAfterReopen: true, staleRejected }));
} finally {
  client.dispose(); owner.kill('SIGTERM');
  await Promise.race([owner.exited, Bun.sleep(15000)]);
  if (owner.exitCode === null) {
    owner.kill('SIGKILL'); await owner.exited;
    // Preserve profiles and ownership evidence if normal shutdown failed.
    throw new Error(`Browser Service shutdown failed; retained acceptance state at ${state}`);
  }
  if (owner.exitCode !== 0) throw new Error(`Browser Service failed: ${await new Response(owner.stderr).text()}; retained state at ${state}`);
  await rm(state, { recursive: true, force: true });
}
