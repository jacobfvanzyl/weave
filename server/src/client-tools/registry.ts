import {
  type ClientToolConnection as ProtocolClientToolConnection,
  parseRpcRequestResult,
  type RpcRequestParams,
  type RpcRequestResult,
} from '@weave/protocol';
import type { RpcPeer } from '@weave/protocol/peer';

export type ClientToolStatus = 'online' | 'offline';
export type ClientToolConnection = ProtocolClientToolConnection;

type ClientToolConnectionRecord = ClientToolConnection & { peer: RpcPeer };
const connections = new Map<string, ClientToolConnectionRecord>();
const publicConnection = ({ peer: _peer, ...connection }: ClientToolConnectionRecord): ClientToolConnection =>
  connection;

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
  surfaceId?: string;
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
    surfaceId: input.surfaceId,
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
      | 'name'
      | 'version'
      | 'capabilities'
      | 'surfaceId'
      | 'projectId'
      | 'workspaceId'
      | 'threadId'
      | 'active'
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
  tool: 'editor.context';
  args?: RpcRequestParams<'server', 'client', 'client.editorContext.get'>;
  timeoutMs?: number;
}): Promise<RpcRequestResult<'server', 'client', 'client.editorContext.get'>> => {
  const connection = connections.get(input.clientId);
  if (!connection) throw new Error('Client is offline');
  if (!connection.capabilities.includes('client.editorContext.get')) {
    throw new Error(`Client does not support tool: ${input.tool}`);
  }

  return parseRpcRequestResult(
    'server',
    'client',
    'client.editorContext.get',
    await connection.peer.request(
      'client.editorContext.get',
      input.args,
      { timeoutMs: input.timeoutMs ?? 5_000 },
    ),
  );
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
