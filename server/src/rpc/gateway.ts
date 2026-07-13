import { upgradeWebSocket } from 'hono/deno';
import type { Context, Handler } from 'hono';
import {
  rpcCloseCode,
  rpcErrorCode,
  rpcInitializeParamsSchema,
  WEAVE_RPC_MAX_FRAME_BYTES,
  WEAVE_RPC_PROTOCOL_VERSION,
} from '../../../packages/protocol/src/schema.ts';
import { RpcApplicationError, RpcPeer } from '../../../packages/protocol/src/peer.ts';
import type { OwnerAuthConfig } from '../owner/auth.ts';
import { createOwnerRequestContext } from '../owner/context.ts';
import { portalRepository } from '../portal/store.ts';
import { connectPortalRpc, disconnectPortalRpc, getPortalConnection } from '../portal/registry.ts';
import {
  connectClientToolRpcHost,
  disconnectClientToolRpcHost,
  listClientToolConnections,
} from '../client-tools/registry.ts';
import { isAllowedCorsOrigin } from '../server/cors-origin.ts';
import type { ServerVariables } from '../server/types.ts';
import type { RpcRouter, RpcSession } from './router.ts';
import { rpcRuntimeMetrics } from './metrics.ts';

const initializeTimeoutMs = 5_000;
const heartbeatIntervalMs = 20_000;
const staleConnectionMs = 60_000;

type GatewayStats = {
  connections: number;
  clients: number;
  portals: number;
  accepted: number;
  reconnects: number;
  authenticationFailures: number;
  parseOrProtocolErrors: number;
  overloadCloses: number;
};

const stats: GatewayStats = {
  connections: 0,
  clients: 0,
  portals: 0,
  accepted: 0,
  reconnects: 0,
  authenticationFailures: 0,
  parseOrProtocolErrors: 0,
  overloadCloses: 0,
};

const stringValue = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const activePeers = new Set<RpcPeer>();

export const isRpcInitializeRequest = (data: unknown) => {
  let text: string;
  if (typeof data === 'string') text = data;
  else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
  else if (ArrayBuffer.isView(data)) text = new TextDecoder().decode(data);
  else return false;
  try {
    const raw = JSON.parse(text);
    return Boolean(
      raw && typeof raw === 'object' && !Array.isArray(raw) &&
        raw.jsonrpc === '2.0' &&
        (typeof raw.id === 'string' || typeof raw.id === 'number') &&
        raw.method === 'initialize',
    );
  } catch {
    return false;
  }
};

export const rpcGatewayStats = () => {
  let queueDepth = 0;
  let queuedBytes = 0;
  let bufferedBytes = 0;
  for (const peer of activePeers) {
    queueDepth += peer.stats.queuedMessageCount;
    queuedBytes += peer.stats.queuedBytes;
    bufferedBytes += peer.stats.bufferedAmount;
  }
  return {
    ...stats,
    queueDepth,
    queuedBytes,
    bufferedBytes,
    ...rpcRuntimeMetrics(),
  };
};

