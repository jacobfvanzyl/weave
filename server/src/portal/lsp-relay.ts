import { getPortalConnection, sendPortalMessage } from './registry';

export type LspSessionTokenRecord = {
  resourceId: string;
  portalId: string;
  sessionId: string;
  projectId?: string;
  workspaceId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
  path: string;
  languageId?: string;
  serverId?: string;
  expiresAt: number;
};

type LspRelaySocket = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type LspRelayClient = {
  portalId: string;
  sessionId: string;
  ws: LspRelaySocket;
  token: LspSessionTokenRecord;
};

const lspSessionTokenTtlMs = 60_000;
const lspSessionTokens = new Map<string, LspSessionTokenRecord>();
const lspClients = new Map<string, LspRelayClient>();

const now = () => Date.now();

const cleanupExpiredTokens = () => {
  const at = now();
  for (const [token, record] of lspSessionTokens) {
    if (record.expiresAt <= at) lspSessionTokens.delete(token);
  }
};

export const issueLspSessionToken = (record: Omit<LspSessionTokenRecord, 'expiresAt'>) => {
  cleanupExpiredTokens();
  const token = `lsp_${crypto.randomUUID().replace(/-/g, '')}`;
  lspSessionTokens.set(token, { ...record, expiresAt: now() + lspSessionTokenTtlMs });
  return token;
};

const takeLspSessionToken = (token: string) => {
  cleanupExpiredTokens();
  const record = lspSessionTokens.get(token);
  if (!record) return undefined;
  lspSessionTokens.delete(token);
  if (record.expiresAt <= now()) return undefined;
  return record;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const sanitizeLspClientMessage = (
  rawMessage: Record<string, unknown>,
  token: LspSessionTokenRecord,
) => {
  if (rawMessage.type === 'start') {
    return {
      type: 'start',
      sessionId: token.sessionId,
      target: {
        projectId: token.projectId,
        workspaceId: token.workspaceId,
        portalId: token.portalId,
        rootId: token.rootId,
        repoPath: token.repoPath,
        workspacePath: token.workspacePath,
      },
      path: token.path,
      languageId: token.languageId,
      serverId: token.serverId,
    };
  }

  if (rawMessage.type === 'jsonrpc') {
    const message = optionalString(rawMessage.message);
    if (!message) throw new Error('LSP JSON-RPC message is required.');
    return { type: 'jsonrpc', sessionId: token.sessionId, message };
  }

  if (rawMessage.type === 'detach') return { type: 'detach', sessionId: token.sessionId };
  throw new Error('Unsupported LSP message.');
};

export const connectLspRelayClient = (input: {
  token: string;
  ws: LspRelaySocket;
}) => {
  const token = takeLspSessionToken(input.token);
  if (!token) return undefined;
  if (!getPortalConnection(token.portalId)) return undefined;

  const clientId = `relay-lsp:${crypto.randomUUID()}`;
  lspClients.set(clientId, {
    portalId: token.portalId,
    sessionId: token.sessionId,
    ws: input.ws,
    token,
  });
  return { clientId, token };
};

export const disconnectLspRelayClient = (clientId: string) => {
  const client = lspClients.get(clientId);
  if (!client) return;

  try {
    sendPortalMessage(client.portalId, {
      type: 'lsp.client',
      clientId,
      message: { type: 'detach', sessionId: client.sessionId },
    });
  } catch {
    // Portal is already gone; dropping the relay client is enough.
  }

  lspClients.delete(clientId);
};

export const forwardLspClientMessage = (
  clientId: string,
  rawMessage: Record<string, unknown>,
) => {
  const client = lspClients.get(clientId);
  if (!client) throw new Error('LSP relay client is not connected.');
  const message = sanitizeLspClientMessage(rawMessage, client.token);
  sendPortalMessage(client.portalId, { type: 'lsp.client', clientId, message });
};

export const handleLspPortalMessage = (message: Record<string, unknown>) => {
  if (message.type !== 'lsp.event' || typeof message.clientId !== 'string') return false;
  const client = lspClients.get(message.clientId);
  if (!client) return true;
  try {
    const event = isRecord(message.event) ? message.event : { type: 'error', error: 'LSP event was empty.' };
    client.ws.send(JSON.stringify({ type: 'lsp.event', clientId: message.clientId, event }));
  } catch {
    disconnectLspRelayClient(message.clientId);
  }
  return true;
};
