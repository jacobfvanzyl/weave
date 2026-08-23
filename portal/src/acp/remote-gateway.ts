import {
  type HostRpcMethod,
  hostRpcMethods,
  type HostRpcParams,
  type HostRpcResult,
  type HostThreadSummary,
  jsonRpcMessageSchema,
  parseHostRpcParams,
  parseHostRpcResult,
  RpcApplicationError,
  rpcErrorCode,
  RpcPeer,
  WEAVE_HOST_ACP_PATH,
  WEAVE_HOST_RPC_PATH,
  WEAVE_HOST_RPC_PROTOCOL_VERSION,
} from '@weave/protocol';
import type { AgentRuntimePort } from './runtime.ts';
import type { HostThreadRecord, ThreadCatalog } from './thread-catalog.ts';

const tokenProtocolPrefix = 'weave-acp-token.';

const base64Url = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

const constantTimeEqual = (left: string, right: string) => {
  const max = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < max; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
};

const cookieValue = (header: string | null, name: string) => {
  for (const item of header?.split(';') ?? []) {
    const [key, ...parts] = item.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(parts.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
};

const authenticate = (request: Request, token: string) => {
  const authorization = request.headers.get('authorization');
  if (authorization?.startsWith('Bearer ') && constantTimeEqual(authorization.slice(7), token)) {
    return { ok: true as const };
  }
  const cookie = cookieValue(request.headers.get('cookie'), 'weave_host_token');
  if (cookie && constantTimeEqual(cookie, token)) return { ok: true as const };
  const expectedProtocol = `${tokenProtocolPrefix}${base64Url(token)}`;
  const protocols = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((value) => value.trim());
  if (protocols.some((protocol) => constantTimeEqual(protocol, expectedProtocol))) {
    return { ok: true as const, protocol: expectedProtocol };
  }
  return { ok: false as const };
};

const isLoopback = (hostname: string) =>
  hostname === '127.0.0.1' || hostname === '::1' || hostname.toLowerCase() === 'localhost';

export type RemoteAcpGateway = {
  readonly hostname: string;
  readonly port: number;
  readonly url: string;
  readonly rpcUrl: string;
  readonly finished: Promise<void>;
  close(): Promise<void>;
};

export const serveRemoteAcpGateway = async (input: {
  hostname?: string;
  port?: number;
  token: string;
  agentId: string;
  workspaceId: string;
  workspaces: { workspaceId: string; name: string; path: string }[];
  threadCatalog: ThreadCatalog;
  principalId?: string;
  allowedOrigins?: string[];
  privateNetwork?: boolean;
  runtimeManager: AgentRuntimePort;
}): Promise<RemoteAcpGateway> => {
  const hostname = input.hostname ?? '127.0.0.1';
  if (!input.token) throw new Error('Remote ACP requires an authentication token.');
  if (!isLoopback(hostname) && !input.privateNetwork) {
    throw new Error('Remote ACP refuses a non-loopback listener without explicit private-network mode.');
  }
  let listening: ((address: Deno.NetAddr) => void) | undefined;
  const listened = new Promise<Deno.NetAddr>((resolve) => {
    listening = resolve;
  });
  const sockets = new Set<WebSocket>();
  const attachments = new Set<Awaited<ReturnType<AgentRuntimePort['attach']>>>();
  const workspaceIds = new Set(input.workspaces.map((workspace) => workspace.workspaceId));
  const access = { workspaceIds };
  const threadSummary = ({ creatorPrincipalId: _principalId, ...thread }: HostThreadRecord): HostThreadSummary => {
    if (thread.status === 'deleted') throw new Error('Deleted Host Thread cannot cross the discovery boundary.');
    return { ...thread, status: thread.status };
  };
  const server = Deno.serve({
    hostname,
    port: input.port ?? 0,
    onListen: (address) => listening!(address as Deno.NetAddr),
  }, async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname !== WEAVE_HOST_ACP_PATH && url.pathname !== WEAVE_HOST_RPC_PATH) {
      return new Response('Not found', { status: 404 });
    }
    const authenticated = authenticate(request, input.token);
    if (!authenticated.ok) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'cache-control': 'no-store', 'www-authenticate': 'Bearer' },
      });
    }
    const origin = request.headers.get('origin');
    if (origin && !(input.allowedOrigins ?? []).includes(origin)) {
      return new Response('Forbidden origin', { status: 403, headers: { 'cache-control': 'no-store' } });
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }

    if (url.pathname === WEAVE_HOST_RPC_PATH) {
      const { socket, response } = Deno.upgradeWebSocket(request, {
        ...(authenticated.protocol ? { protocol: authenticated.protocol } : {}),
        idleTimeout: 120,
      });
      response.headers.set('cache-control', 'no-store');
      sockets.add(socket);
      const peer = new RpcPeer(socket, {
        onError: (error) => console.warn('[host-rpc] peer error', error.message),
      });
      const register = <Method extends HostRpcMethod>(
        method: Method,
        handler: (params: HostRpcParams<Method>) => HostRpcResult<Method> | Promise<HostRpcResult<Method>>,
      ) => {
        peer.register(method, async (value) => {
          let params: HostRpcParams<Method>;
          try {
            params = parseHostRpcParams(method, value);
          } catch {
            throw new RpcApplicationError(rpcErrorCode.invalidParams, 'Invalid params', { code: 'INVALID_PARAMS' });
          }
          return parseHostRpcResult(method, await handler(params));
        });
      };
      register('host.capabilities.get', () => ({
        protocolVersion: WEAVE_HOST_RPC_PROTOCOL_VERSION,
        capabilities: [...hostRpcMethods],
      }));
      register('workspace.list', () => ({
        workspaces: input.workspaces.map(({ workspaceId, name }) => ({ workspaceId, name })),
      }));
      register('agent.list', () => ({
        agents: input.runtimeManager.listDefinitions().map(({ id, name }) => ({ agentId: id, name })),
      }));
      register('thread.list', async () => ({
        threads: (await input.threadCatalog.list(access)).map(threadSummary),
      }));
      register('thread.get', async ({ threadId }) => ({
        thread: await input.threadCatalog.get(threadId, access).then((thread) => thread ? threadSummary(thread) : null),
      }));
      register('thread.attach', async ({ threadId }) => {
        const thread = await input.threadCatalog.get(threadId, access);
        if (!thread) {
          throw new RpcApplicationError(rpcErrorCode.notFound, 'Host Thread was not found.', { code: 'NOT_FOUND' });
        }
        return {
          thread: threadSummary(thread),
          connection: {
            path: WEAVE_HOST_ACP_PATH,
            threadId,
            cwd: input.workspaces.find((workspace) => workspace.workspaceId === thread.workspaceId)!.path,
          },
        };
      });
      socket.onmessage = (event) => void peer.receive(event.data);
      socket.onclose = () => {
        sockets.delete(socket);
        peer.socketClosed('Host RPC client disconnected.');
      };
      socket.onerror = () => peer.socketClosed('Host RPC WebSocket failed.');
      return response;
    }

    const selectedThreadId = url.searchParams.get('threadId')?.trim();
    const selectedThread = selectedThreadId ? await input.threadCatalog.get(selectedThreadId, access) : undefined;
    if (selectedThreadId && !selectedThread) return new Response('Thread not found', { status: 404 });
    const attachment = await input.runtimeManager.attach({
      agentId: selectedThread?.agentId ?? input.agentId,
      ...(selectedThread ? { acpSessionId: selectedThread.acpSessionId } : {}),
      workspaceId: selectedThread?.workspaceId ?? input.workspaceId,
      principalId: input.principalId ?? 'remote',
      transport: 'remote-acp',
    });
    attachments.add(attachment);
    const connectionId = crypto.randomUUID();
    const { socket, response } = Deno.upgradeWebSocket(request, {
      ...(authenticated.protocol ? { protocol: authenticated.protocol } : {}),
      idleTimeout: 120,
    });
    response.headers.set('Acp-Connection-Id', connectionId);
    response.headers.set('cache-control', 'no-store');
    sockets.add(socket);
    let initialized = false;
    let receiveQueue = Promise.resolve();
    let closed = false;
    const close = async (reason: string) => {
      if (closed) return;
      closed = true;
      sockets.delete(socket);
      attachments.delete(attachment);
      await attachment.close(reason).catch(() => undefined);
    };

    socket.onopen = () => {
      void (async () => {
        const reader = attachment.messages.getReader();
        try {
          while (socket.readyState === WebSocket.OPEN) {
            const { done, value } = await reader.read();
            if (done) {
              if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'ACP agent exited.');
              break;
            }
            socket.send(JSON.stringify(value));
          }
        } catch {
          if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'ACP agent transport failed.');
        } finally {
          reader.releaseLock();
        }
      })();
    };
    socket.onmessage = (event) => {
      receiveQueue = receiveQueue.then(async () => {
        if (typeof event.data !== 'string') {
          socket.close(1003, 'ACP WebSocket accepts text frames only.');
          return;
        }
        const message = jsonRpcMessageSchema.parse(JSON.parse(event.data));
        if (!initialized) {
          if (!('method' in message) || message.method !== 'initialize' || !('id' in message)) {
            socket.close(4400, 'initialize must be the first ACP message.');
            return;
          }
          initialized = true;
        }
        await attachment.receive(message);
      }).catch(() => socket.close(4400, 'Invalid ACP message.'));
    };
    socket.onclose = () => void close('Remote ACP client disconnected.');
    socket.onerror = () => void close('Remote ACP WebSocket failed.');
    return response;
  });
  const address = await listened;
  const port = address.port;
  return {
    hostname,
    port,
    url: `ws://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}${WEAVE_HOST_ACP_PATH}`,
    rpcUrl: `ws://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}${WEAVE_HOST_RPC_PATH}`,
    finished: server.finished,
    close: async () => {
      for (const socket of sockets) socket.close(1001, 'Host Daemon stopping.');
      await Promise.allSettled([...attachments].map((attachment) => attachment.close('Host Daemon stopping.')));
      await server.shutdown();
    },
  };
};

export const remoteAcpGatewayInternals = {
  authenticate,
  base64Url,
  constantTimeEqual,
  tokenProtocol: (token: string) => `${tokenProtocolPrefix}${base64Url(token)}`,
};
