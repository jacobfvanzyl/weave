import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Portal } from './portal.ts';
import { startPortalServer } from './server.ts';
import { serveBrowserService } from './browser-service/service.ts';
import { BrowserServiceClient } from './browser-service/client.ts';
import { generatePortalKey, RpcSocket } from '../scripts/rpc-client.ts';
import { PORTAL_PAIR_REQUEST_TYPE } from '@weave/product-protocol';
import type { PortalGrants } from './security.ts';

test('authenticated Profile RPC uses Host scope and filters profiles without Workspace or filesystem grants', async () => {
  const state = await mkdtemp('/tmp/weave-profile-rpc-');
  const owner = await serveBrowserService({ stateDirectory: state, binary: resolve(import.meta.dir, 'test-fixtures/fake-chromium.ts') });
  const backend = new BrowserServiceClient(state);
  const portal = await Portal.open({ stateDirectory: state, listen: { hostname: '127.0.0.1', port: 0 }, displayName: 'Profile test', allowedOrigins: [], executionContexts: [], agents: [] }, { terminalBackend: false, browserBackend: backend });
  const server = startPortalServer(portal), sockets: RpcSocket[] = [];
  const connect = async (grants: PortalGrants) => {
    const key = await generatePortalKey();
    const paired = await portal.security.redeemPairing({ type: PORTAL_PAIR_REQUEST_TYPE, token: await portal.security.createPairingToken(60000, grants), label: 'Profile RPC fixture', publicKey: key.publicKey });
    const socket = await RpcSocket.open(`ws://127.0.0.1:${server.addr.port}/rpc`, { ...key, credentialId: paired.principal.credentialId });
    sockets.push(socket); return { socket, credentialId: paired.principal.credentialId };
  };
  try {
    const admin = await connect(portal.security.defaultGrants());
    const capabilities = await admin.socket.request('portal.capabilities', {}) as any;
    expect(capabilities.capabilities).toContain('browser.profiles.v1');
    const { profile: work } = await admin.socket.request('browser.profile.create', { name: 'Work' }) as any;
    const { profile: personal } = await admin.socket.request('browser.profile.create', { name: 'Personal' }) as any;
    const scoped = await connect({ actions: ['browser.profile.inspect', 'browser.profile.control'], executionContextIds: [], agentIds: [], browserProfileIds: [work.profileId] });
    expect(await scoped.socket.request('browser.profile.list', {})).toEqual({ profiles: [work] });
    const controlOnly = await connect({ actions: ['browser.profile.control'], executionContextIds: [], agentIds: [], browserProfileIds: [work.profileId] });
    expect(await controlOnly.socket.request('browser.profile.list', {})).toEqual({ profiles: [work] });
    await expect(scoped.socket.request('browser.profile.rename', { profileId: work.profileId, name: 'Changed', expectedRevision: 0 })).rejects.toThrow('unavailable');
    const legacy = await connect({ actions: ['browser.observe', 'browser.control'], executionContextIds: [], agentIds: [], workspaceIds: ['*'] });
    await expect(legacy.socket.request('browser.profile.list', {})).rejects.toThrow('unavailable');
    const renamed = await admin.socket.request('browser.profile.rename', { profileId: work.profileId, name: 'Office', expectedRevision: 0 }) as any;
    expect(renamed.profile).toEqual({ ...work, name: 'Office', revision: 1 });
    expect(await scoped.socket.request('browser.profile.list', {})).toEqual({ profiles: [renamed.profile] });
    expect(await admin.socket.request('browser.profile.list', {})).toEqual({ profiles: [renamed.profile, personal] });
    await portal.security.revokeCredential(scoped.credentialId);
    await expect(scoped.socket.request('browser.profile.list', {})).rejects.toThrow();
  } finally {
    for (const socket of sockets) socket.close();
    await server.shutdown(); await portal.close(); await owner.close(); await rm(state, { recursive: true, force: true });
  }
}, 15000);
