import type { WSContext } from 'hono/helper/websocket';

export type PortalStatus = 'online' | 'offline';

export type PortalConnection = {
  portalId: string;
  userId: string;
  name?: string;
  version?: string;
  capabilities: string[];
  mounts: unknown[];
  roots: unknown[];
  status: PortalStatus;
  connectedAt: string;
  lastSeenAt: string;
};

type PortalSocket = WSContext<unknown>;

const connections = new Map<string, PortalConnection & { ws: PortalSocket }>();
const pendingRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();

const publicConnection = ({ ws: _ws, ...connection }: PortalConnection & { ws: PortalSocket }): PortalConnection => connection;

export const listPortalConnections = (userId?: string) =>
  [...connections.values()]
    .filter(connection => !userId || connection.userId === userId)
    .map(publicConnection)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

export const getPortalConnection = (portalId: string) => {
  const connection = connections.get(portalId);
  return connection ? publicConnection(connection) : undefined;
};

export const findPortalForPlane = (userId: string, planeId: string) =>
  [...connections.values()].find(connection =>
    connection.userId === userId && connection.mounts.some((mount: any) => mount?.planeId === planeId && typeof mount?.localPath === 'string'),
  );

export const handlePortalMessage = (message: Record<string, unknown>) => {
  if (message.type !== 'tool.result' || typeof message.id !== 'string') return false;
  const pending = pendingRequests.get(message.id);
  if (!pending) return false;
  clearTimeout(pending.timeout);
  pendingRequests.delete(message.id);
  pending.resolve(message);
  return true;
};

export const requestPortalTool = async (input: {
  portalId: string;
  planeId?: string;
  demiplaneId?: string;
  rootId?: string;
  repoPath?: string;
  tool: string;
  args: unknown;
  timeoutMs?: number;
}) => {
  const connection = connections.get(input.portalId);
  if (!connection) throw new Error('Portal is offline');

  const id = `req_${crypto.randomUUID()}`;
  const timeoutMs = input.timeoutMs ?? 30_000;
  const request = {
    id,
    type: 'tool.call',
    planeId: input.planeId,
    demiplaneId: input.demiplaneId,
    rootId: input.rootId,
    repoPath: input.repoPath,
    tool: input.tool,
    args: input.args,
  };

  const result = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Portal tool timed out: ${input.tool}`));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timeout });
  });

  connection.ws.send(JSON.stringify(request));
  return result;
};

export const connectPortal = (input: {
  portalId: string;
  userId: string;
  ws: PortalSocket;
  name?: string;
  version?: string;
  capabilities?: string[];
  mounts?: unknown[];
  roots?: unknown[];
}) => {
  const at = new Date().toISOString();
  const existing = connections.get(input.portalId);
  if (existing && existing.ws !== input.ws) existing.ws.close(4000, 'replaced by newer connection');

  const connection = {
    portalId: input.portalId,
    userId: input.userId,
    name: input.name,
    version: input.version,
    capabilities: input.capabilities ?? [],
    mounts: input.mounts ?? [],
    roots: input.roots ?? [],
    status: 'online' as const,
    connectedAt: at,
    lastSeenAt: at,
    ws: input.ws,
  };
  connections.set(input.portalId, connection);
  return publicConnection(connection);
};

export const updatePortal = (
  portalId: string,
  patch: Partial<Pick<PortalConnection, 'name' | 'version' | 'capabilities' | 'mounts' | 'roots'>> = {},
) => {
  const connection = connections.get(portalId);
  if (!connection) return undefined;
  const next = { ...connection, ...patch, lastSeenAt: new Date().toISOString() };
  connections.set(portalId, next);
  return publicConnection(next);
};

export const disconnectPortal = (portalId: string, ws?: PortalSocket) => {
  const connection = connections.get(portalId);
  if (!connection || (ws && connection.ws !== ws)) return;
  connections.delete(portalId);
};
