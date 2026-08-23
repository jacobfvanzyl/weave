import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { AgentRuntimeManager } from './runtime.ts';
import { AcpSessionBroker } from './session-broker.ts';
import { remoteAcpGatewayInternals, serveRemoteAcpGateway } from './remote-gateway.ts';
import { FileThreadCatalog, type ThreadCatalog } from './thread-catalog.ts';
import { InMemoryThreadEventJournal } from './thread-event-journal.ts';

const waitForOpen = (socket: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('WebSocket failed to open.'));
  });

Deno.test('draft Remote ACP WebSocket authenticates before relaying ACP', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'weave-remote-acp-' });
  const threadCatalog = await FileThreadCatalog.open(`${directory}/threads.json`, { createId: () => 'thread-1' });
  const threadEventJournal = new InMemoryThreadEventJournal();
  const fixturePath = decodeURIComponent(new URL('./test-fixtures/fake-agent.ts', import.meta.url).pathname);
  const manager = new AcpSessionBroker(
    new AgentRuntimeManager(
      [{ id: 'fake', name: 'Fake Agent', command: Deno.execPath(), args: ['run', '--quiet', fixturePath] }],
      {
        resolveWorkspace: (selection, principalId) => {
          assertEquals(selection, { workspaceId: 'workspace-1', workspacePath: undefined });
          assertEquals(principalId, 'remote-user');
          return Promise.resolve({ workspaceId: 'workspace-1', path: directory });
        },
        threadCatalog,
        closeGraceMs: 100,
      },
    ),
    { eventJournal: threadEventJournal },
  );
  const token = 'test-token-without-secrets';
  const gateway = await serveRemoteAcpGateway({
    token,
    agentId: 'fake',
    workspaceId: 'workspace-1',
    workspaces: [{ workspaceId: 'workspace-1', name: 'Workspace One', path: directory }],
    threadCatalog,
    threadEventJournal,
    principalId: 'remote-user',
    runtimeManager: manager,
  });

  try {
    const unauthorized = await fetch(gateway.url.replace('ws:', 'http:'));
    assertEquals(unauthorized.status, 401);

    const protocol = remoteAcpGatewayInternals.tokenProtocol(token);
    const socket = new WebSocket(gateway.url, protocol);
    const messages: Record<string, unknown>[] = [];
    const complete = new Promise<void>((resolve, reject) => {
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        messages.push(message);
        if (message.id === 3) resolve();
      };
      socket.onerror = () => reject(new Error('Remote ACP WebSocket failed.'));
    });
    await waitForOpen(socket);
    assertEquals(socket.protocol, protocol);
    for (
      const message of [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'test', version: '1' } },
        },
        { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: directory, mcpServers: [] } },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'session/prompt',
          params: { sessionId: 'fake-session-1', prompt: [{ type: 'text', text: 'hello' }] },
        },
      ]
    ) socket.send(JSON.stringify(message));
    await complete;
    socket.close();
    assertEquals(messages.map((message) => message.id ?? message.method), [1, 2, 'session/update', 3]);

    const rpcSocket = new WebSocket(gateway.rpcUrl, protocol);
    const rpcResponses: Record<string, unknown>[] = [];
    const rpcComplete = new Promise<void>((resolve, reject) => {
      rpcSocket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        rpcResponses.push(message);
        if (message.id === 11) resolve();
      };
      rpcSocket.onerror = () => reject(new Error('Host RPC WebSocket failed.'));
      rpcSocket.onclose = (event) => reject(new Error(`Host RPC closed: ${event.code} ${event.reason}`));
    });
    await waitForOpen(rpcSocket);
    rpcSocket.send(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'thread.list', params: {} }));
    rpcSocket.send(
      JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'thread.attach', params: { threadId: 'thread-1' } }),
    );
    await rpcComplete;
    rpcSocket.close();
    assertEquals((rpcResponses[0].result as { threads: { threadId: string }[] }).threads[0].threadId, 'thread-1');
    assertEquals(rpcResponses[1], {
      jsonrpc: '2.0',
      id: 11,
      result: {
        thread: {
          threadId: 'thread-1',
          agentId: 'fake',
          workspaceId: 'workspace-1',
          acpSessionId: 'fake-session-1',
          status: 'active',
          createdAt: (rpcResponses[1].result as { thread: { createdAt: string } }).thread.createdAt,
          updatedAt: (rpcResponses[1].result as { thread: { updatedAt: string } }).thread.updatedAt,
          lastEventSequence: 2,
        },
        connection: { path: '/acp', threadId: 'thread-1', cwd: directory },
      },
    });
  } finally {
    await gateway.close();
    await manager.close();
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('draft Remote ACP refuses non-loopback exposure without private-network mode', async () => {
  const emptyCatalog: ThreadCatalog = {
    upsertAcpSession: () => Promise.reject(new Error('unused')),
    touchAcpSession: () => Promise.resolve(),
    setAcpSessionStatus: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
  };
  const manager = new AgentRuntimeManager([], {
    resolveWorkspace: () => Promise.resolve({ workspaceId: 'root', path: '/' }),
  });
  await assertRejects(
    () =>
      serveRemoteAcpGateway({
        hostname: '0.0.0.0',
        token: 'token',
        agentId: 'missing',
        workspaceId: 'missing',
        workspaces: [],
        threadCatalog: emptyCatalog,
        runtimeManager: manager,
      }),
    Error,
    'explicit private-network mode',
  );
});

Deno.test('draft Remote ACP attaches a second live client through the shared session broker', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'weave-remote-acp-shared-' });
  const threadCatalog = await FileThreadCatalog.open(`${directory}/threads.json`, { createId: () => 'thread-1' });
  const fixturePath = decodeURIComponent(new URL('./test-fixtures/fake-agent.ts', import.meta.url).pathname);
  const manager = new AcpSessionBroker(
    new AgentRuntimeManager(
      [{ id: 'fake', name: 'Fake Agent', command: Deno.execPath(), args: ['run', '--quiet', fixturePath] }],
      {
        resolveWorkspace: () => Promise.resolve({ workspaceId: 'workspace-1', path: directory }),
        threadCatalog,
        closeGraceMs: 100,
      },
    ),
  );
  const token = 'shared-test-token';
  const gateway = await serveRemoteAcpGateway({
    token,
    agentId: 'fake',
    workspaceId: 'workspace-1',
    workspaces: [{ workspaceId: 'workspace-1', name: 'Workspace One', path: directory }],
    threadCatalog,
    principalId: 'remote-user',
    runtimeManager: manager,
  });
  const protocol = remoteAcpGatewayInternals.tokenProtocol(token);
  const first = new WebSocket(gateway.url, protocol);
  const firstMessages: Record<string, unknown>[] = [];
  let firstUpdateCount = 0;
  let resolveFirstLiveUpdate: (() => void) | undefined;
  const firstLiveUpdate = new Promise<void>((resolve) => {
    resolveFirstLiveUpdate = resolve;
  });
  first.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    firstMessages.push(message);
    if (message.method === 'session/update') {
      firstUpdateCount += 1;
      if (firstUpdateCount >= 3) resolveFirstLiveUpdate?.();
    }
  };

  try {
    await waitForOpen(first);
    const firstComplete = new Promise<void>((resolve, reject) => {
      const previous = first.onmessage;
      first.onmessage = (event) => {
        previous?.call(first, event);
        if (JSON.parse(String(event.data)).id === 3) resolve();
      };
      first.onerror = () => reject(new Error('First Remote ACP client failed.'));
    });
    first.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'first', version: '1' } },
    }));
    first.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: directory, mcpServers: [] },
    }));
    first.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: 'fake-session-1', prompt: [{ type: 'text', text: 'first' }] },
    }));
    await firstComplete;

    const second = new WebSocket(`${gateway.url}?threadId=thread-1`, protocol);
    const secondMessages: Record<string, unknown>[] = [];
    try {
      const secondLoaded = new Promise<void>((resolve, reject) => {
        second.onmessage = (event) => {
          const message = JSON.parse(String(event.data));
          secondMessages.push(message);
          if (message.id === 2) resolve();
        };
        second.onerror = () => reject(new Error('Second Remote ACP client failed.'));
      });
      await waitForOpen(second);
      second.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'second', version: '1' } },
      }));
      second.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/load',
        params: { sessionId: 'fake-session-1', cwd: directory, mcpServers: [] },
      }));
      await secondLoaded;
      assertEquals(secondMessages.map((message) => message.id ?? message.method), [
        1,
        'session/update',
        'session/update',
        2,
      ]);

      const secondPrompt = new Promise<void>((resolve) => {
        const previous = second.onmessage;
        second.onmessage = (event) => {
          previous?.call(second, event);
          if (JSON.parse(String(event.data)).id === 3) resolve();
        };
      });
      second.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: { sessionId: 'fake-session-1', prompt: [{ type: 'text', text: 'second' }] },
      }));
      await Promise.all([secondPrompt, firstLiveUpdate]);

      first.close();
      const postDetachPrompt = new Promise<void>((resolve) => {
        const previous = second.onmessage;
        second.onmessage = (event) => {
          previous?.call(second, event);
          if (JSON.parse(String(event.data)).id === 4) resolve();
        };
      });
      second.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'session/prompt',
        params: { sessionId: 'fake-session-1', prompt: [{ type: 'text', text: 'after detach' }] },
      }));
      await postDetachPrompt;
      assertEquals(firstMessages.filter((message) => message.method === 'session/update').length, 3);
    } finally {
      second.close();
    }
  } finally {
    first.close();
    await gateway.close();
    await manager.close();
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
