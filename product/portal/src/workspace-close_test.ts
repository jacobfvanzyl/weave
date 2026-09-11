import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Portal } from './portal.ts';
import { startPortalServer } from './server.ts';
import { InMemoryTerminalExecution } from './terminals.ts';
import { generatePortalKey, RpcSocket, waitFor } from '../scripts/rpc-client.ts';
import { PORTAL_PAIR_REQUEST_TYPE } from '@weave/product-protocol';

async function fixture() {
  const root = await mkdtemp('/tmp/weave-close-');
  const backend = new InMemoryTerminalExecution();
  const config = { listen: { hostname: '127.0.0.1', port: 0 }, displayName: 'Close test', allowedOrigins: [], stateDirectory: join(root, 'state'), executionContexts: [{ executionContextId: 'context', name: 'Test', path: root }], agents: [{ agentId: 'fake', name: 'Fake', command: process.execPath, args: [join(import.meta.dir, 'test-fixtures/fake-agent.ts')], env: {} }] };
  const portal = await Portal.open(config, { terminalBackend: backend });
  const server = startPortalServer(portal);
  const sockets: RpcSocket[] = [];
  const connect = async (restricted = false, path = '/rpc') => {
    const key = await generatePortalKey();
    const grants = portal.security.defaultGrants();
    if (restricted) grants.actions = ['portal.inspect', 'context.inspect'];
    const token = await portal.security.createPairingToken(60000, grants);
    const paired = await portal.security.redeemPairing({ type: PORTAL_PAIR_REQUEST_TYPE, token, label: 'Test', publicKey: key.publicKey });
    const credential = { ...key, credentialId: paired.principal.credentialId };
    const rpc = await RpcSocket.open(`ws://127.0.0.1:${server.addr.port}${path}`, credential);
    sockets.push(rpc);
    return rpc;
  };
  const rpc = await connect();
  const hostId = portal.security.hostId;
  const composition = async () => (await rpc.request('workspace.composition.get', { hostId }) as any).composition;
  const create = async (id: string) => {
    const current = await composition();
    return (await rpc.request('workspace.composition.replace', { hostId, expectedRevision: current.revision, workspaces: [...current.workspaces, { workspaceId: id, name: id, layout: { kind: 'terminal', nodeId: `${id}-node`, paneId: `${id}-pane`, terminalId: null, executionContextId: 'context' } }] }) as any).composition;
  };
  return { root, backend, portal, rpc, hostId, composition, create, connect, cleanup: async () => { sockets.forEach((socket) => socket.close()); await server.shutdown(); await portal.close(); await rm(root, { recursive: true, force: true }); } };
}

test('close confirms exact consequences, stops terminals, archives agents and restores without orphan membership', async () => {
  const f = await fixture();
  try {
    await f.create('work');
    const { thread } = await f.rpc.request('thread.create', { workspaceId: 'work', executionContextId: 'context', agentId: 'fake', title: 'Keep transcript' }) as any;
    const params = { hostId: f.hostId, workspaceId: 'work' };
    const { plan } = await f.rpc.request('workspace.close.preview', params) as any;
    expect(plan.terminals).toHaveLength(1);
    expect(plan.terminals[0].dirty).toBe(true);
    expect(plan.threads[0].dirty).toBe(false);
    await expect(f.rpc.request('workspace.close', { ...params, token: plan.token, confirmed: false })).rejects.toThrow('Confirmation');
    expect(f.backend.closed).toHaveLength(0);
    const reader = await f.connect(true);
    await expect(reader.request('workspace.close', { ...params, token: plan.token, confirmed: true })).rejects.toThrow();
    expect(f.backend.closed).toHaveLength(0);
    const result = await f.rpc.request('workspace.close', { ...params, token: plan.token, confirmed: true }) as any;
    expect(result.composition.workspaces).toEqual([]);
    expect(f.backend.closed).toHaveLength(1);
    expect((await f.rpc.request('thread.list') as any).threads).toEqual([]);
    const archived = (await f.rpc.request('thread.list', { status: 'archived' }) as any).threads;
    expect(archived[0]).toMatchObject({ threadId: thread.threadId, acpSessionId: thread.acpSessionId, workspaceId: 'work' });
    expect(await f.rpc.request('workspace.close', { ...params, token: plan.token, confirmed: true })).toEqual(result);
    const restored = (await f.rpc.request('thread.restore', { threadId: thread.threadId }) as any).thread;
    expect((await f.composition()).workspaces.map((workspace: any) => workspace.workspaceId)).toContain(restored.workspaceId);
    expect(restored.acpSessionId).toBe(thread.acpSessionId);
    await f.rpc.request('thread.archive', { threadId: thread.threadId });
    expect((await f.composition()).workspaces).toEqual([]);
  } finally { await f.cleanup(); }
}, 20000);

