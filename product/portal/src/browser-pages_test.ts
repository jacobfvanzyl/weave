import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { ManagedBrowserAccess } from './browser-pages.ts';
import { PortalSecurity, type PortalGrants } from './security.ts';
import { generatePortalKey } from '../scripts/rpc-client.ts';
import { PORTAL_PAIR_REQUEST_TYPE, portalAuthChallengePayload } from '@weave/product-protocol';
import { browserPageBackend } from './test-fixtures/browser-page-backend.ts';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp('/tmp/weave-page-access-'); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const security = await PortalSecurity.open({ stateDirectory: root, displayName: 'Browser test', listen: { hostname: '127.0.0.1', port: 0 }, allowedOrigins: [], agents: [], executionContexts: [] });
  const fake = browserPageBackend();
  let offset = 0;
  let favicon: unknown;
  const access = new ManagedBrowserAccess({ async managedPage<T>(method: string, args: any) {
    const result = await fake.backend.managedPage!<T>(method, args);
    return method === 'page.cdp' && args.arguments?.method === 'Runtime.evaluate' ? { result: { value: favicon } } as T : result;
  } }, security, () => Date.now() + offset); cleanup.push(() => access.close());
  const pair = async (actions: PortalGrants['actions'] = ['browser.profile.control'], ids = [fake.page.profileId]) => {
    const key = await generatePortalKey();
    const paired = await security.redeemPairing({ type: PORTAL_PAIR_REQUEST_TYPE, token: await security.createPairingToken(60000, { actions, browserProfileIds: ids, executionContextIds: [], agentIds: [], workspaceIds: ['*'] }), label: 'Browser fixture', publicKey: key.publicKey });
    const challenge = security.challenge('/rpc');
    const principal = await security.authenticate(challenge, { type: 'weave.portal.auth.response', credentialId: paired.principal.credentialId, signature: await key.sign(portalAuthChallengePayload(challenge)) });
    return { principal, session: access.connect(principal) };
  };
  const attach = async (session: ReturnType<typeof access.connect>, mode: 'observe' | 'control' = 'control') => session.request('browser.page.view.attach', { profileId: fake.page.profileId, pageId: fake.page.pageId, generation: fake.page.generation!, mode });
  return { ...fake, access, security, pair, attach, advance: (ms: number) => { offset += ms; }, favicon: (value: unknown) => { favicon = value; } };
}

test('inspect metadata reads declared favicons without attaching, recreating or controlling the page', async () => {
  const f = await fixture(), actor = await f.pair(['browser.profile.inspect']);
  f.favicon({ url: f.page.url, icon: 'https://example.com/site.svg' });
  const get = () => actor.session.request('browser.page.get', { profileId: f.page.profileId, pageId: f.page.pageId });
  const [a, b] = await Promise.all([get(), get()]);
  expect(a.page.faviconUrl).toBe('https://example.com/site.svg'); expect(b.page).toEqual(a.page);
  expect(f.calls.filter(call => call.method === 'page.cdp')).toHaveLength(1);
  expect(f.calls.filter(call => call.method !== 'page.list' && call.method !== 'page.cdp')).toHaveLength(0);
  f.advance(2001); f.favicon({ url: f.page.url, icon: 'https://example.com/changed.svg' });
  expect((await get()).page.faviconUrl).toBe('https://example.com/changed.svg');
  f.page.url = 'https://other.test/path'; f.favicon({ url: 'https://example.com/', icon: 'https://example.com/stale.svg' });
  expect((await get()).page.faviconUrl).toBe('https://other.test/favicon.ico');
  f.page.url = 'about:blank';
  expect((await get()).page).not.toHaveProperty('faviconUrl');
});

