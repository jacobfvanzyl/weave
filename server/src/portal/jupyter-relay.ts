import { getPortalConnection, sendPortalMessage } from './registry';

export type JupyterSessionTokenRecord = {
  resourceId: string;
  portalId: string;
  sessionId: string;
  projectId?: string;
  workspaceId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
  path: string;
  kernelName?: string;
  expiresAt: number;
};

type JupyterRelaySocket = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type JupyterRelayClient = {
  portalId: string;
  sessionId: string;
  ws: JupyterRelaySocket;
  token: JupyterSessionTokenRecord;
};

const jupyterSessionTokenTtlMs = 60_000;
const jupyterSessionTokens = new Map<string, JupyterSessionTokenRecord>();
const jupyterClients = new Map<string, JupyterRelayClient>();

const now = () => Date.now();

const cleanupExpiredTokens = () => {
  const at = now();
  for (const [token, record] of jupyterSessionTokens) {
    if (record.expiresAt <= at) jupyterSessionTokens.delete(token);
  }
};

export const issueJupyterSessionToken = (record: Omit<JupyterSessionTokenRecord, 'expiresAt'>) => {
  cleanupExpiredTokens();
  const token = `jupyter_${crypto.randomUUID().replace(/-/g, '')}`;
  jupyterSessionTokens.set(token, { ...record, expiresAt: now() + jupyterSessionTokenTtlMs });
  return token;
};

const takeJupyterSessionToken = (token: string) => {
  cleanupExpiredTokens();
  const record = jupyterSessionTokens.get(token);
  if (!record) return undefined;
  jupyterSessionTokens.delete(token);
  if (record.expiresAt <= now()) return undefined;
  return record;
};

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const optionalBoolean = (value: unknown) => typeof value === 'boolean' ? value : undefined;

const sanitizeJupyterClientMessage = (
  rawMessage: Record<string, unknown>,
  token: JupyterSessionTokenRecord,
) => {
  if (rawMessage.type === 'execute') {
    const code = typeof rawMessage.code === 'string' ? rawMessage.code : undefined;
    if (code === undefined) throw new Error('Jupyter execute code is required.');

    return {
      type: 'execute' as const,
      sessionId: token.sessionId,
      requestId: optionalString(rawMessage.requestId),
      cellId: optionalString(rawMessage.cellId),
      code,
      allowStdin: false,
      silent: optionalBoolean(rawMessage.silent) ?? false,
      storeHistory: optionalBoolean(rawMessage.storeHistory) ?? true,
    };
  }

  if (rawMessage.type === 'detach') return { type: 'detach' as const, sessionId: token.sessionId };
  throw new Error('Unsupported Jupyter message.');
};

export const connectJupyterRelayClient = (input: {
  token: string;
  ws: JupyterRelaySocket;
}) => {
  const token = takeJupyterSessionToken(input.token);
  if (!token) return undefined;
  if (!getPortalConnection(token.portalId)) return undefined;

  const clientId = `relay-jupyter:${crypto.randomUUID()}`;
  jupyterClients.set(clientId, {
    portalId: token.portalId,
    sessionId: token.sessionId,
    ws: input.ws,
    token,
  });
  return { clientId, token };
};

export const disconnectJupyterRelayClient = (clientId: string) => {
  const client = jupyterClients.get(clientId);
  if (!client) return;

  try {
    sendPortalMessage(client.portalId, {
      type: 'jupyter.client',
      clientId,
      message: { type: 'detach', sessionId: client.sessionId },
    });
  } catch {
    // Portal is already gone; dropping the relay client is enough.
  }

  jupyterClients.delete(clientId);
};

export const forwardJupyterClientMessage = (
  clientId: string,
  rawMessage: Record<string, unknown>,
) => {
  const client = jupyterClients.get(clientId);
  if (!client) throw new Error('Jupyter relay client is not connected.');
  const message = sanitizeJupyterClientMessage(rawMessage, client.token);
  sendPortalMessage(client.portalId, { type: 'jupyter.client', clientId, message });
};

export const handleJupyterPortalMessage = (message: Record<string, unknown>) => {
  if (message.type !== 'jupyter.event' || typeof message.clientId !== 'string') return false;
  const client = jupyterClients.get(message.clientId);
  if (!client) return true;
  try {
    const event = message.event && typeof message.event === 'object'
      ? message.event
      : { type: 'error', error: 'Jupyter event was empty.' };
    client.ws.send(JSON.stringify({ type: 'jupyter.event', clientId: message.clientId, event }));
  } catch {
    disconnectJupyterRelayClient(message.clientId);
  }
  return true;
};
