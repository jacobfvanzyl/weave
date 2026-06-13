import { createServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { connectPortal, disconnectPortal, handlePortalMessage, updatePortal } from './registry';
import {
  connectTerminalRelayClient,
  disconnectTerminalRelayClient,
  forwardTerminalClientMessage,
  handleTerminalPortalMessage,
} from './terminal-relay';
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

let started = false;

type MastraLike = {
  getAgent: (agentId: string) => Promise<{ getMemory: () => Promise<any> | any }> | { getMemory: () => Promise<any> | any };
  getLogger?: () => { info?: (message: string, details?: unknown) => void; warn?: (message: string, details?: unknown) => void };
};

const parseRequestUrl = (request: IncomingMessage) => new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

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

const safeParse = (data: WebSocket.RawData) => {
  try {
    return JSON.parse(data.toString()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const stringArray = (value: unknown) => (Array.isArray(value) ? value.filter(item => typeof item === 'string') : []);

const closeUnauthorized = (ws: WebSocket, message: string) => {
  ws.send(JSON.stringify({ type: 'portal.rejected', error: message }));
  ws.close(4001, message);
};

export const startPortalWebSocketSidecar = (mastra: MastraLike) => {
  if (started || process.env.WEAVE_PORTAL_WS_DISABLED === 'true') return;
  started = true;

  const port = Number(process.env.WEAVE_PORTAL_WS_PORT ?? defaultPort);
  const server = createServer((_, response) => {
    response.writeHead(426, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'websocket upgrade required' }));
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = parseRequestUrl(request);
    if (url.pathname !== '/portals/connect' && url.pathname !== '/terminals/connect' && url.pathname !== '/windows/connect') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }

    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', async (ws, request) => {
    const url = parseRequestUrl(request);
    if (url.pathname === '/terminals/connect') {
      const connected = connectTerminalRelayClient({
        token: url.searchParams.get('token') ?? '',
        ws: ws as any,
      });

      if (!connected) {
        closeUnauthorized(ws, 'invalid terminal token');
        return;
      }

      ws.send(JSON.stringify({ type: 'terminal.accepted', clientId: connected.clientId }));
      ws.on('message', data => {
        const message = safeParse(data);
        if (!message) return;
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
      ws.on('close', () => disconnectTerminalRelayClient(connected.clientId));
      ws.on('error', () => disconnectTerminalRelayClient(connected.clientId));
      return;
    }

    if (url.pathname === '/windows/connect') {
      const connected = connectWindowRelayClient({
        token: url.searchParams.get('token') ?? '',
        ws: ws as any,
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
      ws.on('message', data => {
        const message = safeParse(data);
        if (!message) return;
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
      ws.on('close', () => disconnectWindowRelayClient(connected.clientId));
      ws.on('error', () => disconnectWindowRelayClient(connected.clientId));
      return;
    }

    const portalId = url.searchParams.get('portalId') ?? '';
    const token = url.searchParams.get('token') ?? '';
    const userId = await validatePortalToken(mastra, portalId, token).catch(() => undefined);

    if (!userId) {
      closeUnauthorized(ws, 'invalid portal token');
      return;
    }

    const connection = connectPortal({ portalId, userId, ws: ws as any });
    ws.send(JSON.stringify({ type: 'portal.accepted', portalId, connectedAt: connection.connectedAt }));

    ws.on('message', data => {
      const message = safeParse(data);
      if (!message) return;
      if (handleTerminalPortalMessage(message)) return;
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

    ws.on('close', () => disconnectPortal(portalId, ws as any));
    ws.on('error', () => disconnectPortal(portalId, ws as any));
  });

  server.on('error', error => {
    started = false;
    mastra.getLogger?.().warn?.('Portal WebSocket sidecar failed to start', {
      error: error instanceof Error ? error.message : String(error),
      port,
    });
  });

  server.listen(port, () => {
    mastra.getLogger?.().info?.('Portal WebSocket sidecar running', { url: `ws://localhost:${port}/portals/connect` });
  });
};
