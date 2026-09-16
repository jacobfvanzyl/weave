import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Portal } from './portal.ts';
import { startPortalServer } from './server.ts';
import { InMemoryTerminalExecution } from './terminals.ts';
import { generatePortalKey, RpcSocket } from '../scripts/rpc-client.ts';
import { paneTargets, PORTAL_PAIR_REQUEST_TYPE, type WorkspaceComposition, type WorkspaceClosePlan } from '@weave/product-protocol';
async function fixture() {
  const root = await mkdtemp('/tmp/weave-client-browser-pane-');
  const portal = await Portal.open({ listen: { hostname: '127.0.0.1', port: 0 }, displayName: 'Client Browser test', allowedOrigins: [], stateDirectory: join(root, 'state'), executionContexts: [{ executionContextId: 'context', name: 'Test', path: root }], agents: [] }, { terminalBackend: new InMemoryTerminalExecution(), browserBackend: false });
  const server = startPortalServer(portal), sockets: RpcSocket[] = [];
  const connect = async (manage = true, trustedHuman = true) => {
    const key = await generatePortalKey(), grants = portal.security.defaultGrants();
    grants.trustedHuman = trustedHuman;
    if (!manage) grants.actions = grants.actions.filter(action => action !== 'context.manage');
    const paired = await portal.security.redeemPairing({ type: PORTAL_PAIR_REQUEST_TYPE, token: await portal.security.createPairingToken(60000, grants), label: 'Client Browser test', publicKey: key.publicKey });
    const rpc = await RpcSocket.open(`ws://127.0.0.1:${server.addr.port}/rpc`, { ...key, credentialId: paired.principal.credentialId }); sockets.push(rpc); return rpc;
  };
  const rpc = await connect(), hostId = portal.security.hostId;
  await rpc.request('workspace.composition.replace', { hostId, expectedRevision: 0, workspaces: ['one', 'two'].map(id => ({ workspaceId: id, name: id, layout: { kind: 'terminal', nodeId: `${id}-node`, paneId: `${id}-pane`, terminalId: null, executionContextId: 'context' } })) });
  const composition = async () => (await rpc.request('workspace.composition.get', { hostId }) as { composition: WorkspaceComposition }).composition;
  const input = { hostId, workspaceId: 'one', expectedRevision: (await composition()).revision, paneId: crypto.randomUUID(), initialUrl: 'https://linear.app/', sourcePaneId: 'one-pane', axis: 'horizontal' };
  return { rpc, connect, hostId, input, composition, cleanup: async () => { sockets.forEach(socket => socket.close()); await server.shutdown(); await portal.close(); await rm(root, { recursive: true, force: true }); } };
}
test('Client Browser lifecycle needs an existing Workspace, no Host browser backend, and confirmed shared close', async () => {
  const f = await fixture();
  try {
    await expect(f.rpc.request('client-browser.pane.create', { ...f.input, workspaceId: 'missing' })).rejects.toThrow();
    const before = await f.composition();
    const result = await f.rpc.request('client-browser.pane.create', f.input) as { composition: WorkspaceComposition };
    const pane = paneTargets(result.composition.workspaces).find(pane => pane.paneId === f.input.paneId)!;
    expect(pane).toMatchObject({ kind: 'client-browser', initialUrl: 'https://linear.app/' });
    expect(paneTargets(result.composition.workspaces).filter(p => p.kind === 'terminal')).toEqual(paneTargets(before.workspaces).filter(p => p.kind === 'terminal'));
    expect(await f.rpc.request('client-browser.pane.create', f.input)).toEqual(result);
    await expect(f.rpc.request('client-browser.pane.create', { ...f.input, initialUrl: 'https://github.com/' })).rejects.toThrow('already exists');
    const move = { hostId: f.hostId, paneId: f.input.paneId, workspaceId: 'two', sourcePaneId: 'two-pane', axis: 'vertical', expectedRevision: result.composition.revision };
    await expect(f.rpc.request('client-browser.pane.move', { ...move, expectedRevision: 0 })).rejects.toThrow('changed');
    const moved = await f.rpc.request('client-browser.pane.move', move) as typeof result;
    expect(paneTargets(moved.composition.workspaces.filter(w => w.workspaceId === 'two'))).toContainEqual(pane);
    const close = { hostId: f.hostId, paneId: f.input.paneId, expectedRevision: moved.composition.revision, confirmed: false };
    await expect(f.rpc.request('client-browser.pane.close', close)).rejects.toThrow('Confirm');
    const closed = await f.rpc.request('client-browser.pane.close', { ...close, confirmed: true });
    expect(await f.rpc.request('client-browser.pane.close', { ...close, confirmed: true })).toEqual(closed);
    const other = await f.connect();
    expect(await other.request('workspace.composition.get', { hostId: f.hostId })).toEqual(closed);
  } finally { await f.cleanup(); }
});
test('layout replacement cannot bypass Client Browser ownership or close confirmation', async () => {
  const f = await fixture();
  try {
    const { composition } = await f.rpc.request('client-browser.pane.create', f.input) as { composition: WorkspaceComposition };
    for (const workspaces of [[], [{ workspaceId: 'injected', name: 'Injected', layout: { kind: 'client-browser', paneId: 'new', nodeId: 'new-node', initialUrl: 'about:blank' } }, ...composition.workspaces]]) await expect(f.rpc.request('workspace.composition.replace', { hostId: f.hostId, expectedRevision: composition.revision, workspaces })).rejects.toThrow();
    const converted = structuredClone(composition.workspaces);
    const terminal = paneTargets(converted).find(pane => pane.kind === 'terminal')!;
    Object.assign(terminal, { kind: 'client-browser', initialUrl: 'https://example.com/' });
    delete (terminal as any).terminalId; delete (terminal as any).executionContextId;
    await expect(f.rpc.request('workspace.composition.replace', { hostId: f.hostId, expectedRevision: composition.revision, workspaces: converted })).rejects.toThrow('Create Client Browser');
    const external = await f.connect(true, false);
    const visible = await external.request('workspace.composition.get', { hostId: f.hostId }) as { composition: WorkspaceComposition };
    expect(visible.composition.workspaces.map(workspace => workspace.workspaceId)).toEqual(['two']);
    await expect(external.request('client-browser.pane.reconcile', { hostId: f.hostId, paneIds: [f.input.paneId] })).rejects.toThrow('unavailable');
    const restricted = await f.connect(false);
    await expect(restricted.request('client-browser.pane.close', { hostId: f.hostId, paneId: f.input.paneId, expectedRevision: composition.revision, confirmed: true })).rejects.toThrow();
    const target = { hostId: f.hostId, workspaceId: 'one' };
    const { plan } = await f.rpc.request('workspace.close.preview', target) as { plan: WorkspaceClosePlan };
    expect(plan.clientBrowsers).toEqual([{ paneId: f.input.paneId, dirty: true }]);
    await expect(f.rpc.request('workspace.close', { ...target, token: plan.token, confirmed: false })).rejects.toThrow('Confirmation');
    await f.rpc.request('workspace.close', { ...target, token: plan.token, confirmed: true });
    expect((await f.composition()).workspaces.map(w => w.workspaceId)).toEqual(['two']);
  } finally { await f.cleanup(); }
});
