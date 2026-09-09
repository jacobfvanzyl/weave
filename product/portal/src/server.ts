import { hostVersion } from './version.ts';
import { HostWebSocket, type HostUpgrade } from './host-websocket.ts';
import { readTextSync } from './host-files.ts';
import {
  parsePortalAuthResponse,
  parsePortalPairRequest,
  parsePortalRpcParams,
  PORTAL_ACP_PATH,
  PORTAL_AUTHENTICATED_TYPE,
  PORTAL_PAIR_PATH,
  PORTAL_RPC_METHODS,
  PORTAL_RPC_PATH,
  PORTAL_WEBSOCKET_PROTOCOL,
  type PortalPrincipalSummary,
  type PortalRpcMethod,
  TERMINAL_EVENT_METHOD,
  WORKSPACE_FILE_RPC_METHODS,
  WORKSPACE_FILE_WATCH_EVENT_METHOD,
} from '@weave/product-protocol';
import { error, type JsonRpcMessage, parseJsonRpcMessage, result } from './json-rpc.ts';
import { Portal, PortalThreadLifecycleError } from './portal.ts';
import { type PortalPrincipal, PortalSecurityError } from './security.ts';
import { WorkspaceFileError } from './workspace-files.ts';
import { PortalTerminalError } from './terminals.ts';

const protocols = (request: Request) =>
  (request.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

const sendJson = (socket: HostWebSocket, message: unknown) => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
};

const send = (socket: HostWebSocket, message: JsonRpcMessage) => sendJson(socket, message);

const TERMINAL_SOCKET_BACKLOG_LIMIT = 256 * 1024;
export const sendTerminal = (
  socket: Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'close'>,
  message: JsonRpcMessage,
) => {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const encoded = JSON.stringify(message);
  if (
    socket.bufferedAmount + new TextEncoder().encode(encoded).byteLength >
      TERMINAL_SOCKET_BACKLOG_LIMIT
  ) {
    socket.close(1013, 'Terminal stream fell behind; reconnect to resync.');
    return false;
  }
  socket.send(encoded);
  return true;
};

const principalSummary = (
  principal: PortalPrincipal,
): PortalPrincipalSummary => ({
  principalId: principal.principalId,
  credentialId: principal.credentialId,
  label: principal.label,
});

const validateUpgrade = (request: Request, portal: Portal) => {
  const origin = request.headers.get('origin');
  if (origin && !portal.config.allowedOrigins.includes(origin)) {
    return new Response('Origin is not allowed.', { status: 403 });
  }
  if (!protocols(request).includes(PORTAL_WEBSOCKET_PROTOCOL)) {
    return new Response('WebSocket protocol is not supported.', {
      status: 400,
    });
  }
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('WebSocket required.', { status: 426 });
  }
};



const closeAuthenticationFailure = (socket: HostWebSocket, cause: unknown) => {
  const securityError = cause instanceof PortalSecurityError ? cause : undefined;
  socket.close(
    1008,
    securityError ? `${securityError.code}; audit=${securityError.auditId}` : 'Portal authentication failed.',
  );
};

const activeCredentialMonitor = (
  portal: Portal,
  socket: HostWebSocket,
  principal: PortalPrincipal,
) => {
  const timer = setInterval(() => {
    void portal.security.assertActive(principal).catch(() =>
      socket.close(1008, 'Portal credential is no longer active.')
    );
  }, 5_000);
  return () => clearInterval(timer);
};

const pairingWebSocket = (request: Request, portal: Portal, upgrade: HostUpgrade) => {
  const denied = validateUpgrade(request, portal);
  if (denied) return denied;
  const upgraded = upgrade(request);
  let consumed = false;
  upgraded.socket.onmessage = async (event) => {
    if (consumed) {
      return upgraded.socket.close(
        1008,
        'Pairing request was already consumed.',
      );
    }
    consumed = true;
    try {
      const paired = await portal.security.redeemPairing(
        parsePortalPairRequest(JSON.parse(String(event.data))),
      );
      sendJson(upgraded.socket, paired);
      upgraded.socket.close(1000, 'Pairing completed.');
    } catch (cause) {
      closeAuthenticationFailure(upgraded.socket, cause);
    }
  };
  return upgraded.response;
};

