import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { Portal } from './portal.ts';
import { startPortalServer } from './server.ts';
import { InMemoryTerminalExecution } from './terminals.ts';
import { generatePortalKey, RpcSocket, waitFor } from '../scripts/rpc-client.ts';
import { PORTAL_PAIR_REQUEST_TYPE } from '@weave/product-protocol';
import type { BrowserBackend } from './browsers.ts';
import type { PortalGrants } from './security.ts';

test('authenticated Portal browser RPC enforces Workspace grants, connection ownership and credential revocation', async () => {
  const state = await mkdtemp('/tmp/weave-browser-rpc-');
  const calls: string[] = [], detached: string[] = [];
  const pending = new Map<string, (error: Error) => void>();
  const backend: BrowserBackend = {
    async browser(method: any, input: any): Promise<any> {
      calls.push(method);
      if (method === 'browser.tab.list') return { tabs: [] };
      if (method === 'browser.view.attach') return { grant: { workspaceId: input.workspaceId, tabId: input.tabId, viewId: crypto.randomUUID(), expiresAt: Date.now() + 30000 } };
      return {};
    },
    events(_workspace, view) { return new Promise((_resolve, reject) => pending.set(view, reject)); },
    async renew() { return { expiresAt: Date.now() + 30000 }; },
    async detach(_workspace, view) { detached.push(view); pending.get(view)?.(new Error('Detached')); pending.delete(view); },
    dispose() {},
  };
  const portal = await Portal.open({ stateDirectory: state, listen: { hostname: '127.0.0.1', port: 0 }, displayName: 'Browser RPC test', allowedOrigins: [], executionContexts: [{ executionContextId: 'ctx', name: 'Context', path: state }], agents: [] }, { terminalBackend: new InMemoryTerminalExecution(), browserBackend: backend });
  const server = startPortalServer(portal), sockets: RpcSocket[] = [];
  const connect = async (grants = portal.security.defaultGrants()) => {
    const key = await generatePortalKey();
    const paired = await portal.security.redeemPairing({ type: PORTAL_PAIR_REQUEST_TYPE, token: await portal.security.createPairingToken(60000, grants), label: 'Browser RPC test', publicKey: key.publicKey });
    const credential = { ...key, credentialId: paired.principal.credentialId };
    const socket = await RpcSocket.open(`ws://127.0.0.1:${server.addr.port}/rpc`, credential); sockets.push(socket);
    return { socket, credential };
  };
  try {
    const admin = await connect();
    const hostId = portal.security.hostId;
    const current = await admin.socket.request('workspace.composition.get', { hostId }) as any;
    await admin.socket.request('workspace.composition.replace', { hostId, expectedRevision: current.composition.revision, workspaces: [{ workspaceId: 'w', name: 'Workspace', layout: { kind: 'terminal', nodeId: 'node', paneId: 'pane', terminalId: null, executionContextId: 'ctx' } }] });
    const permitted = await connect({ ...portal.security.defaultGrants(), workspaceIds: ['w'] });
    expect(await permitted.socket.request('browser.tab.list', { workspaceId: 'w' })).toEqual({ tabs: [] });
    const wrong = await connect({ ...portal.security.defaultGrants(), workspaceIds: ['other'] });
    await expect(wrong.socket.request('browser.tab.list', { workspaceId: 'w' })).rejects.toThrow('unavailable');
    const legacy: PortalGrants = { actions: portal.security.defaultGrants().actions.filter(action => !action.startsWith('browser.')), executionContextIds: ['ctx'], agentIds: [] };
    const old = await connect(legacy);
    await expect(old.socket.request('browser.tab.list', { workspaceId: 'w' })).rejects.toThrow('unavailable');
    const { grant } = await permitted.socket.request('browser.view.attach', { workspaceId: 'w', tabId: 'tab', mode: 'control' }) as any;
    await expect(admin.socket.request('browser.view.focus', { workspaceId: 'w', viewId: grant.viewId, width: 800, height: 600 })).rejects.toThrow('unavailable');
    await portal.security.revokeCredential(permitted.credential.credentialId);
    await expect(permitted.socket.request('browser.tab.list', { workspaceId: 'w' })).rejects.toThrow();
    await waitFor(() => detached.includes(grant.viewId));
    expect(calls).toEqual(['browser.tab.list', 'browser.view.attach']);
  } finally {
    for (const socket of sockets) socket.close();
    await server.shutdown(); await portal.close(); await rm(state, { recursive: true, force: true });
  }
}, 20000);
