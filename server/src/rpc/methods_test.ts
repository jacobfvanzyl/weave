import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { RpcPeer, RpcRemoteError, type RpcSocket } from '@weave/protocol/peer';
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

const clientSession = (peer: RpcPeer): RpcSession => ({
  role: 'client',
  connectionId: 'client-connection',
  peer,
  ownerContext: createOwnerRequestContext({
    id: 'owner-1',
    name: 'Owner',
    role: 'owner',
  }),
  clientId: 'client-1',
  capabilities: [],
  lifetimeSignal: new AbortController().signal,
});

Deno.test('chat.thread.create resolves the Workspace owner before persisting a Thread', async () => {
  const previousDatabaseUrl = Deno.env.get('WEAVE_DATABASE_URL');
  Deno.env.set('WEAVE_DATABASE_URL', 'postgres://weave:weave@127.0.0.1:5432/weave_test');
  try {
    const { registerCoreRpcMethods } = await import('./methods.ts');
    const created: unknown[] = [];
    const router = new RpcRouter();
    const services = {
      agent: {
        service: {
          createChatThread: (input: unknown) => {
            created.push(input);
            return {
              id: 'thread-1',
              title: 'Workspace Thread',
              resourceId: 'owner-1',
              createdAt: '2026-08-09T08:00:00.000Z',
              updatedAt: '2026-08-09T08:00:00.000Z',
              metadata: {
                mode: 'project',
                projectId: 'project-1',
                workspaceId: 'workspace-1',
              },
            };
          },
        },
      },
    } as unknown as Parameters<typeof registerCoreRpcMethods>[1];
    registerCoreRpcMethods(
      router,
      services,
      {
        projects: {
          get: (ownerId: string, projectId: string) =>
            Promise.resolve(
              ownerId === 'owner-1' && projectId === 'project-1'
                ? {
                  id: 'project-1',
                  workspaces: [{ id: 'workspace-1' }],
                }
                : undefined,
            ),
        },
      },
    );
    const pair = peers();
    router.attach(clientSession(pair.server));

    await assertRejects(
      () =>
        pair.client.request('chat.thread.create', {
          threadId: 'thread-1',
          projectId: 'project-1',
          workspaceId: 'workspace-missing',
        }),
      RpcRemoteError,
      'Workspace was not found.',
    );
    assertEquals(created, []);

    const result = await pair.client.request('chat.thread.create', {
      threadId: 'thread-1',
      title: 'Workspace Thread',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
    });
    assertEquals((result as { thread: { metadata?: unknown } }).thread.metadata, {
      mode: 'project',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
    });
    assertEquals(created, [{
      resourceId: 'owner-1',
      threadId: 'thread-1',
      title: 'Workspace Thread',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
    }]);
  } finally {
    if (previousDatabaseUrl === undefined) Deno.env.delete('WEAVE_DATABASE_URL');
    else Deno.env.set('WEAVE_DATABASE_URL', previousDatabaseUrl);
  }
});
