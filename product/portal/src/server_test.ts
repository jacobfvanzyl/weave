import { PORTAL_TOKEN_PROTOCOL_PREFIX } from '@weave/product-protocol';
import { assertEquals, assertRejects } from 'jsr:@std/assert@1.0.14';
import { dirname, fromFileUrl, join } from 'jsr:@std/path@1.1.2';
import type { PortalConfig } from './config.ts';
import { type JsonRpcMessage, parseJsonRpcMessage } from './json-rpc.ts';
import { Portal } from './portal.ts';
import { startPortalServer } from './server.ts';

const tokenProtocol = (token: string) => {
  const bytes = new TextEncoder().encode(token);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${PORTAL_TOKEN_PROTOCOL_PREFIX}${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
};

class RpcSocket {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(cause: unknown): void }>();
  readonly notifications: JsonRpcMessage[] = [];
  #nextId = 0;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.onmessage = (event) => {
      const message = parseJsonRpcMessage(String(event.data));
      if (typeof message.id === 'number' && message.method === undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else {
        this.notifications.push(message);
      }
    };
    socket.onclose = (event) => {
      for (const pending of this.#pending.values()) pending.reject(new Error(event.reason || 'WebSocket closed.'));
      this.#pending.clear();
    };
  }

  static async open(url: string, token: string) {
    const socket = new WebSocket(url, tokenProtocol(token));
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('WebSocket failed to open.'));
    });
    return new RpcSocket(socket);
  }

  request(method: string, params: unknown = {}) {
    const id = ++this.#nextId;
    const response = new Promise<unknown>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return response;
  }

  close() {
    this.#socket.close();
  }
}

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

