import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { rpcErrorCode } from '@weave/protocol';
import { RpcPeer, RpcRemoteError, type RpcSocket } from '@weave/protocol/peer';
import { ownerResponse } from '../owner/auth.ts';
import { createOwnerRequestContext } from '../owner/context.ts';
import { RpcRouter, type RpcSession } from './router.ts';

class MemorySocket implements RpcSocket {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  peer?: RpcPeer;
  send(data: string) {
    queueMicrotask(() => void this.peer?.receive(data));
  }
  close(_code?: number, reason?: string) {
    this.readyState = WebSocket.CLOSED;
    this.peer?.socketClosed(reason);
  }
}

const peers = () => {
  const clientSocket = new MemorySocket();
  const serverSocket = new MemorySocket();
  const client = new RpcPeer(clientSocket);
  const server = new RpcPeer(serverSocket);
  clientSocket.peer = server;
  serverSocket.peer = client;
  return { client, server };
};

const session = (peer: RpcPeer, role: 'client' | 'portal'): RpcSession => {
  const common = {
    role,
    connectionId: `${role}-connection`,
    peer,
    ownerContext: createOwnerRequestContext({
      id: 'owner',
      name: 'Owner',
      role: 'owner',
    }),
    capabilities: [],
    lifetimeSignal: new AbortController().signal,
  };
  return role === 'client' ? { ...common, role, clientId: 'client' } : { ...common, role, portalId: 'portal' };
};

Deno.test('RpcRouter exposes only methods allowed for the initialized role', async () => {
  const router = new RpcRouter();
  router.registerValidated('owner.get', 'client', () => ownerResponse({ id: 'owner', name: 'Owner', role: 'owner' }));
  router.register('initialize', ['client', 'portal'], (_params, { session }) =>
    session.role === 'portal'
      ? {
        protocolVersion: 2,
        role: 'portal',
        connectionId: 'portal-connection',
        heartbeatIntervalMs: 30_000,
        maxFrameBytes: 1024 * 1024,
        capabilities: [],
        portal: { portalId: 'portal', name: 'Portal' },
      }
      : {
        protocolVersion: 2,
        role: 'client',
        connectionId: 'client-connection',
        heartbeatIntervalMs: 30_000,
        maxFrameBytes: 1024 * 1024,
        capabilities: [],
        owner: { id: 'owner', name: 'Owner' },
      });
  router.register(
    'binary.ack',
    ['client', 'portal'],
    () => ({ ok: true }),
  );

  const pair = peers();
  const detach = router.attach(session(pair.server, 'client'));
  assertEquals(await pair.client.request('owner.get'), { owner: { id: 'owner', name: 'Owner' } });
  assertEquals(await pair.client.request('binary.ack'), { ok: true });
  assertEquals((await pair.client.request('initialize') as { role: string }).role, 'client');
  assertEquals(router.listMethods('client'), ['binary.ack', 'initialize', 'owner.get']);
  assertEquals(router.listMethods('portal'), [
    'binary.ack',
    'initialize',
  ]);

  detach();
  const attachPortal = router.attach(session(pair.server, 'portal'));
  await assertRejects(
    () => pair.client.request('owner.get'),
    RpcRemoteError,
    'Method not found',
  );
  assertEquals((await pair.client.request('initialize') as { role: string }).role, 'portal');
  attachPortal();
});

Deno.test('RpcRouter validates internal module results before they leave the server', async () => {
  const router = new RpcRouter();
  router.registerValidated('owner.get', 'client', () => ({
    owner: { id: 42, name: 'invalid' },
  }));

  const pair = peers();
  router.attach(session(pair.server, 'client'));
  const error = await pair.client.request('owner.get').catch((value) => value);

  if (!(error instanceof RpcRemoteError)) throw error;
  assertEquals(error.code, rpcErrorCode.applicationInternal);
  assertEquals(error.message, 'Internal error');
  assertEquals(error.data, { code: 'INTERNAL' });
});
