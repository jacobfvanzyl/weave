import {
  parsePortalRpcParams,
  PORTAL_ACP_PATH,
  PORTAL_RPC_METHODS,
  PORTAL_RPC_PATH,
  PORTAL_TOKEN_PROTOCOL_PREFIX,
  type PortalRpcMethod,
  WORKSPACE_FILE_RPC_METHODS,
  WORKSPACE_FILE_WATCH_EVENT_METHOD,
} from '@weave/product-protocol';
import { error, type JsonRpcMessage, parseJsonRpcMessage, result } from './json-rpc.ts';
import { Portal } from './portal.ts';
import { WorkspaceFileError } from './workspace-files.ts';

const tokenProtocol = (token: string) => {
  const bytes = new TextEncoder().encode(token);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${PORTAL_TOKEN_PROTOCOL_PREFIX}${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
};

const protocols = (request: Request) =>
  (request.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

const send = (socket: WebSocket, message: JsonRpcMessage) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};

const websocket = (request: Request, portal: Portal) => {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && portal.config.allowedOrigins.length && !portal.config.allowedOrigins.includes(origin)) {
    return new Response('Origin is not allowed.', { status: 403 });
  }
  const expectedProtocol = tokenProtocol(portal.config.accessToken);
  if (!protocols(request).includes(expectedProtocol)) return new Response('Unauthorized.', { status: 401 });
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('WebSocket required.', { status: 426 });
  }
  const threadId = url.pathname === PORTAL_ACP_PATH ? url.searchParams.get('threadId')?.trim() : undefined;
  if (url.pathname === PORTAL_ACP_PATH && !threadId) return new Response('threadId is required.', { status: 400 });

  const upgraded = Deno.upgradeWebSocket(request, { protocol: expectedProtocol });
  if (url.pathname === PORTAL_RPC_PATH) {
    const session = portal.connectRpc((notification) =>
      send(upgraded.socket, {
        jsonrpc: '2.0',
        method: WORKSPACE_FILE_WATCH_EVENT_METHOD,
        params: notification,
      })
    );
    upgraded.socket.onmessage = async (event) => {
      let message: JsonRpcMessage;
      try {
        message = parseJsonRpcMessage(String(event.data));
      } catch (cause) {
        send(
          upgraded.socket,
          error(null, -32700, cause instanceof Error ? cause.message : 'Invalid JSON-RPC message.'),
        );
        return;
      }
      if (message.id === undefined || !message.method) return;
      if (!PORTAL_RPC_METHODS.includes(message.method as PortalRpcMethod)) {
        send(upgraded.socket, error(message.id, -32601, `Unknown Portal method: ${message.method}`));
        return;
      }
      try {
        const method = message.method as PortalRpcMethod;
        const params = parsePortalRpcParams(method, message.params ?? {});
        const value = await session.request(method, params);
        send(upgraded.socket, result(message.id, value));
      } catch (cause) {
        const filesystemRequest = WORKSPACE_FILE_RPC_METHODS.includes(message.method as never);
        send(
          upgraded.socket,
          cause instanceof WorkspaceFileError
            ? error(message.id, -32010, cause.message, cause.data)
            : error(
              message.id,
              -32000,
              filesystemRequest
                ? 'Workspace filesystem request failed.'
                : cause instanceof Error
                ? cause.message
                : String(cause),
            ),
        );
      }
    };
    upgraded.socket.onclose = () => session.close();
    return upgraded.response;
  }

  const attachment = portal.connectThread(threadId!, (message) => send(upgraded.socket, message));
  upgraded.socket.onopen = () =>
    attachment.catch((cause) => {
      upgraded.socket.close(1011, cause instanceof Error ? cause.message : 'Thread attachment failed.');
    });
  upgraded.socket.onmessage = async (event) => {
    try {
      await (await attachment).receive(parseJsonRpcMessage(String(event.data)));
    } catch (cause) {
      send(upgraded.socket, error(null, -32700, cause instanceof Error ? cause.message : 'Invalid JSON-RPC message.'));
    }
  };
  upgraded.socket.onclose = () => void attachment.then((value) => value.close()).catch(() => undefined);
  return upgraded.response;
};

export const startPortalServer = (portal: Portal, onListen?: (address: Deno.NetAddr) => void) =>
  Deno.serve({
    hostname: portal.config.listen.hostname,
    port: portal.config.listen.port,
    onListen,
  }, (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ status: 'ok', product: 'weave-portal' });
    if (path !== PORTAL_RPC_PATH && path !== PORTAL_ACP_PATH) return new Response('Not found.', { status: 404 });
    return websocket(request, portal);
  });
