import type { RpcPeer } from '@weave/protocol/peer';

export type ClientToolStatus = 'online' | 'offline';

export type ClientToolConnection = {
  clientId: string;
  userId: string;
  name?: string;
  version?: string;
  capabilities: string[];
  projectId?: string;
  workspaceId?: string;
  threadId?: string;
  active?: boolean;
  status: ClientToolStatus;
  connectedAt: string;
  lastSeenAt: string;
};

type ClientToolConnectionRecord = ClientToolConnection & { peer: RpcPeer };
const connections = new Map<string, ClientToolConnectionRecord>();
const publicConnection = ({ peer: _peer, ...connection }: ClientToolConnectionRecord): ClientToolConnection =>
  connection;
const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const stringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) =>
      item.trim()
    )
    : [];

export const listClientToolConnections = (userId?: string) =>
  [...connections.values()]
    .filter((connection) => !userId || connection.userId === userId)
    .map(publicConnection)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

export const connectClientToolRpcHost = (input: {
  clientId: string;
  userId: string;
  peer: RpcPeer;
  name?: string;
  version?: string;
  capabilities?: string[];
  projectId?: string;
  workspaceId?: string;
  threadId?: string;
  active?: boolean;
}) => {
  const at = new Date().toISOString();
  const existing = connections.get(input.clientId);
  if (existing?.peer !== input.peer) {
    existing?.peer?.close(4409, 'Replaced by newer client connection.');
  }
  const connection: ClientToolConnectionRecord = {
    clientId: input.clientId,
    userId: input.userId,
    name: input.name,
    version: input.version,
    capabilities: input.capabilities ?? [],
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    active: input.active,
    status: 'online',
    connectedAt: at,
    lastSeenAt: at,
    peer: input.peer,
  };
  connections.set(input.clientId, connection);
  return publicConnection(connection);
};

export const updateClientToolHost = (
  clientId: string,
  patch: Partial<
    Pick<
      ClientToolConnection,
      'name' | 'version' | 'capabilities' | 'projectId' | 'workspaceId' | 'threadId' | 'active'
    >
  > = {},
) => {
  const connection = connections.get(clientId);
  if (!connection) return undefined;
  const next: ClientToolConnectionRecord = {
    ...connection,
    ...patch,
    capabilities: patch.capabilities ?? connection.capabilities,
    lastSeenAt: new Date().toISOString(),
  };
  connections.set(clientId, next);
  return publicConnection(next);
};

export const disconnectClientToolRpcHost = (clientId: string, peer?: RpcPeer) => {
  const connection = connections.get(clientId);
  if (!connection || (peer && connection.peer !== peer)) return;
  connections.delete(clientId);
};

export const notifyClientRpcHosts = (
  userId: string,
  method: string,
  params: unknown,
  priority = 0,
) => {
  let notified = 0;
  for (const connection of connections.values()) {
    if (connection.userId !== userId) continue;
    connection.peer.notify(method, params, priority);
    notified += 1;
  }
  return notified;
};

export const requestClientTool = async (input: {
  clientId: string;
  tool: string;
  args?: unknown;
  timeoutMs?: number;
}) => {
  const connection = connections.get(input.clientId);
  if (!connection) throw new Error('Client is offline');
  if (!connection.capabilities.includes(input.tool)) throw new Error(`Client does not support tool: ${input.tool}`);

  const method = input.tool === 'editor.context' ? 'client.editorContext.get' : input.tool;
  return await connection.peer.request(method, input.args ?? {}, { timeoutMs: input.timeoutMs ?? 5_000 });
};

export const resolveClientToolHostForTarget = (input: {
  userId: string;
  projectId?: string;
  workspaceId?: string;
  threadId?: string;
  capability?: string;
}) => {
  const candidates = [...connections.values()]
    .filter((connection) => connection.userId === input.userId)
    .filter((connection) => !input.capability || connection.capabilities.includes(input.capability))
    .filter((connection) => !input.projectId || connection.projectId === input.projectId)
    .filter((connection) => !input.workspaceId || connection.workspaceId === input.workspaceId);

  if (!candidates.length) return undefined;

  return publicConnection(
    candidates.sort((a, b) => {
      const aThread = input.threadId && a.threadId === input.threadId ? 1 : 0;
      const bThread = input.threadId && b.threadId === input.threadId ? 1 : 0;
      if (aThread !== bThread) return bThread - aThread;
      const aActive = a.active ? 1 : 0;
      const bActive = b.active ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return b.lastSeenAt.localeCompare(a.lastSeenAt);
    })[0],
  );
};

export const normalizeClientToolHello = (message: Record<string, unknown>) => ({
  name: optionalString(message.name),
  version: optionalString(message.version),
  capabilities: stringArray(message.capabilities),
  projectId: optionalString(message.projectId),
  workspaceId: optionalString(message.workspaceId),
  threadId: optionalString(message.threadId),
  active: message.active === true,
});