test('favicon failures retain page metadata and revocation during the read still rejects access', async () => {
  const f = await fixture(), actor = await f.pair(['browser.profile.inspect']);
  const get = () => actor.session.request('browser.page.get', { profileId: f.page.profileId, pageId: f.page.pageId });
  f.intercept(async method => { if (method === 'page.cdp') throw new Error('Unavailable document'); });
  expect((await get()).page).toMatchObject({ title: 'Fixture', faviconUrl: 'https://example.com/favicon.ico' });
  f.advance(2001);
  f.intercept(async method => { if (method === 'page.cdp') await f.security.revokeCredential(actor.principal.credentialId); });
  await expect(get()).rejects.toThrow();
});

test('Profile access is explicit; metadata management and Workspace wildcards do not grant browser identity', async () => {
  const f = await fixture();
  for (const actor of [await f.pair(['browser.profile.manage']), await f.pair(['browser.control']), await f.pair(['browser.profile.control'], ['*'])]) {
    await expect(actor.session.request('browser.page.list', { profileId: f.page.profileId })).rejects.toThrow('unavailable');
  }
  expect(f.calls).toHaveLength(0);
  const allowed = await f.pair(['browser.profile.inspect']);
  const result = await allowed.session.request('browser.page.list', { profileId: f.page.profileId });
  expect(result.pages).toHaveLength(1);
  expect(result.pages[0]).not.toHaveProperty('rfbSocket');
  await expect(allowed.session.request('browser.page.get', { profileId: crypto.randomUUID(), pageId: f.page.pageId })).rejects.toThrow('unavailable');
});

test('latest focus owns resize and input; stale clients and passive viewers cannot take control', async () => {
  const f = await fixture(), a = await f.pair(), b = await f.pair(), passive = await f.pair(['browser.profile.inspect']);
  const av = await f.attach(a.session), bv = await f.attach(b.session), pv = await f.attach(passive.session, 'observe');
  const first = await a.session.request('browser.page.view.focus', { viewId: av.viewId, width: 800, height: 600 });
  const second = await b.session.request('browser.page.view.focus', { viewId: bv.viewId, width: 1000, height: 800 });
  expect(second.focusEpoch).toBeGreaterThan(first.focusEpoch);
  await expect(a.session.request('browser.page.view.input', { viewId: av.viewId, focusEpoch: first.focusEpoch, method: 'Input.insertText', arguments: { text: 'stale' } })).rejects.toThrow('no longer owns');
  await expect(a.session.request('browser.page.view.resize', { viewId: av.viewId, focusEpoch: first.focusEpoch, width: 500, height: 500 })).rejects.toThrow('no longer owns');
  await expect(passive.session.request('browser.page.view.focus', { viewId: pv.viewId, width: 500, height: 500 })).rejects.toThrow();
  await b.session.request('browser.page.view.input', { viewId: bv.viewId, focusEpoch: second.focusEpoch, method: 'Input.insertText', arguments: { text: 'current' } });
  expect(f.calls.filter(call => call.method === 'page.cdp')).toHaveLength(1);
  expect(f.page.width).toBe(1000);
  await expect(a.session.request('browser.page.view.focus', { viewId: bv.viewId, width: 500, height: 500 })).rejects.toThrow('unavailable');
});

test('attachment tickets are credential-bound, single-use, and close with their RPC owner', async () => {
  const f = await fixture(), owner = await f.pair(), other = await f.pair();
  const view = await f.attach(owner.session);
  await expect(f.access.bind(other.principal, view.ticket, () => {})).rejects.toThrow('unavailable');
  let closed = 0;
  const stream = await f.access.bind(owner.principal, view.ticket, () => closed++);
  expect(stream.path).toBe(f.page.rfbSocket!);
  await expect(f.access.bind(owner.principal, view.ticket, () => {})).rejects.toThrow('unavailable');
  owner.session.close();
  expect(closed).toBe(1); expect(stream.active()).toBe(false);
  expect(f.calls.some(call => call.method === 'page.close')).toBe(false);
});

test('revocation and runtime loss retire streams without closing the browser', async () => {
  const f = await fixture(), actor = await f.pair();
  const view = await f.attach(actor.session);
  let closed = false; await f.access.bind(actor.principal, view.ticket, () => { closed = true; });
  await f.security.revokeCredential(actor.principal.credentialId); await f.access.renew();
  expect(closed).toBe(true);
  const next = await f.pair(), nextView = await f.attach(next.session);
  let lost = false; await f.access.bind(next.principal, nextView.ticket, () => { lost = true; });
  f.page.generation = crypto.randomUUID(); await f.access.renew(); expect(lost).toBe(true);
});

