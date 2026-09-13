import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Portal } from './portal.ts';
import { startPortalServer } from './server.ts';
import { InMemoryTerminalExecution } from './terminals.ts';
import { generatePortalKey, RpcSocket } from '../scripts/rpc-client.ts';
import { paneTargets, PORTAL_PAIR_REQUEST_TYPE, type WorkspaceComposition } from '@weave/product-protocol';
import { browserPageBackend } from './test-fixtures/browser-page-backend.ts';
import type { ManagedPageSummary } from './browser-service/managed-pages.ts';

async function fixture() {
  const root = await mkdtemp('/tmp/weave-browser-pane-'), fake = browserPageBackend();
  const pages = new Map<string, ManagedPageSummary>();
  let before: ((method: string) => Promise<void>) | undefined;
  fake.backend.managedPage = async <T>(method: string, raw: unknown): Promise<T> => {
    const args = raw as { pageId: string; profileId: string; generation?: string; url?: string };
    fake.calls.push({ method, args }); await before?.(method);
    if (method === 'page.list') return { pages: [...pages.values()].filter(page => !args.profileId || page.profileId === args.profileId) } as T;
    if (method === 'page.create' && !pages.has(args.pageId)) pages.set(args.pageId, { ...fake.page, pageId: args.pageId, profileId: args.profileId, url: args.url!, generation: crypto.randomUUID() });
    if (method === 'page.close') {
      const page = pages.get(args.pageId);
      if (page?.available && page.generation !== args.generation) throw new Error('Stale browser page generation');
      pages.delete(args.pageId); return {} as T;
    }
    return { ...pages.get(args.pageId) } as T;
  };
  const portal = await Portal.open({ listen: { hostname: '127.0.0.1', port: 0 }, displayName: 'Pane test', allowedOrigins: [], stateDirectory: join(root, 'state'), executionContexts: [{ executionContextId: 'context', name: 'Test', path: root }], agents: [] }, { terminalBackend: new InMemoryTerminalExecution(), browserBackend: fake.backend });
  const server = startPortalServer(portal), sockets: RpcSocket[] = [];
  const connect = async (profile = true) => {
    const key = await generatePortalKey(), grants = portal.security.defaultGrants();
    grants.trustedHuman = false;
    grants.actions = [...grants.actions, 'browser.profile.control']; grants.browserProfileIds = profile ? [fake.page.profileId] : [];
    const paired = await portal.security.redeemPairing({ type: PORTAL_PAIR_REQUEST_TYPE, token: await portal.security.createPairingToken(60000, grants), label: 'Pane test', publicKey: key.publicKey });
    const rpc = await RpcSocket.open(`ws://127.0.0.1:${server.addr.port}/rpc`, { ...key, credentialId: paired.principal.credentialId }); sockets.push(rpc);
    return { rpc, credentialId: paired.principal.credentialId };
  };
  const client = await connect(), rpc = client.rpc, hostId = portal.security.hostId;
  const composition = async () => (await rpc.request('workspace.composition.get', { hostId }) as { composition: WorkspaceComposition }).composition;
  await rpc.request('workspace.composition.replace', { hostId, expectedRevision: 0, workspaces: ['one', 'two'].map(id => ({ workspaceId: id, name: id, layout: { kind: 'terminal', nodeId: `${id}-node`, paneId: `${id}-pane`, terminalId: null, executionContextId: 'context' } })) });
  const create = async (paneId = crypto.randomUUID()) => {
    const input = { hostId, workspaceId: 'one', expectedRevision: (await composition()).revision, paneId, profileId: fake.page.profileId, url: 'https://example.com/', sourcePaneId: 'one-pane', axis: 'horizontal' };
    return { input, result: await rpc.request('browser.pane.create', input) as { composition: WorkspaceComposition; page: ManagedPageSummary } };
  };
  return { ...client, root, fake, pages, portal, hostId, composition, create, connect, intercept: (callback: typeof before) => { before = callback; }, cleanup: async () => { sockets.forEach(socket => socket.close()); await server.shutdown(); await portal.close(); await rm(root, { recursive: true, force: true }); } };
}

