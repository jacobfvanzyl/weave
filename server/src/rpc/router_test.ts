import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { RpcPeer, RpcRemoteError, type RpcSocket } from '../../../packages/protocol/src/peer.ts';
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
  router.register('owner.get', 'client', () => ({ role: 'client' }));
  router.register('portal.tool.call', 'portal', () => ({ role: 'portal' }));
  router.register(
    'binary.ack',
    ['client', 'portal'],
    (_params, context) => ({ role: context.session.role }),
  );

  const pair = peers();
  const detach = router.attach(session(pair.server, 'client'));
  assertEquals(await pair.client.request('owner.get'), { role: 'client' });
  assertEquals(await pair.client.request('binary.ack'), { role: 'client' });
  await assertRejects(
    () => pair.client.request('portal.tool.call'),
    RpcRemoteError,
    'Method not found',
  );
  assertEquals(router.listMethods('client'), ['binary.ack', 'owner.get']);
  assertEquals(router.listMethods('portal'), [
    'binary.ack',
    'portal.tool.call',
  ]);

  detach();
  await assertRejects(
    () => pair.client.request('owner.get'),
    RpcRemoteError,
    'Method not found',
  );
});