Deno.test('Alpha-facing Portal creates and prompts an ACP Thread over the product protocol', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-product-portal-' });
  const workspacePath = join(root, 'workspace');
  await Deno.mkdir(workspacePath);
  const fakeAgent = join(dirname(fromFileUrl(import.meta.url)), 'test-fixtures', 'fake-agent.ts');
  const token = 'acceptance-token';
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    accessToken: token,
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{ workspaceId: 'workspace', name: 'Workspace', path: workspacePath }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: Deno.execPath(),
      args: ['run', '--quiet', '--allow-read', fakeAgent],
      env: {},
    }],
  };
  const portal = await Portal.open(config);
  const server = startPortalServer(portal);
  const address = server.addr as Deno.NetAddr;
  const baseUrl = `ws://127.0.0.1:${address.port}`;
  try {
    const rpc = await RpcSocket.open(`${baseUrl}/rpc`, token);
    const capabilities = await rpc.request('portal.capabilities') as { capabilities: string[] };
    assertEquals(capabilities.capabilities.includes('thread.create'), true);

    const created = await rpc.request('thread.create', { workspaceId: 'workspace', agentId: 'fake' }) as {
      thread: { threadId: string; acpSessionId: string };
    };
    assertEquals(created.thread.acpSessionId, 'fake-session');
    const listed = await rpc.request('thread.list') as { threads: Array<{ threadId: string }> };
    assertEquals(listed.threads.map((thread) => thread.threadId), [created.thread.threadId]);

    const attached = await rpc.request('thread.attach', { threadId: created.thread.threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acp = await RpcSocket.open(
      `${baseUrl}${attached.connection.path}?threadId=${attached.connection.threadId}`,
      token,
    );
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const loaded = await acp.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
    });
    assertEquals(loaded, {
      modes: {
        currentModeId: 'ask',
        availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }],
      },
      configOptions: [{
        type: 'boolean',
        id: 'fast',
        name: 'Fast mode',
        currentValue: false,
      }],
    });
    const mode = await acp.request('session/set_mode', {
      sessionId: 'fake-session',
      modeId: 'code',
    });
    assertEquals(mode, {});
    assertEquals(
      acp.notifications.filter((message) => JSON.stringify(message).includes('current_mode_update')).length,
      1,
    );
    const configured = await acp.request('session/set_config_option', {
      sessionId: 'fake-session',
      configId: 'fast',
      type: 'boolean',
      value: true,
    });
    assertEquals(configured, {
      configOptions: [{
        type: 'boolean',
        id: 'fast',
        name: 'Fast mode',
        currentValue: true,
      }],
    });
    const observer = await RpcSocket.open(
      `${baseUrl}${attached.connection.path}?threadId=${attached.connection.threadId}`,
      token,
    );
    await observer.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    assertEquals(
      await observer.request('session/load', {
        sessionId: 'fake-session',
        cwd: workspacePath,
        mcpServers: [],
      }),
      {
        modes: {
          currentModeId: 'code',
          availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }],
        },
        configOptions: [{
          type: 'boolean',
          id: 'fast',
          name: 'Fast mode',
          currentValue: true,
        }],
      },
    );
    const prompting = acp.request('session/prompt', {
      sessionId: 'fake-session',
      prompt: [{ type: 'text', text: 'SLOW' }],
    });
    await assertRejects(
      () =>
        observer.request('session/prompt', {
          sessionId: 'fake-session',
          prompt: [{ type: 'text', text: 'CONFLICT' }],
        }),
      Error,
      'Another prompt is already active.',
    );
    await prompting;
    await waitFor(() =>
      [acp, observer].every((client) =>
        client.notifications.some((message) => JSON.stringify(message).includes('FAKE_AGENT:SLOW'))
      )
    );
    assertEquals(
      acp.notifications.filter((message) =>
        JSON.stringify(message).includes('user_message_chunk') &&
        JSON.stringify(message).includes('SLOW')
      ).length,
      0,
    );
    assertEquals(
      observer.notifications.filter((message) =>
        JSON.stringify(message).includes('user_message_chunk') &&
        JSON.stringify(message).includes('SLOW')
      ).length,
      1,
    );
    observer.close();
    acp.close();

    const reattached = await RpcSocket.open(
      `${baseUrl}${attached.connection.path}?threadId=${attached.connection.threadId}`,
      token,
    );
    await reattached.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await reattached.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
    });
    assertEquals(
      reattached.notifications.map((message) => JSON.stringify(message)).filter((message) => message.includes('SLOW'))
        .map((message) => message.includes('user_message_chunk') ? 'user' : 'agent'),
      ['user', 'agent'],
    );
    reattached.close();
    rpc.close();
  } finally {
    await server.shutdown();
    await portal.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Portal replays durable Thread events after a daemon restart', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-product-portal-restart-' });
  const workspacePath = join(root, 'workspace');
  await Deno.mkdir(workspacePath);
  const fakeAgent = join(dirname(fromFileUrl(import.meta.url)), 'test-fixtures', 'fake-agent.ts');
  const token = 'restart-token';
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    accessToken: token,
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{ workspaceId: 'workspace', name: 'Workspace', path: workspacePath }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: Deno.execPath(),
      args: ['run', '--quiet', '--allow-read', fakeAgent],
      env: {},
    }],
  };

  let threadId = '';
  const firstPortal = await Portal.open(config);
  const firstServer = startPortalServer(firstPortal);
  const firstAddress = firstServer.addr as Deno.NetAddr;
  try {
    const rpc = await RpcSocket.open(`ws://127.0.0.1:${firstAddress.port}/rpc`, token);
    const created = await rpc.request('thread.create', { workspaceId: 'workspace', agentId: 'fake' }) as {
      thread: { threadId: string; acpSessionId: string };
    };
    threadId = created.thread.threadId;
    const attached = await rpc.request('thread.attach', { threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acp = await RpcSocket.open(
      `ws://127.0.0.1:${firstAddress.port}${attached.connection.path}?threadId=${threadId}`,
      token,
    );
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await acp.request('session/load', { sessionId: 'fake-session', cwd: workspacePath, mcpServers: [] });
    await acp.request('session/prompt', {
      sessionId: 'fake-session',
      prompt: [{ type: 'text', text: 'BEFORE_RESTART' }],
    });
    await waitFor(() =>
      acp.notifications.some((message) => JSON.stringify(message).includes('FAKE_AGENT:BEFORE_RESTART'))
    );
    acp.close();
    rpc.close();
  } finally {
    await firstServer.shutdown();
    await firstPortal.close();
  }

  const secondPortal = await Portal.open(config);
  const secondServer = startPortalServer(secondPortal);
  const secondAddress = secondServer.addr as Deno.NetAddr;
  try {
    const rpc = await RpcSocket.open(`ws://127.0.0.1:${secondAddress.port}/rpc`, token);
    const attached = await rpc.request('thread.attach', { threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acp = await RpcSocket.open(
      `ws://127.0.0.1:${secondAddress.port}${attached.connection.path}?threadId=${threadId}`,
      token,
    );
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await acp.request('session/load', { sessionId: 'fake-session', cwd: workspacePath, mcpServers: [] });
    assertEquals(
      acp.notifications
        .map((message) => JSON.stringify(message))
        .filter((message) => message.includes('BEFORE_RESTART'))
        .map((message) => message.includes('user_message_chunk') ? 'user' : 'agent'),
      ['user', 'agent'],
    );
    acp.close();
    rpc.close();
  } finally {
    await secondServer.shutdown();
    await secondPortal.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Portal rejects an invalid access token before exposing metadata', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-product-portal-auth-' });
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    accessToken: 'correct',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{ workspaceId: 'workspace', name: 'Workspace', path: root }],
    agents: [{ agentId: 'fake', name: 'Fake', command: 'false', args: [], env: {} }],
  };
  const portal = await Portal.open(config);
  const server = startPortalServer(portal);
  const address = server.addr as Deno.NetAddr;
  try {
    await assertRejects(() => RpcSocket.open(`ws://127.0.0.1:${address.port}/rpc`, 'incorrect'));
  } finally {
    await server.shutdown();
    await portal.close();
    await Deno.remove(root, { recursive: true });
  }
});