test('focus transitions remain ordered and disconnect during resize cannot publish ownership', async () => {
  const f = await fixture(), a = await f.pair(), b = await f.pair();
  const av = await f.attach(a.session), bv = await f.attach(b.session);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.intercept(async (method, args) => { if (method === 'page.resize' && args.arguments.width === 900) { entered(); await waiting; } });
  const first = a.session.request('browser.page.view.focus', { viewId: av.viewId, width: 900, height: 700 }).catch(error => error);
  await started;
  const second = b.session.request('browser.page.view.focus', { viewId: bv.viewId, width: 1100, height: 800 });
  a.session.close(); release();
  expect(await first).toBeInstanceOf(Error);
  expect((await second).width).toBe(1100); expect(f.page.width).toBe(1100);
});

test('revocation while resolving a page prevents stream binding', async () => {
  const f = await fixture(), actor = await f.pair(), view = await f.attach(actor.session);
  f.intercept(async method => { if (method === 'page.list') { f.intercept(); await f.security.revokeCredential(actor.principal.credentialId); } });
  let closed = false;
  await expect(f.access.bind(actor.principal, view.ticket, () => { closed = true; })).rejects.toThrow();
  expect(closed).toBe(true);
});

test('input validates once per authorization boundary and still rejects revocation during page lookup', async () => {
  const f = await fixture(), actor = await f.pair(), view = await f.attach(actor.session);
  const focus = await actor.session.request('browser.page.view.focus', { viewId:view.viewId, width:800, height:600 });
  const original = f.security.assertActive.bind(f.security);
  let reads = 0;
  f.security.assertActive = async principal => { reads++; return original(principal); };
  const input = { viewId:view.viewId, focusEpoch:focus.focusEpoch, method:'Input.dispatchMouseEvent' as const, arguments:{ type:'mouseWheel', x:100, y:100, deltaX:0, deltaY:8 } };
  await actor.session.request('browser.page.view.input', input);
  expect(reads).toBe(2);
  expect(f.calls.findLast(call => call.method === 'page.cdp')?.args.arguments).toMatchObject({ nativeInput:true, inputEpoch:`${view.viewId}:${focus.focusEpoch}` });
  f.calls.length = 0;
  f.intercept(async method => { if (method === 'page.list') { f.intercept(); await f.security.revokeCredential(actor.principal.credentialId); } });
  await expect(actor.session.request('browser.page.view.input', input)).rejects.toThrow();
  expect(f.calls.some(call => call.method === 'page.cdp')).toBe(false);
});


test('unredeemed tickets expire and cannot leave stale viewport ownership behind', async () => {
  const f = await fixture(), actor = await f.pair(), view = await f.attach(actor.session);
  await actor.session.request('browser.page.view.focus', { viewId: view.viewId, width: 800, height: 600 });
  f.advance(30001);
  await expect(f.access.bind(actor.principal, view.ticket, () => {})).rejects.toThrow('unavailable');
  await expect(actor.session.request('browser.page.view.focus', { viewId: view.viewId, width: 800, height: 600 })).rejects.toThrow('expired');
  await f.access.renew();
  await expect(actor.session.request('browser.page.view.focus', { viewId: view.viewId, width: 800, height: 600 })).rejects.toThrow('unavailable');
  expect(f.page.available).toBe(true);
});


test('a stalled service fails viewing closed instead of postponing revocation checks', async () => {
  const f = await fixture(), actor = await f.pair(), view = await f.attach(actor.session);
  let closed = false;
  await f.access.bind(actor.principal, view.ticket, () => { closed = true; });
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  f.intercept(async method => { if (method === 'page.list') await stalled; });
  try { await f.access.renew(); expect(closed).toBe(true); }
  finally { release(); }
});