const rpcWebSocket = (request: Request, portal: Portal, upgrade: HostUpgrade) => {
  const denied = validateUpgrade(request, portal);
  if (denied) return denied;
  const origin = request.headers.get('origin') ?? undefined;
  const upgraded = upgrade(request);
  const challenge = portal.security.challenge(PORTAL_RPC_PATH, origin);
  let principal: PortalPrincipal | undefined;
  let session: ReturnType<Portal['connectRpc']> | undefined;
  let stopMonitor: (() => void) | undefined;
  upgraded.socket.onopen = () => sendJson(upgraded.socket, challenge);
  upgraded.socket.onmessage = async (event) => {
    if (!principal) {
      try {
        principal = await portal.security.authenticate(
          challenge,
          parsePortalAuthResponse(JSON.parse(String(event.data))),
        );
        session = portal.connectRpc(
          principal,
          (notification) =>
            send(upgraded.socket, {
              jsonrpc: '2.0',
              method: WORKSPACE_FILE_WATCH_EVENT_METHOD,
              params: notification,
            }),
          (notification) =>
            sendTerminal(upgraded.socket, {
              jsonrpc: '2.0',
              method: TERMINAL_EVENT_METHOD,
              params: notification,
            }),
        );
        stopMonitor = activeCredentialMonitor(
          portal,
          upgraded.socket,
          principal,
        );
        sendJson(upgraded.socket, {
          type: PORTAL_AUTHENTICATED_TYPE,
          principal: principalSummary(principal),
        });
      } catch (cause) {
        closeAuthenticationFailure(upgraded.socket, cause);
      }
      return;
    }

    let message: JsonRpcMessage;
    try {
      await portal.security.assertActive(principal);
      message = parseJsonRpcMessage(String(event.data));
    } catch (cause) {
      if (cause instanceof PortalSecurityError) {
        return closeAuthenticationFailure(upgraded.socket, cause);
      }
      send(
        upgraded.socket,
        error(
          null,
          -32700,
          cause instanceof Error ? cause.message : 'Invalid JSON-RPC message.',
        ),
      );
      return;
    }
    if (message.id === undefined || !message.method) return;
    if (!PORTAL_RPC_METHODS.includes(message.method as PortalRpcMethod)) {
      send(
        upgraded.socket,
        error(message.id, -32601, `Unknown Portal method: ${message.method}`),
      );
      return;
    }
    try {
      const method = message.method as PortalRpcMethod;
      const params = parsePortalRpcParams(method, message.params ?? {});
      const value = await session!.request(method, params);
      send(upgraded.socket, result(message.id, value));
    } catch (cause) {
      const filesystemRequest = WORKSPACE_FILE_RPC_METHODS.includes(
        message.method as never,
      );
      send(
        upgraded.socket,
        cause instanceof WorkspaceFileError
          ? error(message.id, -32010, cause.message, cause.data)
          : cause instanceof PortalThreadLifecycleError
          ? error(message.id, -32011, cause.message, cause.data)
          : cause instanceof PortalTerminalError
          ? error(message.id, -32012, cause.message, cause.data)
          : cause instanceof PortalSecurityError
          ? error(message.id, -32003, cause.message, {
            code: cause.code,
            auditId: cause.auditId,
          })
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
  upgraded.socket.onclose = () => {
    stopMonitor?.();
    session?.close();
  };
  return upgraded.response;
};

const acpWebSocket = (request: Request, portal: Portal, upgrade: HostUpgrade) => {
  const denied = validateUpgrade(request, portal);
  if (denied) return denied;
  const url = new URL(request.url);
  const origin = request.headers.get('origin') ?? undefined;
  const threadId = url.searchParams.get('threadId')?.trim();
  if (!threadId) return new Response('threadId is required.', { status: 400 });

  const upgraded = upgrade(request);
  const challenge = portal.security.challenge(PORTAL_ACP_PATH, origin);
  let principal: PortalPrincipal | undefined;
  let attachment: Awaited<ReturnType<Portal['connectThread']>> | undefined;
  let stopMonitor: (() => void) | undefined;

  upgraded.socket.onopen = () => sendJson(upgraded.socket, challenge);
  upgraded.socket.onmessage = async (event) => {
    if (!principal) {
      try {
        principal = await portal.security.authenticate(
          challenge,
          parsePortalAuthResponse(JSON.parse(String(event.data))),
        );
        attachment = await portal.connectThread(
          principal,
          threadId,
          (message) => send(upgraded.socket, message),
          (reason) => upgraded.socket.close(1000, reason),
        );
        stopMonitor = activeCredentialMonitor(
          portal,
          upgraded.socket,
          principal,
        );
        sendJson(upgraded.socket, {
          type: PORTAL_AUTHENTICATED_TYPE,
          principal: principalSummary(principal),
        });
      } catch (cause) {
        closeAuthenticationFailure(upgraded.socket, cause);
      }
      return;
    }

    try {
      await portal.security.assertActive(principal);
      // Authentication is transport admission only. Admitted frames remain ordinary ACP JSON-RPC,
      // preserving the stable stdio/Zed adapter and the draft remote ACP seam.
      await attachment!.receive(parseJsonRpcMessage(String(event.data)));
    } catch (cause) {
      if (cause instanceof PortalSecurityError) {
        return closeAuthenticationFailure(upgraded.socket, cause);
      }
      send(
        upgraded.socket,
        error(
          null,
          -32700,
          cause instanceof Error ? cause.message : 'Invalid JSON-RPC message.',
        ),
      );
    }
  };
  upgraded.socket.onclose = () => {
    stopMonitor?.();
    attachment?.close();
  };
  return upgraded.response;
};

export const startPortalServer = (
  portal: Portal,
  onListen?: (address: { hostname: string; port: number }) => void,
) => {
  const tls = portal.config.tls
    ? {
      cert: readTextSync(portal.config.tls.certificateFile),
      key: readTextSync(portal.config.tls.privateKeyFile),
    }
    : undefined;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const sockets = new Set<HostWebSocket>();
  const server = Bun.serve<HostWebSocket>({
    hostname: portal.config.listen.hostname,
    port: portal.config.listen.port,
    tls,
    websocket: {
      idleTimeout: 0,
      maxPayloadLength: 16 * 1024 * 1024,
      open(socket) { sockets.add(socket.data); socket.data.open(socket); },
      message(socket, data) { socket.data.receive(data); },
      close(socket) { sockets.delete(socket.data); socket.data.closed(); },
    },
    fetch(request, server) {
      let socket: HostWebSocket | undefined;
      const upgrade: HostUpgrade = () => {
        socket = new HostWebSocket();
        return { socket, response: undefined };
      };
      const path = new URL(request.url).pathname;
      if (path === '/health') {
        return Response.json({
          status: 'ok',
          product: 'weave-portal',
          build: hostVersion,
          hostId: portal.security.hostId,
          displayName: portal.config.displayName,
        });
      }
      const response = path === PORTAL_PAIR_PATH ? pairingWebSocket(request, portal, upgrade)
        : path === PORTAL_RPC_PATH ? rpcWebSocket(request, portal, upgrade)
        : path === PORTAL_ACP_PATH ? acpWebSocket(request, portal, upgrade)
        : new Response('Not found.', { status: 404 });
      // Bun can call websocket.open synchronously inside upgrade. Install the
      // authentication/session handlers first so the initial challenge is never lost.
      if (socket && !server.upgrade(request, { data: socket, headers: { 'Sec-WebSocket-Protocol': PORTAL_WEBSOCKET_PROTOCOL } })) {
        return new Response('WebSocket upgrade failed.', { status: 400 });
      }
      return response;

    },
  });
  const addr = { hostname: server.hostname ?? portal.config.listen.hostname, port: server.port! };
  onListen?.(addr);
  return {
    addr, finished,
    async shutdown() {
      // Bun 1.3.14 leaks its pending-WebSocket count after a server-side close
      // (oven-sh/bun#36223). stop() closes the listener synchronously, but its
      // promise can never settle. Track our actual connections for draining.
      for (const socket of sockets) socket.close(1001, 'Host is shutting down.');
      void server.stop(true);
      const deadline = Date.now() + 250;
      while (sockets.size && Date.now() < deadline) await Bun.sleep(10);
      for (const socket of sockets) socket.terminate();
      server.unref();
      finish();
    },
  };
};