export const createRpcUpgradeHandler = (input: {
  auth: OwnerAuthConfig;
  router: RpcRouter;
  configuredOrigins: ReadonlySet<string>;
}) => {
  const handler = upgradeWebSocket(
    (c: Context<{ Variables: ServerVariables }>) => {
      let peer: RpcPeer | undefined;
      let session: RpcSession | undefined;
      let detachRouter: (() => void) | undefined;
      let initializeTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let lastPongAt = Date.now();
      let initializedPortalName: string | undefined;
      let initializeStarted = false;
      const lifetimeController = new AbortController();

      const cleanup = () => {
        if (initializeTimer) clearTimeout(initializeTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        initializeTimer = undefined;
        heartbeatTimer = undefined;
        detachRouter?.();
        detachRouter = undefined;
        if (session?.role === 'portal') {
          stats.portals = Math.max(0, stats.portals - 1);
          disconnectPortalRpc(session.portalId, session.peer);
        } else if (session?.role === 'client') {
          stats.clients = Math.max(0, stats.clients - 1);
          disconnectClientToolRpcHost(session.clientId, session.peer);
        }
        if (session) stats.connections = Math.max(0, stats.connections - 1);
        if (peer) activePeers.delete(peer);
        lifetimeController.abort(new Error('RPC connection closed.'));
        session = undefined;
      };

      return {
        onOpen(_event, ws) {
          peer = new RpcPeer(ws.raw as WebSocket, {
            maxFrameBytes: WEAVE_RPC_MAX_FRAME_BYTES,
            onError: (error) => console.warn('[rpc] peer error', error.message),
            onClose: (info) => {
              if (info?.code === 4429) stats.overloadCloses += 1;
              cleanup();
            },
          });

          initializeTimer = setTimeout(() => {
            peer?.close(
              rpcCloseCode.handshakeTimeout,
              'RPC initialize timed out.',
            );
          }, initializeTimeoutMs);

          peer.register('initialize', async (params) => {
            if (session) {
              throw new RpcApplicationError(
                rpcErrorCode.conflict,
                'RPC connection is already initialized.',
                {
                  code: 'CONFLICT',
                },
              );
            }
            const raw = params && typeof params === 'object' && !Array.isArray(params)
              ? params as Record<string, unknown>
              : undefined;
            if (
              raw && raw.protocolVersion !== undefined &&
              raw.protocolVersion !== WEAVE_RPC_PROTOCOL_VERSION
            ) {
              queueMicrotask(() =>
                peer?.close(
                  rpcCloseCode.incompatibleProtocol,
                  'Incompatible RPC protocol version.',
                )
              );
              throw new RpcApplicationError(
                rpcErrorCode.conflict,
                'Incompatible RPC protocol version.',
                {
                  code: 'CONFLICT',
                  supportedProtocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
                },
              );
            }
            const parsed = rpcInitializeParamsSchema.safeParse(params);
            if (!parsed.success) {
              stats.authenticationFailures += 1;
              queueMicrotask(() =>
                peer?.close(
                  rpcCloseCode.invalidMessage,
                  'Invalid RPC initialization.',
                )
              );
              throw new RpcApplicationError(
                rpcErrorCode.invalidParams,
                'Invalid initialize parameters.',
                {
                  code: 'INVALID_PARAMS',
                  issues: parsed.error.issues,
                },
              );
            }
            const connectionId = `rpc_${crypto.randomUUID()}`;
            if (parsed.data.role === 'client') {
              if (parsed.data.token !== input.auth.token) {
                stats.authenticationFailures += 1;
                queueMicrotask(() =>
                  peer?.close(
                    rpcCloseCode.unauthenticated,
                    'Authentication failed.',
                  )
                );
                throw new RpcApplicationError(
                  rpcErrorCode.unauthenticated,
                  'Authentication failed.',
                  {
                    code: 'UNAUTHENTICATED',
                  },
                );
              }
              const ownerContext = createOwnerRequestContext(input.auth.owner);
              const clientId = parsed.data.client.clientInstanceId;
              if (
                listClientToolConnections(ownerContext.owner.id).some(
                  (connection) => connection.clientId === clientId,
                )
              ) {
                stats.reconnects += 1;
              }
              const clientSession: RpcSession = {
                role: 'client',
                connectionId,
                peer: peer!,
                ownerContext,
                clientId,
                capabilities: parsed.data.capabilities,
                lifetimeSignal: lifetimeController.signal,
              };
              session = clientSession;
              connectClientToolRpcHost({
                clientId,
                userId: ownerContext.owner.id,
                peer: peer!,
                name: parsed.data.client.name,
                version: parsed.data.client.version,
                capabilities: parsed.data.capabilities,
                projectId: parsed.data.client.projectId,
                workspaceId: parsed.data.client.workspaceId,
                threadId: parsed.data.client.threadId,
                active: parsed.data.client.active,
              });
              stats.clients += 1;
            } else {
              const token = await portalRepository.findToken(
                parsed.data.portal.portalId,
                parsed.data.token,
              );
              if (!token) {
                stats.authenticationFailures += 1;
                queueMicrotask(() =>
                  peer?.close(
                    rpcCloseCode.unauthenticated,
                    'Portal authentication failed.',
                  )
                );
                throw new RpcApplicationError(
                  rpcErrorCode.unauthenticated,
                  'Portal authentication failed.',
                  {
                    code: 'UNAUTHENTICATED',
                  },
                );
              }
              const owner = token.ownerId === input.auth.owner.id ? input.auth.owner : {
                id: token.ownerId,
                name: token.ownerId,
                role: 'owner' as const,
              };
              const ownerContext = createOwnerRequestContext(owner);
              if (getPortalConnection(parsed.data.portal.portalId)) {
                stats.reconnects += 1;
              }
              const portalSession: RpcSession = {
                role: 'portal',
                connectionId,
                peer: peer!,
                ownerContext,
                portalId: parsed.data.portal.portalId,
                capabilities: parsed.data.capabilities,
                lifetimeSignal: lifetimeController.signal,
              };
              session = portalSession;
              initializedPortalName = parsed.data.portal.name;
              connectPortalRpc({
                portalId: parsed.data.portal.portalId,
                userId: token.ownerId,
                peer: peer!,
                name: parsed.data.portal.name,
                version: parsed.data.portal.version,
                capabilities: parsed.data.capabilities,
                mounts: parsed.data.portal.mounts,
                roots: parsed.data.portal.roots,
              });
              stats.portals += 1;
            }
            if (initializeTimer) clearTimeout(initializeTimer);
            initializeTimer = undefined;
            const initializedSession = session;
            if (!initializedSession) {
              throw new RpcApplicationError(
                rpcErrorCode.applicationInternal,
                'RPC session initialization failed.',
                {
                  code: 'INTERNAL',
                },
              );
            }
            detachRouter = input.router.attach(initializedSession);
            stats.connections += 1;
            stats.accepted += 1;
            activePeers.add(peer!);
            lastPongAt = Date.now();
            peer!.onNotification('connection.pong', () => {
              lastPongAt = Date.now();
            });
            peer!.onNotification('connection.ping', (raw) => {
              const nonce = raw && typeof raw === 'object'
                ? stringValue((raw as { nonce?: unknown }).nonce)
                : undefined;
              peer!.notify('connection.pong', {
                ...(nonce ? { nonce } : {}),
                at: new Date().toISOString(),
              }, 0);
            });
            heartbeatTimer = setInterval(() => {
              if (Date.now() - lastPongAt > staleConnectionMs) {
                peer?.close(4408, 'RPC heartbeat timed out.');
                return;
              }
              peer?.notify('connection.ping', {
                nonce: crypto.randomUUID(),
                at: new Date().toISOString(),
              }, 0);
            }, heartbeatIntervalMs);

            return {
              protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
              connectionId,
              role: initializedSession.role,
              heartbeatIntervalMs,
              maxFrameBytes: WEAVE_RPC_MAX_FRAME_BYTES,
              capabilities: input.router.listMethods(initializedSession.role),
              ...(initializedSession.role === 'client'
                ? {
                  owner: {
                    id: initializedSession.ownerContext.owner.id,
                    name: initializedSession.ownerContext.owner.name,
                  },
                }
                : {
                  portal: {
                    portalId: initializedSession.portalId,
                    name: initializedPortalName ?? initializedSession.portalId,
                  },
                }),
            };
          });
        },
        onMessage(event) {
          if (!session) {
            if (initializeStarted || !isRpcInitializeRequest(event.data)) {
              stats.parseOrProtocolErrors += 1;
              peer?.close(
                rpcCloseCode.invalidMessage,
                'initialize must be the first and only handshake request.',
              );
              return;
            }
            initializeStarted = true;
          }
          void peer?.receive(event.data).catch((error) => {
            stats.parseOrProtocolErrors += 1;
            console.warn('[rpc] message failed', error);
          });
        },
        onClose() {
          peer?.socketClosed('RPC socket closed.');
          cleanup();
        },
        onError() {
          peer?.socketClosed('RPC socket failed.');
          cleanup();
        },
      };
    },
  );

  return ((c: Context<{ Variables: ServerVariables }>, next) => {
    const origin = c.req.header('Origin');
    if (origin && !isAllowedCorsOrigin(origin, input.configuredOrigins)) {
      return c.json({ error: 'Origin is not allowed.' }, 403);
    }
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: 'WebSocket upgrade required.' }, 426);
    }
    return handler(c, next);
  }) as Handler<{ Variables: ServerVariables }>;
};
