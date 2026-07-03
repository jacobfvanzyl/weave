import { connectPortal, disconnectPortal, handlePortalMessage, updatePortal } from './registry';
import {
  connectClientToolHost,
  consumeClientToolToken,
  disconnectClientToolHost,
  handleClientToolMessage,
  normalizeClientToolHello,
  updateClientToolHost,
} from '../client-tools/registry';
import {
  connectTerminalRelayClient,
  disconnectTerminalRelayClient,
  forwardTerminalClientMessage,
  handleTerminalPortalMessage,
} from './terminal-relay';
import {
  connectLspRelayClient,
  disconnectLspRelayClient,
  forwardLspClientMessage,
  handleLspPortalMessage,
} from './lsp-relay';
import {
  connectWorkspaceFileWatchRelayClient,
  disconnectWorkspaceFileWatchRelayClient,
  forwardWorkspaceFileWatchClientMessage,
  handleWorkspaceFileWatchPortalMessage,
} from './workspace-file-watch-relay';
import {
  connectWindowRelayClient,
  disconnectWindowRelayClient,
  forwardWindowClientMessage,
  handleWindowPortalMessage,
} from './window-relay';

const agentId = 'mageHandAgent';
const portalThreadPrefix = '__portal__';
const portalThreadId = (portalId: string) => `${portalThreadPrefix}${portalId}`;
const defaultPort = 4112;

type MastraLike = {
  getAgent: (agentId: string) => Promise<{ getMemory: () => Promise<any> | any }> | { getMemory: () => Promise<any> | any };
  getLogger?: () => { info?: (message: string, details?: unknown) => void; warn?: (message: string, details?: unknown) => void };
};

type RealtimeSocket = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  addEventListener: WebSocket['addEventListener'];
};

type PortalHttpServer = {
  shutdown: () => Promise<void> | void;
};

type PortalWebSocketRuntime = {
  serve: (options: { port: number; onListen: () => void }, handler: (request: Request) => Response | Promise<Response>) => PortalHttpServer;
  upgradeWebSocket: (request: Request) => { socket: WebSocket; response: Response };
};

let server: PortalHttpServer | undefined;

const denoRuntime = () => {
  const runtime = (globalThis as typeof globalThis & { Deno?: PortalWebSocketRuntime }).Deno;
  if (!runtime) throw new Error('Deno runtime is required for Portal realtime.');
  return runtime;
};

const validatePortalToken = async (mastra: MastraLike, portalId: string, token: string) => {
  if (!portalId || !token) return undefined;

  const agent = await mastra.getAgent(agentId);
  const memory = await agent?.getMemory();
  const thread = await memory?.getThreadById({ threadId: portalThreadId(portalId) }).catch(() => undefined);
  const metadata = thread?.metadata as Record<string, unknown> | undefined;
  if (metadata?.kind !== 'portal-token') return undefined;
  if (metadata?.portalId !== portalId) return undefined;
  if (metadata?.token !== token) return undefined;
  return typeof thread.resourceId === 'string' && thread.resourceId ? thread.resourceId : undefined;
};

