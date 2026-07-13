import type { RpcPeer } from '../../../packages/protocol/src/peer.ts';
import { notifyClientRpcHosts } from '../client-tools/registry.ts';

export type PortalStatus = 'online' | 'offline';

export type PortalConnection = {
  portalId: string;
  userId: string;
  name?: string;
  version?: string;
  primary?: boolean;
  capabilities: string[];
  mounts: unknown[];
  roots: unknown[];
  status: PortalStatus;
  connectedAt: string;
  lastSeenAt: string;
};

type PortalConnectionRecord = PortalConnection & { peer: RpcPeer };

const connections = new Map<string, PortalConnectionRecord>();
type PortalRpcEventHandler = (params: unknown) => void | Promise<void>;
const rpcEventHandlers = new Map<string, Set<PortalRpcEventHandler>>();
const publicConnection = ({ peer: _peer, ...connection }: PortalConnectionRecord): PortalConnection => connection;
const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const emitRpcEvent = async (portalId: string, method: string, params: unknown) => {
  for (const handler of rpcEventHandlers.get(`${portalId}:${method}`) ?? []) await handler(params);
};

export const subscribePortalRpcEvent = (
  portalId: string,
  method: string,
  handler: PortalRpcEventHandler,
) => {
  const key = `${portalId}:${method}`;
  const handlers = rpcEventHandlers.get(key) ?? new Set<PortalRpcEventHandler>();
  handlers.add(handler);
  rpcEventHandlers.set(key, handlers);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) rpcEventHandlers.delete(key);
  };
};

export const requestPortalRpc = async <T = unknown>(
  portalId: string,
  method: string,
  params?: unknown,
  timeoutMs = 30_000,
) => {
  const connection = connections.get(portalId);
  if (!connection?.peer) throw new Error('Portal is offline or does not support JSON-RPC.');
  return await connection.peer.request<T>(method, params, { timeoutMs });
};

const normalizePath = (value: unknown) => {
  const path = optionalString(value);
  if (!path) return undefined;
  const normalized = path.replace(/\/+/g, '/').replace(/\/+$/, '');
  return normalized || '/';
};

const isSameOrChildPath = (path: string | undefined, root: string | undefined) =>
  Boolean(path && root && (path === root || path.startsWith(`${root}/`)));

const portalConnectionsForUser = (userId: string) =>
  [...connections.values()]
    .filter((connection) => connection.userId === userId)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

export const listPortalConnections = (userId?: string) =>
  (userId ? portalConnectionsForUser(userId) : [...connections.values()])
    .map(publicConnection)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

export const getPortalConnection = (portalId: string) => {
  const connection = connections.get(portalId);
  return connection ? publicConnection(connection) : undefined;
};

export const findPortalForProject = (userId: string, projectId: string) =>
  portalConnectionsForUser(userId).find((connection) =>
    connection.userId === userId &&
    connection.mounts.some((mount: any) => mount?.projectId === projectId && typeof mount?.localPath === 'string')
  );

export const resolvePortalForTarget = (input: {
  userId: string;
  portalId?: string;
  projectId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
}) => {
  const candidates = portalConnectionsForUser(input.userId);
  if (!candidates.length) return undefined;

  const workspacePath = normalizePath(input.workspacePath);
  const pathMatches = workspacePath
    ? candidates.filter((connection) => {
      const mounted = connection.mounts.some((mount) => {
        if (!isRecord(mount)) return false;
        const localPath = normalizePath(mount.localPath);
        if (!localPath) return false;
        return isSameOrChildPath(workspacePath, localPath) || isSameOrChildPath(localPath, workspacePath);
      });
      if (mounted) return true;

      return connection.roots.some((root) => {
        if (!isRecord(root)) return false;
        return isSameOrChildPath(workspacePath, normalizePath(root.path));
      });
    })
    : [];
  if (pathMatches.length) return publicConnection(pathMatches[0]);

  if (input.rootId) {
    const rootMatch = candidates.find((connection) =>
      connection.roots.some((root) => isRecord(root) && root.id === input.rootId)
    );
    if (rootMatch) return publicConnection(rootMatch);
  }

  if (input.projectId) {
    const projectMatch = candidates.find((connection) =>
      connection.mounts.some((mount) =>
        isRecord(mount) && mount.projectId === input.projectId && typeof mount.localPath === 'string'
      )
    );
    if (projectMatch) return publicConnection(projectMatch);
  }

  const hinted = input.portalId ? candidates.find((connection) => connection.portalId === input.portalId) : undefined;
  return publicConnection(hinted ?? candidates[0]);
};

export const requestPortalTool = async (input: {
  portalId: string;
  projectId?: string;
  workspaceId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
  executionProfile?: 'observe' | 'workspace' | 'host';
  tool: string;
  args: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
}) => {
  const connection = connections.get(input.portalId);
  if (!connection) throw new Error('Portal is offline');

  return await connection.peer.request('portal.tool.call', {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    rootId: input.rootId,
    repoPath: input.repoPath,
    workspacePath: input.workspacePath,
    executionProfile: input.executionProfile,
    idempotencyKey: input.idempotencyKey,
    tool: input.tool,
    args: input.args,
  }, { timeoutMs: input.timeoutMs ?? 30_000 });
};

export const connectPortalRpc = (input: {
  portalId: string;
  userId: string;
  peer: RpcPeer;
  name?: string;
  version?: string;
  capabilities?: string[];
  mounts?: unknown[];
  roots?: unknown[];
}) => {
  const at = new Date().toISOString();
  const existing = connections.get(input.portalId);
  if (existing?.peer !== input.peer) {
    existing?.peer?.close(4409, 'Replaced by newer Portal connection.');
  }
  const connection: PortalConnectionRecord = {
    portalId: input.portalId,
    userId: input.userId,
    name: input.name,
    version: input.version,
    capabilities: input.capabilities ?? [],
    mounts: input.mounts ?? [],
    roots: input.roots ?? [],
    status: 'online',
    connectedAt: at,
    lastSeenAt: at,
    peer: input.peer,
  };
  connections.set(input.portalId, connection);
  notifyClientRpcHosts(input.userId, 'portal.status.changed', publicConnection(connection));
  for (
    const method of [
      'portal.terminal.event',
      'portal.workspaceFile.watch.event',
      'portal.lsp.event',
      'portal.jupyter.event',
      'portal.status.changed',
    ]
  ) {
    input.peer.onNotification(method, (params) => emitRpcEvent(input.portalId, method, params));
  }
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

export const disconnectPortalRpc = (portalId: string, peer?: RpcPeer) => {
  const connection = connections.get(portalId);
  if (!connection || (peer && connection.peer !== peer)) return;
  connections.delete(portalId);
  notifyClientRpcHosts(connection.userId, 'portal.status.changed', {
    ...publicConnection(connection),
    status: 'offline',
    lastSeenAt: new Date().toISOString(),
  });
};
