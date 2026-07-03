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

type ClientToolSocket = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type ClientToolConnectionRecord = ClientToolConnection & {
  ws: ClientToolSocket;
};

type ClientToolTokenRecord = {
  clientId?: string;
  expiresAt: number;
  resourceId: string;
};

const clientToolTokenTtlMs = 60_000;
const connections = new Map<string, ClientToolConnectionRecord>();
const tokens = new Map<string, ClientToolTokenRecord>();
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

const now = () => Date.now();
const publicConnection = ({ ws: _ws, ...connection }: ClientToolConnectionRecord): ClientToolConnection => connection;
const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const stringArray = (value: unknown) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
  : [];

const pruneExpiredTokens = (at = now()) => {
  for (const [token, record] of tokens) {
    if (record.expiresAt <= at) tokens.delete(token);
  }
};

export const issueClientToolToken = (record: { resourceId: string; clientId?: string }) => {
  pruneExpiredTokens();
  const token = crypto.randomUUID();
  tokens.set(token, {
    clientId: optionalString(record.clientId),
    expiresAt: now() + clientToolTokenTtlMs,
    resourceId: record.resourceId,
  });
  return token;
};

export const consumeClientToolToken = (token: string, clientId?: string) => {
  pruneExpiredTokens();
  const record = tokens.get(token);
  if (!record) return undefined;
  tokens.delete(token);
  if (record.clientId && clientId && record.clientId !== clientId) return undefined;
  if (record.clientId && !clientId) return undefined;
  return record;
};

export const listClientToolConnections = (userId?: string) =>
  [...connections.values()]
    .filter(connection => !userId || connection.userId === userId)
    .map(publicConnection)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

export const connectClientToolHost = (input: {
  clientId: string;
  userId: string;
  ws: ClientToolSocket;
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
  if (existing && existing.ws !== input.ws) existing.ws.close(4000, 'replaced by newer connection');

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
    ws: input.ws,
  };
  connections.set(input.clientId, connection);
  return publicConnection(connection);
};

export const updateClientToolHost = (
  clientId: string,
  patch: Partial<Pick<
    ClientToolConnection,
    'name' | 'version' | 'capabilities' | 'projectId' | 'workspaceId' | 'threadId' | 'active'
  >> = {},
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

export const disconnectClientToolHost = (clientId: string, ws?: ClientToolSocket) => {
  const connection = connections.get(clientId);
  if (!connection || (ws && connection.ws !== ws)) return;
  connections.delete(clientId);
};

export const handleClientToolMessage = (message: Record<string, unknown>) => {
  if (message.type !== 'tool.result' || typeof message.id !== 'string') return false;
  const pending = pendingRequests.get(message.id);
  if (!pending) return false;
  clearTimeout(pending.timeout);
  pendingRequests.delete(message.id);
  pending.resolve(message);
  return true;
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

  const id = `client_req_${crypto.randomUUID()}`;
  const timeoutMs = input.timeoutMs ?? 5_000;
  const result = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Client tool timed out: ${input.tool}`));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timeout });
  });

  connection.ws.send(JSON.stringify({
    id,
    type: 'tool.call',
    tool: input.tool,
    args: input.args ?? {},
  }));
  return result;
};

export const resolveClientToolHostForTarget = (input: {
  userId: string;
  projectId?: string;
  workspaceId?: string;
  threadId?: string;
  capability?: string;
}) => {
  const candidates = [...connections.values()]
    .filter(connection => connection.userId === input.userId)
    .filter(connection => !input.capability || connection.capabilities.includes(input.capability))
    .filter(connection => !input.projectId || connection.projectId === input.projectId)
    .filter(connection => !input.workspaceId || connection.workspaceId === input.workspaceId);

  if (!candidates.length) return undefined;

  return publicConnection(candidates.sort((a, b) => {
    const aThread = input.threadId && a.threadId === input.threadId ? 1 : 0;
    const bThread = input.threadId && b.threadId === input.threadId ? 1 : 0;
    if (aThread !== bThread) return bThread - aThread;
    const aActive = a.active ? 1 : 0;
    const bActive = b.active ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return b.lastSeenAt.localeCompare(a.lastSeenAt);
  })[0]);
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

export const __clientToolRegistryTest = {
  connections,
  tokens,
  pendingRequests,
  pruneExpiredTokens,
};
