import { getPortalConnection, sendPortalMessage } from './registry';

export type WorkspaceFileWatchTokenRecord = {
  resourceId: string;
  portalId: string;
  projectId?: string;
  workspaceId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
  expiresAt: number;
};

type WorkspaceFileWatchRelaySocket = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type WorkspaceFileWatchRelayClient = {
  portalId: string;
  ws: WorkspaceFileWatchRelaySocket;
  token: WorkspaceFileWatchTokenRecord;
};

const workspaceFileWatchTokenTtlMs = 60_000;
const workspaceFileWatchTokens = new Map<string, WorkspaceFileWatchTokenRecord>();
const workspaceFileWatchClients = new Map<string, WorkspaceFileWatchRelayClient>();

const now = () => Date.now();

const cleanupExpiredTokens = () => {
  const at = now();
  for (const [token, record] of workspaceFileWatchTokens) {
    if (record.expiresAt <= at) workspaceFileWatchTokens.delete(token);
  }
};

export const issueWorkspaceFileWatchToken = (record: Omit<WorkspaceFileWatchTokenRecord, 'expiresAt'>) => {
  cleanupExpiredTokens();
  const token = `workspace_file_watch_${crypto.randomUUID().replace(/-/g, '')}`;
  workspaceFileWatchTokens.set(token, { ...record, expiresAt: now() + workspaceFileWatchTokenTtlMs });
  return token;
};

const takeWorkspaceFileWatchToken = (token: string) => {
  cleanupExpiredTokens();
  const record = workspaceFileWatchTokens.get(token);
  if (!record) return undefined;
  workspaceFileWatchTokens.delete(token);
  if (record.expiresAt <= now()) return undefined;
  return record;
};

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const parseRelativePath = (value: unknown, name = 'path') => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  if (value.includes('\0')) throw new Error(`${name} cannot contain null bytes.`);

  const normalizedInput = value.trim().replace(/\\/g, '/');
  if (!normalizedInput || normalizedInput === '.') return '';
  if (normalizedInput.startsWith('/') || /^[a-zA-Z]:\//.test(normalizedInput)) {
    throw new Error(`${name} must be relative to the workspace root.`);
  }

  const parts: string[] = [];
  for (const part of normalizedInput.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0) parts.pop();
      else throw new Error(`${name} cannot escape the workspace root.`);
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
};

const parseWatchPaths = (value: unknown) => {
  const input = Array.isArray(value) ? value : [''];
  const paths = input.map((item, index) => parseRelativePath(item, `paths[${index}]`));
  return [...new Set(paths.length ? paths : [''])];
};

const requestIdValue = (value: unknown) => optionalString(value);

const sanitizeWorkspaceFileWatchClientMessage = (
  rawMessage: Record<string, unknown>,
  token: WorkspaceFileWatchTokenRecord,
) => {
  if (rawMessage.type === 'watch.start') {
    return {
      type: 'watch.start' as const,
      requestId: requestIdValue(rawMessage.requestId),
      target: {
        projectId: token.projectId,
        workspaceId: token.workspaceId,
        portalId: token.portalId,
        rootId: token.rootId,
        repoPath: token.repoPath,
        workspacePath: token.workspacePath,
      },
      paths: parseWatchPaths(rawMessage.paths),
    };
  }

  if (rawMessage.type === 'watch.update') {
    return {
      type: 'watch.update' as const,
      requestId: requestIdValue(rawMessage.requestId),
      paths: parseWatchPaths(rawMessage.paths),
    };
  }

  if (rawMessage.type === 'watch.stop') {
    return {
      type: 'watch.stop' as const,
      requestId: requestIdValue(rawMessage.requestId),
    };
  }

  throw new Error('Unsupported workspace file watch message.');
};

export const connectWorkspaceFileWatchRelayClient = (input: {
  token: string;
  ws: WorkspaceFileWatchRelaySocket;
}) => {
  const token = takeWorkspaceFileWatchToken(input.token);
  if (!token) return undefined;
  if (!getPortalConnection(token.portalId)) return undefined;

  const clientId = `relay-workspace-file-watch:${crypto.randomUUID()}`;
  workspaceFileWatchClients.set(clientId, {
    portalId: token.portalId,
    ws: input.ws,
    token,
  });
  return { clientId, token };
};

export const disconnectWorkspaceFileWatchRelayClient = (clientId: string) => {
  const client = workspaceFileWatchClients.get(clientId);
  if (!client) return;

  try {
    sendPortalMessage(client.portalId, {
      type: 'workspace-file.watch.client',
      clientId,
      message: { type: 'watch.stop' },
    });
  } catch {
    // Portal is already gone; dropping the relay client is enough.
  }

  workspaceFileWatchClients.delete(clientId);
};

export const forwardWorkspaceFileWatchClientMessage = (
  clientId: string,
  rawMessage: Record<string, unknown>,
) => {
  const client = workspaceFileWatchClients.get(clientId);
  if (!client) throw new Error('Workspace file watch relay client is not connected.');
  const message = sanitizeWorkspaceFileWatchClientMessage(rawMessage, client.token);
  sendPortalMessage(client.portalId, { type: 'workspace-file.watch.client', clientId, message });
};

export const handleWorkspaceFileWatchPortalMessage = (message: Record<string, unknown>) => {
  if (message.type !== 'workspace-file.watch.event' || typeof message.clientId !== 'string') return false;
  const client = workspaceFileWatchClients.get(message.clientId);
  if (!client) return true;
  try {
    client.ws.send(JSON.stringify(message.event));
  } catch {
    disconnectWorkspaceFileWatchRelayClient(message.clientId);
  }
  return true;
};
