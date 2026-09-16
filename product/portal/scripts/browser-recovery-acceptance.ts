import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Portal } from '../src/portal.ts';
import { startPortalServer } from '../src/server.ts';
import { serveBrowserService } from '../src/browser-service/service.ts';
import { BrowserServiceClient } from '../src/browser-service/client.ts';
import { generatePortalKey, RpcSocket } from './rpc-client.ts';
import { PORTAL_PAIR_REQUEST_TYPE } from '@weave/product-protocol';

const binary = process.env.CEF_BINARY && resolve(process.env.CEF_BINARY);
if (!binary) throw new Error('CEF_BINARY required');
const root = await mkdtemp('/tmp/wve-recovery-');
const evidence: Record<string, unknown> = { platform: process.platform };
const assert = (value: unknown, reason: string) => { if (!value) throw new Error(reason); };
const wait = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 15000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Recovery acceptance timed out'); await Bun.sleep(25); }
};
const fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<title>Recovery fixture</title><script>window.ticks=0;setInterval(()=>ticks++,20)</script>', { headers: { 'content-type': 'text/html' } }) });
const url = `http://127.0.0.1:${fixture.port}/`;
const config = { stateDirectory: root, displayName: 'Isolated recovery acceptance', listen: { hostname: '127.0.0.1', port: 0 }, allowedOrigins: [], executionContexts: [], agents: [] };
let owner = await serveBrowserService({ stateDirectory: root, binary: '/unused', cefBinary: binary });
let backend = new BrowserServiceClient(root, '/unused', binary);
let portal = await Portal.open(config, { terminalBackend: false, browserBackend: backend });
let server = startPortalServer(portal);
const sockets: RpcSocket[] = [];
const list = async () => (await backend.managedPage('page.list')).pages as any[];
const evaluate = async (page: any, expression: string) => (await backend.managedPage('page.cdp', { pageId: page.pageId, generation: page.generation, arguments: { method: 'Runtime.evaluate', arguments: { expression, returnByValue: true, userGesture: true } } })).result.value;
const ready = (page: any) => wait(async () => await evaluate(page, 'document.title') === 'Recovery fixture');
let success = false;
try {
  const key = await generatePortalKey();
  const paired = await portal.security.redeemPairing({ type: PORTAL_PAIR_REQUEST_TYPE, token: await portal.security.createPairingToken(), label: 'Recovery fixture', publicKey: key.publicKey });
  const signer = { ...key, credentialId: paired.principal.credentialId };
  const connect = async () => { const rpc = await RpcSocket.open(`ws://127.0.0.1:${server.addr.port}/rpc`, signer); sockets.push(rpc); return rpc; };
  let rpc = await connect();
  const hostId = portal.security.hostId;
  const initial = (await rpc.request('workspace.composition.get', { hostId }) as any).composition;
  const { profile } = await backend.profile('browser.profile.create', { name: 'Persistent recovery' });
  const { page } = await rpc.request('browser.pane.create', { hostId, expectedRevision: initial.revision, workspaceId: crypto.randomUUID(), workspaceName: 'Recovery', paneId: crypto.randomUUID(), profileId: profile.profileId, url, axis: 'vertical' }) as any;
  const temp = await backend.managedPage('page.create', { pageId: crypto.randomUUID(), url });
  const other = await backend.managedPage('page.create', { pageId: crypto.randomUUID(), url });
  for (const item of [page, temp, other]) await ready(item);
  await evaluate(temp, 'document.cookie="identity=temporary;max-age=86400";localStorage.identity="temporary";true');
  assert(await evaluate(other, 'document.cookie') === '', 'Independent temporary Pane shared cookies');
  assert(await evaluate(other, 'localStorage.identity') === undefined, 'Independent temporary Pane shared local storage');
  await evaluate(temp, `window.open('${url}popup');true`);
  let popup: any;
  await wait(async () => Boolean(popup = (await list()).find(item => item.openerPageId === temp.pageId)));
  await ready(popup);
  assert(popup.profileId === temp.profileId && await evaluate(popup, 'document.cookie') === 'identity=temporary', 'Popup lost opener identity');
  await backend.managedPage('page.close', { pageId: temp.pageId, generation: temp.generation });
  assert(await evaluate(popup, 'localStorage.identity') === 'temporary', 'Closing opener destroyed popup storage');
  evidence.temporaryIsolationAndPopupLifetime = true;

  await evaluate(page, 'window.unpersisted="alive";document.cookie="identity=persistent;max-age=86400";localStorage.identity="persistent";true');
  const before = await evaluate(page, 'ticks');
  rpc.close(); await server.shutdown(); await portal.close();
  backend = new BrowserServiceClient(root, '/unused', binary);
  portal = await Portal.open(config, { terminalBackend: false, browserBackend: backend }); server = startPortalServer(portal);
  rpc = await connect();
  assert(portal.security.hostId === hostId, 'Host identity changed on reconnect');
  assert((await list()).find(item => item.pageId === page.pageId)?.generation === page.generation, 'Portal restart replaced live page');
  assert(await evaluate(page, 'window.unpersisted') === 'alive' && await evaluate(page, 'ticks') > before, 'Portal restart lost live JavaScript');
  assert(JSON.stringify((await rpc.request('workspace.composition.get', { hostId }) as any).composition).includes(page.pageId), 'Portal restart lost Pane composition');
  evidence.portalRestartRetainsLivePageAndPairing = true;

  // Select only the exact fixture runtime command. No installed Host process is eligible.
  const ps = Bun.spawn(['ps', '-axo', 'pid=,command='], { stdout: 'pipe' });
  const rows = (await new Response(ps.stdout).text()).split('\n'); await ps.exited;
  const prefix = `${binary} ${await realpath(join(root, 'browser-service', 'profile-data', profile.profileId))} `;
  const matches = rows.map(row => row.trim().match(/^(\d+)\s+(.*)$/)).filter(row => row?.[2]?.startsWith(prefix));
  assert(matches.length === 1, 'Could not identify exactly one isolated runtime');
  process.kill(Number(matches[0]![1]), 'SIGKILL');
  await wait(async () => !(await list()).find(item => item.pageId === page.pageId)?.available);
  const retry = await backend.managedPage('page.create', { pageId: page.pageId, profileId: page.profileId, url });
  assert(!retry.available, 'Retry silently recreated crashed page');
  const restored = await backend.managedPage('page.restore', { pageId: page.pageId }); await ready(restored);
  assert(restored.generation !== page.generation && restored.profileId === page.profileId, 'Restore did not rotate generation or retain Profile');
  assert(await evaluate(restored, 'window.unpersisted') === undefined, 'Crash unexpectedly retained live JavaScript');
  let stale = false; try { await evaluate(page, '1'); } catch { stale = true; }
  assert(stale, 'Old generation remained usable after crash');
  evidence.runtimeCrashRequiresExplicitRestore = true;
  evidence.recentStorageWriteSurvivedForcedCrash = await evaluate(restored, 'localStorage.identity') === 'persistent';
  await evaluate(restored, 'localStorage.identity="persistent";document.cookie="identity=persistent;max-age=86400";true');

  rpc.close(); await server.shutdown(); await portal.close(); await owner.close();
  owner = await serveBrowserService({ stateDirectory: root, binary: '/unused', cefBinary: binary });
  backend = new BrowserServiceClient(root, '/unused', binary);
  portal = await Portal.open(config, { terminalBackend: false, browserBackend: backend }); server = startPortalServer(portal);
  assert((await list()).every(item => !item.available), 'Service restart auto-restored live pages');
  const persistent = await backend.managedPage('page.restore', { pageId: page.pageId }); await ready(persistent);
  assert(await evaluate(persistent, 'localStorage.identity') === 'persistent', 'Persistent Profile storage lost across restart');
  assert(await evaluate(persistent, 'document.cookie') === 'identity=persistent', 'Persistent cookie lost across orderly restart');
  const related = await backend.managedPage('page.restore', { pageId: popup.pageId }); await ready(related);
  assert(await evaluate(related, 'localStorage.identity') === 'temporary', 'Temporary identity was destroyed before its last Pane closed');
  await backend.managedPage('page.close', { pageId: related.pageId, generation: related.generation });
  assert(!(await backend.profile('browser.profile.list', {})).profiles.some(item => item.profileId === temp.profileId), 'Last popup close left temporary identity');
  assert(!existsSync(join(root, 'browser-service', 'profile-data', temp.profileId)), 'Last popup close left temporary data');
  await backend.managedPage('page.close', { pageId: other.pageId });
  await backend.managedPage('page.close', { pageId: persistent.pageId, generation: persistent.generation });
  assert((await list()).length === 0 && (await backend.profile('browser.profile.list', {})).profiles.length === 1, 'Final close leaked pages or temporary Profiles');
  evidence.serviceRestartStorageAndLastCloseCleanup = true;
  success = true;
} finally {
  sockets.forEach(socket => socket.close());
  await server.shutdown(); await portal.close(); await owner.close(); await fixture.stop(true);
  await writeFile(process.env.BROWSER_RECOVERY_EVIDENCE ?? '/tmp/wve79-browser-recovery.json', JSON.stringify({ ...evidence, success }, null, 2));
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...evidence, success }));
