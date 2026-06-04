import { getPortalConnection, sendPortalMessage } from './registry';

export type TerminalSessionKind = 'workspace' | 'general';

export type TerminalStartInput = {
  kind: TerminalSessionKind;
  terminalId: string;
  projectId?: string;
  workspaceId?: string;
  portalId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
};

export type TerminalClientMessage =
  | ({ type: 'start' } & TerminalStartInput)
  | { type: 'input'; terminalId: string; data: string }
  | { type: 'resize'; terminalId: string; cols: number; rows: number }
  | { type: 'close'; terminalId: string }
  | { type: 'detach'; terminalId: string };

export type TerminalHostEvent =
  | { type: 'started'; terminalId: string; workspaceId?: string; sessionId: string; cwd: string; pid?: number; cols: number; rows: number }
  | { type: 'output'; terminalId: string; workspaceId?: string; data: string }
  | { type: 'replay'; terminalId: string; workspaceId?: string; data: string }
  | { type: 'title'; terminalId: string; workspaceId?: string; title: string }
  | { type: 'exit'; terminalId: string; workspaceId?: string; exitCode?: number; signal?: number | string }
  | { type: 'error'; terminalId: string; workspaceId?: string; error: string };

export type TerminalTokenRecord = {
  resourceId: string;
  portalId: string;
  kind: TerminalSessionKind;
  projectId?: string;
  workspaceId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
  expiresAt: number;
};

type TerminalClientSocket = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

const terminalTokenTtlMs = 60_000;
const terminalTokens = new Map<string, TerminalTokenRecord>();
const terminalClients = new Map<string, { portalId: string; ws: TerminalClientSocket; terminalIds: Set<string> }>();

const now = () => Date.now();

const cleanupExpiredTokens = () => {
  const at = now();
  for (const [token, record] of terminalTokens) {
    if (record.expiresAt <= at) terminalTokens.delete(token);
  }
};

export const issueTerminalToken = (record: Omit<TerminalTokenRecord, 'expiresAt'>) => {
  cleanupExpiredTokens();
  const token = `term_${crypto.randomUUID().replace(/-/g, '')}`;
  terminalTokens.set(token, { ...record, expiresAt: now() + terminalTokenTtlMs });
  return token;
};

const takeTerminalToken = (token: string) => {
  cleanupExpiredTokens();
  const record = terminalTokens.get(token);
  if (!record) return undefined;
  terminalTokens.delete(token);
  if (record.expiresAt <= now()) return undefined;
  return record;
};

const stringValue = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const parseTerminalId = (value: unknown) => {
  const terminalId = stringValue(value);
  if (!terminalId) throw new Error('terminalId is required.');
  return terminalId;
};

const parseDimension = (value: unknown, fallback: number, min: number, max: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
};

const sanitizeTerminalClientMessage = (message: Record<string, unknown>, token: TerminalTokenRecord): TerminalClientMessage => {
  if (message.type === 'start') {
    const terminalId = parseTerminalId(message.terminalId);
    return {
      type: 'start',
      kind: token.kind,
      terminalId,
      portalId: token.portalId,
      projectId: token.projectId,
      workspaceId: token.workspaceId,
      rootId: token.rootId,
      repoPath: token.repoPath,
      workspacePath: token.workspacePath,
      cols: parseDimension(message.cols, 80, 10, 400),
      rows: parseDimension(message.rows, 24, 3, 200),
    };
  }

  if (message.type === 'input') {
    return { type: 'input', terminalId: parseTerminalId(message.terminalId), data: typeof message.data === 'string' ? message.data : '' };
  }

  if (message.type === 'resize') {
    return {
      type: 'resize',
      terminalId: parseTerminalId(message.terminalId),
      cols: parseDimension(message.cols, 80, 10, 400),
      rows: parseDimension(message.rows, 24, 3, 200),
    };
  }

  if (message.type === 'close') return { type: 'close', terminalId: parseTerminalId(message.terminalId) };
  if (message.type === 'detach') return { type: 'detach', terminalId: parseTerminalId(message.terminalId) };
  throw new Error('Unsupported terminal message.');
};

export const connectTerminalRelayClient = (input: {
  token: string;
  ws: TerminalClientSocket;
}) => {
  const token = takeTerminalToken(input.token);
  if (!token) return undefined;
  if (!getPortalConnection(token.portalId)) return undefined;

  const clientId = `relay:${crypto.randomUUID()}`;
  terminalClients.set(clientId, { portalId: token.portalId, ws: input.ws, terminalIds: new Set() });
  return { clientId, token };
};

export const disconnectTerminalRelayClient = (clientId: string) => {
  const client = terminalClients.get(clientId);
  if (!client) return;

  for (const terminalId of client.terminalIds) {
    try {
      sendPortalMessage(client.portalId, {
        type: 'terminal.client',
        clientId,
        message: { type: 'detach', terminalId },
      });
    } catch {
      // Portal is already gone; dropping the relay client is enough.
    }
  }

  terminalClients.delete(clientId);
};

export const forwardTerminalClientMessage = (
  clientId: string,
  rawMessage: Record<string, unknown>,
  token: TerminalTokenRecord,
) => {
  const client = terminalClients.get(clientId);
  if (!client) throw new Error('Terminal relay client is not connected.');
  const message = sanitizeTerminalClientMessage(rawMessage, token);
  if ('terminalId' in message) client.terminalIds.add(message.terminalId);
  sendPortalMessage(client.portalId, { type: 'terminal.client', clientId, message });
};

export const handleTerminalPortalMessage = (message: Record<string, unknown>) => {
  if (message.type !== 'terminal.event' || typeof message.clientId !== 'string') return false;
  const client = terminalClients.get(message.clientId);
  if (!client) return true;
  try {
    client.ws.send(JSON.stringify(message.event));
  } catch {
    disconnectTerminalRelayClient(message.clientId);
  }
  return true;
};