test('Browser Pane creation is idempotent, move preserves its page, and shared close checks generation and confirmation', async () => {
  const f = await fixture();
  try {
    const { input, result } = await f.create();
    expect(paneTargets(result.composition.workspaces).find(pane => pane.paneId === input.paneId)?.kind).toBe('browser');
    expect(result.page).not.toHaveProperty('rfbSocket');
    const again = await f.rpc.request('browser.pane.create', input) as typeof result;
    expect(again.composition.revision).toBe(result.composition.revision);
    expect(f.fake.calls.filter(call => call.method === 'page.create')).toHaveLength(1);
    const move = { hostId: f.hostId, expectedRevision: result.composition.revision, paneId: input.paneId, profileId: input.profileId, workspaceId: 'two', sourcePaneId: 'two-pane', axis: 'vertical' };
    const moved = await f.rpc.request('browser.pane.move', move) as { composition: WorkspaceComposition };
    expect(paneTargets(moved.composition.workspaces.filter(workspace => workspace.workspaceId === 'two')).map(pane => pane.paneId)).toContain(input.paneId);
    expect(f.pages.get(input.paneId)?.generation).toBe(result.page.generation);
    const close = { hostId: f.hostId, expectedRevision: moved.composition.revision, paneId: input.paneId, profileId: input.profileId, generation: result.page.generation, confirmed: false };
    await expect(f.rpc.request('browser.pane.close', close)).rejects.toThrow('Confirm');
    await expect(f.rpc.request('browser.pane.close', { ...close, confirmed: true, generation: crypto.randomUUID() })).rejects.toThrow('Stale');
    expect(f.pages.has(input.paneId)).toBe(true);
    const closed = await f.rpc.request('browser.pane.close', { ...close, confirmed: true }) as { composition: WorkspaceComposition };
    expect(f.pages.has(input.paneId)).toBe(false);
    expect(paneTargets(closed.composition.workspaces).some(pane => pane.paneId === input.paneId)).toBe(false);
    expect(await f.rpc.request('browser.pane.close', { ...close, confirmed: true })).toEqual(closed);
  } finally { await f.cleanup(); }
});

test('Profile scope hides browser Workspaces and layout overwrites cannot bypass page lifetime or membership', async () => {
  const f = await fixture();
  try {
    const { input, result } = await f.create(), other = await f.connect(false);
    const visible = await other.rpc.request('workspace.composition.get', { hostId: f.hostId }) as { composition: WorkspaceComposition };
    expect(visible.composition.workspaces.map(workspace => workspace.workspaceId)).toEqual(['two']);
    await expect(other.rpc.request('browser.pane.create', input)).rejects.toThrow();
    const leaf = paneTargets(result.composition.workspaces).find(pane => pane.paneId === input.paneId)!;
    const moved = result.composition.workspaces.map(workspace => ({ ...workspace, layout: workspace.workspaceId === 'two' ? leaf : null }));
    await expect(f.rpc.request('workspace.composition.replace', { hostId: f.hostId, expectedRevision: result.composition.revision, workspaces: moved })).rejects.toThrow('Move Browser');
    expect(f.pages.size).toBe(1);
  } finally { await f.cleanup(); }
});

test('Workspace close includes browser consequences and invalidates confirmation after runtime replacement', async () => {
  const f = await fixture();
  try {
    const { input } = await f.create(), target = { hostId: f.hostId, workspaceId: 'one' };
    const { plan } = await f.rpc.request('workspace.close.preview', target) as any;
    expect(plan.browsers).toHaveLength(1); expect(plan.browsers[0].dirty).toBe(true);
    await expect(f.rpc.request('workspace.close', { ...target, token: plan.token, confirmed: false })).rejects.toThrow('Confirmation');
    f.pages.get(input.paneId)!.generation = crypto.randomUUID();
    await expect(f.rpc.request('workspace.close', { ...target, token: plan.token, confirmed: true })).rejects.toThrow('changed');
    const current = await f.rpc.request('workspace.close.preview', target) as any;
    await f.rpc.request('workspace.close', { ...target, token: current.plan.token, confirmed: true });
    expect(f.pages.size).toBe(0);
    expect((await f.composition()).workspaces.map(workspace => workspace.workspaceId)).toEqual(['two']);
  } finally { await f.cleanup(); }
});

