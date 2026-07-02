import { getPortalConnection, sendPortalMessage } from './registry';

export type EditorWatchTokenRecord = {
  resourceId: string;
  portalId: string;
  projectId?: string;
  workspaceId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
  expiresAt: number;
};

type EditorWatchRelaySocket = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type EditorWatchRelayClient = {
  portalId: string;
  ws: EditorWatchRelaySocket;
  token: EditorWatchTokenRecord;
};

const editorWatchTokenTtlMs = 60_000;
const editorWatchTokens = new Map<string, EditorWatchTokenRecord>();
const editorWatchClients = new Map<string, EditorWatchRelayClient>();

const now = () => Date.now();

const cleanupExpiredTokens = () => {
  const at = now();
  for (const [token, record] of editorWatchTokens) {
    if (record.expiresAt <= at) editorWatchTokens.delete(token);
  }
};

export const issueEditorWatchToken = (record: Omit<EditorWatchTokenRecord, 'expiresAt'>) => {
  cleanupExpiredTokens();
  const token = `editor_watch_${crypto.randomUUID().replace(/-/g, '')}`;
  editorWatchTokens.set(token, { ...record, expiresAt: now() + editorWatchTokenTtlMs });
  return token;
};

const takeEditorWatchToken = (token: string) => {
  cleanupExpiredTokens();
  const record = editorWatchTokens.get(token);
  if (!record) return undefined;
  editorWatchTokens.delete(token);
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

const sanitizeEditorWatchClientMessage = (
  rawMessage: Record<string, unknown>,
  token: EditorWatchTokenRecord,
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

  throw new Error('Unsupported editor watch message.');
};

export const connectEditorWatchRelayClient = (input: {
  token: string;
  ws: EditorWatchRelaySocket;
}) => {
  const token = takeEditorWatchToken(input.token);
  if (!token) return undefined;
  if (!getPortalConnection(token.portalId)) return undefined;

  const clientId = `relay-editor-watch:${crypto.randomUUID()}`;
  editorWatchClients.set(clientId, {
    portalId: token.portalId,
    ws: input.ws,
    token,
  });
  return { clientId, token };
};

export const disconnectEditorWatchRelayClient = (clientId: string) => {
  const client = editorWatchClients.get(clientId);
  if (!client) return;

  try {
    sendPortalMessage(client.portalId, {
      type: 'editor.watch.client',
      clientId,
      message: { type: 'watch.stop' },
    });
  } catch {
    // Portal is already gone; dropping the relay client is enough.
  }

  editorWatchClients.delete(clientId);
};

export const forwardEditorWatchClientMessage = (
  clientId: string,
  rawMessage: Record<string, unknown>,
) => {
  const client = editorWatchClients.get(clientId);
  if (!client) throw new Error('Editor watch relay client is not connected.');
  const message = sanitizeEditorWatchClientMessage(rawMessage, client.token);
  sendPortalMessage(client.portalId, { type: 'editor.watch.client', clientId, message });
};

export const handleEditorWatchPortalMessage = (message: Record<string, unknown>) => {
  if (message.type !== 'editor.watch.event' || typeof message.clientId !== 'string') return false;
  const client = editorWatchClients.get(message.clientId);
  if (!client) return true;
  try {
    client.ws.send(JSON.stringify(message.event));
  } catch {
    disconnectEditorWatchRelayClient(message.clientId);
  }
  return true;
};

