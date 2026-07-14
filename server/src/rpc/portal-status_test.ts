import { assertEquals } from 'jsr:@std/assert@1';
import { RpcPeer, type RpcSocket } from '@weave/protocol/peer';
import { connectClientToolRpcHost, disconnectClientToolRpcHost } from '../client-tools/registry.ts';
import { connectPortalRpc, disconnectPortalRpc } from '../portal/registry.ts';

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

Deno.test('Portal registry broadcasts authoritative online and offline status to owner clients', async () => {
  const clientSocket = new MemorySocket();
  const serverSocket = new MemorySocket();
  const clientPeer = new RpcPeer(clientSocket);
  const serverPeer = new RpcPeer(serverSocket);
  clientSocket.peer = serverPeer;
  serverSocket.peer = clientPeer;
  const statuses: unknown[] = [];
  clientPeer.onNotification('portal.status.changed', (params) => {
    statuses.push(params);
  });
  connectClientToolRpcHost({
    clientId: 'status-client',
    userId: 'owner',
    peer: serverPeer,
    capabilities: [],
  });

  const portalPeer = new RpcPeer(new MemorySocket());
  connectPortalRpc({ portalId: 'status-portal', userId: 'owner', peer: portalPeer });
  await new Promise((resolve) => setTimeout(resolve, 0));
  disconnectPortalRpc('status-portal', portalPeer);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertEquals(statuses.map((status) => (status as { status: string }).status), ['online', 'offline']);
  disconnectClientToolRpcHost('status-client', serverPeer);
});