test('revocation during page creation cannot publish a Pane and retry recovers the same page', async () => {
  const f = await fixture();
  try {
    let revoked = false;
    f.intercept(async method => { if (method === 'page.create' && !revoked) { revoked = true; await f.portal.security.revokeCredential(f.credentialId); } });
    const id = crypto.randomUUID();
    await expect(f.create(id)).rejects.toThrow();
    expect(f.pages.has(id)).toBe(true);
    const next = await f.connect();
    const { composition } = await next.rpc.request('workspace.composition.get', { hostId: f.hostId }) as { composition: WorkspaceComposition };
    expect(paneTargets(composition.workspaces).some(pane => pane.paneId === id)).toBe(false);
    const created = await next.rpc.request('browser.pane.create', { hostId: f.hostId, workspaceId: 'one', expectedRevision: composition.revision, paneId: id, profileId: f.fake.page.profileId, url: 'https://example.com/', sourcePaneId: 'one-pane', axis: 'vertical' }) as any;
    expect(created.page.pageId).toBe(id); expect(f.pages.size).toBe(1);
  } finally { await f.cleanup(); }
});

test('unattended popups inherit their Profile and appear to the right; native closure removes only that Pane', async () => {
  const f = await fixture();
  try {
    const { input, result } = await f.create(), popupId = crypto.randomUUID();
    f.pages.set(popupId, { ...result.page, pageId: popupId, openerPageId: input.paneId, url: 'https://example.com/popup' });
    f.pages.get(input.paneId)!.url = 'https://example.com/navigated';
    const deadline = Date.now() + 5000;
    let composition = await f.composition();
    while (!paneTargets(composition.workspaces).some(pane => pane.paneId === popupId)) {
      if (Date.now() > deadline) throw new Error('Popup placement timed out');
      await Bun.sleep(50); composition = await f.composition();
    }
    const layout = composition.workspaces.find(workspace => workspace.workspaceId === 'one')!.layout!;
    expect(layout.kind).toBe('split');
    if (layout.kind !== 'split') throw new Error('Missing split');
    const right = layout.children[1]; expect(right.kind).toBe('split');
    if (right.kind !== 'split') throw new Error('Missing popup split');
    expect(right.axis).toBe('horizontal');
    expect(right.children[0]).toMatchObject({ paneId: input.paneId, lastCommittedUrl: 'https://example.com/navigated' });
    expect(right.children[1]).toMatchObject({ kind: 'browser', paneId: popupId, profileId: input.profileId });
    f.pages.delete(popupId);
    while (paneTargets((await f.composition()).workspaces).some(pane => pane.paneId === popupId)) {
      if (Date.now() > deadline) throw new Error('Closed popup removal timed out'); await Bun.sleep(50);
    }
    expect(f.pages.has(input.paneId)).toBe(true);
  } finally { await f.cleanup(); }
}, 10000);

test('closing an opener before popup placement closes the unplaced page too', async () => {
  const f = await fixture();
  try {
    const { input, result } = await f.create(), popupId = crypto.randomUUID();
    f.intercept(async method => { if (method === 'page.close' && !f.pages.has(popupId)) f.pages.set(popupId, { ...result.page, pageId: popupId, openerPageId: input.paneId }); });
    await f.rpc.request('browser.pane.close', { hostId: f.hostId, expectedRevision: result.composition.revision, paneId: input.paneId, profileId: input.profileId, generation: result.page.generation, confirmed: true });
    expect(f.pages.size).toBe(0);
  } finally { await f.cleanup(); }
});

test('a Browser Pane can create a Workspace without a Terminal or execution directory', async () => {
  const f = await fixture();
  try {
    const before = await f.composition();
    const { composition } = await f.rpc.request('browser.pane.create', { hostId: f.hostId, workspaceId: 'browser-only', workspaceName: 'Research', expectedRevision: before.revision, paneId: crypto.randomUUID(), profileId: f.fake.page.profileId, url: 'about:blank', axis: 'vertical' }) as { composition: WorkspaceComposition };
    expect(composition.workspaces.find(workspace => workspace.workspaceId === 'browser-only')).toMatchObject({ name: 'Research', layout: { kind: 'browser' } });
    expect((await f.composition()).workspaces.some(workspace => workspace.workspaceId === 'browser-only')).toBe(true);
  } finally { await f.cleanup(); }
});
