import { assertEquals } from 'jsr:@std/assert@1';
import { verifyRemoteRpc } from '../../../scripts/dokploy-server.ts';

Deno.test('deployment RPC probe upgrades /rpc and completes initialize', async () => {
  const previousToken = Deno.env.get('WEAVE_REMOTE_OWNER_TOKEN');
  Deno.env.set('WEAVE_REMOTE_OWNER_TOKEN', 'probe-token');
  let receivedPath = '';
  let initialize: Record<string, unknown> | undefined;
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => undefined }, request => {
    receivedPath = new URL(request.url).pathname;
    const { socket, response } = Deno.upgradeWebSocket(request);
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      initialize = message;
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: 1,
          connectionId: 'probe-connection',
          role: 'client',
          heartbeatIntervalMs: 20_000,
          maxFrameBytes: 1024 * 1024,
          capabilities: [],
          owner: { id: 'owner', name: 'Owner' },
        },
      }));
    };
    return response;
  });
  try {
    const address = server.addr as Deno.NetAddr;
    await verifyRemoteRpc(`http://127.0.0.1:${address.port}`);
    assertEquals(receivedPath, '/rpc');
    assertEquals(initialize?.method, 'initialize');
    assertEquals((initialize?.params as Record<string, unknown>).token, 'probe-token');
  } finally {
    if (previousToken === undefined) Deno.env.delete('WEAVE_REMOTE_OWNER_TOKEN');
    else Deno.env.set('WEAVE_REMOTE_OWNER_TOKEN', previousToken);
    await server.shutdown();
  }
});