test('close refuses stale plans and failed stops without removing the live workspace', async () => {
  const f = await fixture();
  try {
    const current = await f.create('work');
    const params = { hostId: f.hostId, workspaceId: 'work' };
    const { plan } = await f.rpc.request('workspace.close.preview', params) as any;
    await f.rpc.request('workspace.composition.replace', { hostId: f.hostId, expectedRevision: current.revision, workspaces: current.workspaces.map((workspace: any) => ({ ...workspace, name: 'Changed' })) });
    await expect(f.rpc.request('workspace.close', { ...params, token: plan.token, confirmed: true })).rejects.toThrow('changed');
    expect(f.backend.closed).toHaveLength(0);
    const updated = (await f.rpc.request('workspace.close.preview', params) as any).plan;
    const close = f.backend.close.bind(f.backend);
    f.backend.close = async () => { throw new Error('Stop failed'); };
    await expect(f.rpc.request('workspace.close', { ...params, token: updated.token, confirmed: true })).rejects.toThrow('Stop failed');
    expect((await f.composition()).workspaces).toHaveLength(1);
    f.backend.close = close;
    await f.rpc.request('workspace.close', { ...params, token: updated.token, confirmed: true });
    expect((await f.composition()).workspaces).toEqual([]);
  } finally { await f.cleanup(); }
}, 20000);

test('last terminal exit and last thread move clean up empty workspaces; layout writes cannot orphan terminals', async () => {
  const f = await fixture();
  try {
    const current = await f.create('first');
    const terminalId = current.workspaces[0].layout.terminalId;
    await expect(f.rpc.request('workspace.composition.replace', { hostId: f.hostId, expectedRevision: current.revision, workspaces: [] })).rejects.toThrow('Close');
    f.backend.emitExit(terminalId, 0);
    await waitFor(async () => (await f.composition()).workspaces.length === 0);
    const { thread } = await f.rpc.request('thread.create', { executionContextId: 'context', agentId: 'fake' }) as any;
    expect((await f.composition()).workspaces).toHaveLength(1);
    await f.create('destination');
    await f.rpc.request('thread.assign', { hostId: f.hostId, threadId: thread.threadId, workspaceId: 'destination', expectedRevision: thread.membershipRevision });
    expect((await f.composition()).workspaces.map((workspace: any) => workspace.workspaceId)).toEqual(['destination']);
    expect(JSON.parse(await readFile(join(f.root, 'state/threads.json'), 'utf8')).threads[0].workspaceId).toBe('destination');
  } finally { await f.cleanup(); }
}, 20000);


test.each(['thread.create', 'thread.draft.create'])('%s beginning work invalidates a clean preview and confirmed close cancels its pending turn', async (method) => {
  const f = await fixture();
  try {
    const { thread } = await f.rpc.request(method, { executionContextId: 'context', agentId: 'fake' }) as any;
    const params = { hostId: f.hostId, workspaceId: thread.workspaceId };
    const clean = (await f.rpc.request('workspace.close.preview', params) as any).plan;
    expect(clean.threads[0].dirty).toBe(false);
    const acp = await f.connect(false, `/acp?threadId=${thread.threadId}`);
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await acp.request('session/load', { sessionId: thread.acpSessionId, cwd: f.root, mcpServers: [] });
    const prompting = acp.request('session/prompt', { sessionId: thread.acpSessionId, prompt: [{ type: 'text', text: 'UI_PERMISSION' }] }).catch(() => undefined);
    await waitFor(() => acp.notifications.some((message) => message.method === 'session/request_permission'));
    await expect(f.rpc.request('workspace.close', { ...params, token: clean.token, confirmed: false })).rejects.toThrow('changed');
    const dirty = (await f.rpc.request('workspace.close.preview', params) as any).plan;
    expect(dirty.threads[0].dirty).toBe(true);
    await f.rpc.request('workspace.close', { ...params, token: dirty.token, confirmed: true });
    await prompting;
    expect((await f.composition()).workspaces).toEqual([]);
    expect((await f.rpc.request('thread.list', { status: 'archived' }) as any).threads[0].threadId).toBe(thread.threadId);
  } finally { await f.cleanup(); }
}, 20000);