const safeParse = (data: unknown) => {
  try {
    if (typeof data === 'string') return JSON.parse(data) as Record<string, unknown>;
    if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
    if (ArrayBuffer.isView(data)) return JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
};

const stringArray = (value: unknown) => (Array.isArray(value) ? value.filter(item => typeof item === 'string') : []);

const closeUnauthorized = (ws: RealtimeSocket, message: string) => {
  ws.send(JSON.stringify({ type: 'portal.rejected', error: message }));
  ws.close(4001, message);
};

const onMessage = (ws: RealtimeSocket, handler: (message: Record<string, unknown>) => void) => {
  ws.addEventListener('message', event => {
    const message = safeParse(event.data);
    if (message) handler(message);
  });
};

const connectTerminalClient = (ws: RealtimeSocket, url: URL) => {
  const connected = connectTerminalRelayClient({
    token: url.searchParams.get('token') ?? '',
    ws,
  });

  if (!connected) {
    closeUnauthorized(ws, 'invalid terminal token');
    return;
  }

  ws.send(JSON.stringify({ type: 'terminal.accepted', clientId: connected.clientId }));
  onMessage(ws, message => {
    try {
      forwardTerminalClientMessage(connected.clientId, message, connected.token);
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'error',
        terminalId: typeof message.terminalId === 'string' ? message.terminalId : 'unknown',
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });
  ws.addEventListener('close', () => disconnectTerminalRelayClient(connected.clientId));
  ws.addEventListener('error', () => disconnectTerminalRelayClient(connected.clientId));
};

const connectWindowClient = (ws: RealtimeSocket, url: URL) => {
  const connected = connectWindowRelayClient({
    token: url.searchParams.get('token') ?? '',
    ws,
  });

  if (!connected) {
    closeUnauthorized(ws, 'invalid window session token');
    return;
  }

  ws.send(JSON.stringify({
    type: 'window.accepted',
    clientId: connected.clientId,
    sessionId: connected.token.sessionId,
    portalId: connected.token.portalId,
  }));
  onMessage(ws, message => {
    try {
      forwardWindowClientMessage(connected.clientId, message);
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'error',
        sessionId: connected.token.sessionId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });
  ws.addEventListener('close', () => disconnectWindowRelayClient(connected.clientId));
  ws.addEventListener('error', () => disconnectWindowRelayClient(connected.clientId));
};

const connectLspClient = (ws: RealtimeSocket, url: URL) => {
  const connected = connectLspRelayClient({
    token: url.searchParams.get('token') ?? '',
    ws,
  });

  if (!connected) {
    closeUnauthorized(ws, 'invalid LSP session token');
    return;
  }

  ws.send(JSON.stringify({
    type: 'lsp.accepted',
    clientId: connected.clientId,
    sessionId: connected.token.sessionId,
    portalId: connected.token.portalId,
  }));
  onMessage(ws, message => {
    try {
      forwardLspClientMessage(connected.clientId, message);
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'lsp.event',
        clientId: connected.clientId,
        event: {
          type: 'error',
          sessionId: connected.token.sessionId,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  });
  ws.addEventListener('close', () => disconnectLspRelayClient(connected.clientId));
  ws.addEventListener('error', () => disconnectLspRelayClient(connected.clientId));
};

const connectWorkspaceFileWatchClient = (ws: RealtimeSocket, url: URL) => {
  const connected = connectWorkspaceFileWatchRelayClient({
    token: url.searchParams.get('token') ?? '',
    ws,
  });

  if (!connected) {
    closeUnauthorized(ws, 'invalid workspace file watch token');
    return;
  }

  ws.send(JSON.stringify({
    type: 'workspace-file.watch.accepted',
    clientId: connected.clientId,
    portalId: connected.token.portalId,
  }));
  onMessage(ws, message => {
    try {
      forwardWorkspaceFileWatchClientMessage(connected.clientId, message);
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'workspace-file.watch.error',
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });
  ws.addEventListener('close', () => disconnectWorkspaceFileWatchRelayClient(connected.clientId));
  ws.addEventListener('error', () => disconnectWorkspaceFileWatchRelayClient(connected.clientId));
};

const connectPortalDaemon = async (ws: RealtimeSocket, url: URL, mastra: MastraLike) => {
  const portalId = url.searchParams.get('portalId') ?? '';
  const token = url.searchParams.get('token') ?? '';
  const userId = await validatePortalToken(mastra, portalId, token).catch(() => undefined);

  if (!userId) {
    closeUnauthorized(ws, 'invalid portal token');
    return;
  }

  const connection = connectPortal({ portalId, userId, ws });
  ws.send(JSON.stringify({ type: 'portal.accepted', portalId, connectedAt: connection.connectedAt }));

  onMessage(ws, message => {
    if (handleTerminalPortalMessage(message)) return;
    if (handleLspPortalMessage(message)) return;
    if (handleWorkspaceFileWatchPortalMessage(message)) return;
    if (handleWindowPortalMessage(message)) return;
    if (handlePortalMessage(message)) return;

    if (message.type === 'portal.hello') {
      updatePortal(portalId, {
        name: typeof message.name === 'string' ? message.name : undefined,
        version: typeof message.version === 'string' ? message.version : undefined,
        capabilities: stringArray(message.capabilities),
        mounts: Array.isArray(message.mounts) ? message.mounts : [],
        roots: Array.isArray(message.roots) ? message.roots : [],
      });
      ws.send(JSON.stringify({ type: 'portal.hello.ack', portalId }));
      return;
    }

    if (message.type === 'portal.pong') updatePortal(portalId);
  });

  ws.addEventListener('close', () => disconnectPortal(portalId, ws));
  ws.addEventListener('error', () => disconnectPortal(portalId, ws));
};

const connectClientToolHostSocket = (ws: RealtimeSocket, url: URL) => {
  const clientId = url.searchParams.get('clientId') ?? '';
  const token = url.searchParams.get('token') ?? '';
  const record = consumeClientToolToken(token, clientId);

  if (!record || !clientId) {
    closeUnauthorized(ws, 'invalid client tool token');
    return;
  }

  const connection = connectClientToolHost({ clientId, userId: record.resourceId, ws });
  ws.send(JSON.stringify({ type: 'client.accepted', clientId, connectedAt: connection.connectedAt }));

  onMessage(ws, message => {
    if (handleClientToolMessage(message)) return;

    if (message.type === 'client.hello' || message.type === 'client.update') {
      updateClientToolHost(clientId, normalizeClientToolHello(message));
      ws.send(JSON.stringify({ type: `${message.type}.ack`, clientId }));
      return;
    }

    if (message.type === 'client.pong') updateClientToolHost(clientId);
  });

  ws.addEventListener('close', () => disconnectClientToolHost(clientId, ws));
  ws.addEventListener('error', () => disconnectClientToolHost(clientId, ws));
};

export const startPortalRealtimeServer = (mastra: MastraLike) => {
  if (server || process.env.WEAVE_PORTAL_WS_DISABLED === 'true') return server;

  const port = Number(process.env.WEAVE_PORTAL_WS_PORT ?? defaultPort);
  const runtime = denoRuntime();
  server = runtime.serve({ port, onListen: () => undefined }, (request: Request) => {
    const url = new URL(request.url);
    if (
      url.pathname !== '/portals/connect' &&
      url.pathname !== '/terminals/connect' &&
      url.pathname !== '/windows/connect' &&
      url.pathname !== '/lsp/connect' &&
      url.pathname !== '/workspace-files/watch/connect' &&
      url.pathname !== '/clients/connect'
    ) {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response(JSON.stringify({ error: 'websocket upgrade required' }), {
        status: 426,
        headers: { 'content-type': 'application/json' },
      });
    }

    const { socket, response } = runtime.upgradeWebSocket(request);
    const ws = socket as RealtimeSocket;
    socket.addEventListener('open', () => {
      if (url.pathname === '/terminals/connect') return connectTerminalClient(ws, url);
      if (url.pathname === '/windows/connect') return connectWindowClient(ws, url);
      if (url.pathname === '/lsp/connect') return connectLspClient(ws, url);
      if (url.pathname === '/workspace-files/watch/connect') return connectWorkspaceFileWatchClient(ws, url);
      if (url.pathname === '/clients/connect') return connectClientToolHostSocket(ws, url);
      void connectPortalDaemon(ws, url, mastra);
    });
    return response;
  });

  mastra.getLogger?.().info?.('Portal realtime server running', { url: `ws://localhost:${port}/portals/connect` });
  return server;
};

export const stopPortalRealtimeServer = async () => {
  await server?.shutdown();
  server = undefined;
};
