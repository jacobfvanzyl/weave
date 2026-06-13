import { getPortalConnection, sendPortalMessage } from './registry';

export type WindowSessionTokenRecord = {
  resourceId: string;
  portalId: string;
  sessionId: string;
  windowId?: string;
  expiresAt: number;
};

type WindowRelaySocket = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type WindowRelayClient = {
  portalId: string;
  sessionId: string;
  ws: WindowRelaySocket;
  token: WindowSessionTokenRecord;
};

const windowSessionTokenTtlMs = 60_000;
const windowSessionTokens = new Map<string, WindowSessionTokenRecord>();
const windowClients = new Map<string, WindowRelayClient>();

const now = () => Date.now();

const cleanupExpiredTokens = () => {
  const at = now();
  for (const [token, record] of windowSessionTokens) {
    if (record.expiresAt <= at) windowSessionTokens.delete(token);
  }
};

export const issueWindowSessionToken = (record: Omit<WindowSessionTokenRecord, 'expiresAt'>) => {
  cleanupExpiredTokens();
  const token = `win_${crypto.randomUUID().replace(/-/g, '')}`;
  windowSessionTokens.set(token, { ...record, expiresAt: now() + windowSessionTokenTtlMs });
  return token;
};

const takeWindowSessionToken = (token: string) => {
  cleanupExpiredTokens();
  const record = windowSessionTokens.get(token);
  if (!record) return undefined;
  windowSessionTokens.delete(token);
  if (record.expiresAt <= now()) return undefined;
  return record;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const sanitizeRtcDescription = (value: unknown) => {
  if (!isRecord(value)) throw new Error('RTC description is required.');
  const type = optionalString(value.type);
  const sdp = optionalString(value.sdp);
  if ((type !== 'offer' && type !== 'answer') || !sdp) throw new Error('Invalid RTC description.');
  return { type, sdp };
};

const sanitizeIceCandidate = (value: unknown) => {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error('ICE candidate must be an object or null.');
  return {
    candidate: optionalString(value.candidate) ?? '',
    sdpMid: optionalString(value.sdpMid),
    sdpMLineIndex: typeof value.sdpMLineIndex === 'number' ? value.sdpMLineIndex : undefined,
    usernameFragment: optionalString(value.usernameFragment),
  };
};

const sanitizeViewerMessage = (
  rawMessage: Record<string, unknown>,
  token: WindowSessionTokenRecord,
) => {
  if (rawMessage.type === 'start') {
    return {
      type: 'start',
      sessionId: token.sessionId,
      windowId: token.windowId,
      iceServers: [] as unknown[],
    };
  }

  if (rawMessage.type === 'answer') {
    return {
      type: 'answer',
      sessionId: token.sessionId,
      answer: sanitizeRtcDescription(rawMessage.answer),
    };
  }

  if (rawMessage.type === 'ice-candidate') {
    return {
      type: 'ice-candidate',
      sessionId: token.sessionId,
      candidate: sanitizeIceCandidate(rawMessage.candidate),
    };
  }

  if (rawMessage.type === 'stop') return { type: 'stop', sessionId: token.sessionId };
  if (rawMessage.type === 'ready') return { type: 'ready', sessionId: token.sessionId };
  throw new Error('Unsupported window signal message.');
};

export const connectWindowRelayClient = (input: {
  token: string;
  ws: WindowRelaySocket;
}) => {
  const token = takeWindowSessionToken(input.token);
  if (!token) return undefined;
  if (!getPortalConnection(token.portalId)) return undefined;

  const clientId = `window:${crypto.randomUUID()}`;
  windowClients.set(clientId, {
    portalId: token.portalId,
    sessionId: token.sessionId,
    ws: input.ws,
    token,
  });
  return { clientId, token };
};

export const disconnectWindowRelayClient = (clientId: string) => {
  const client = windowClients.get(clientId);
  if (!client) return;

  try {
    sendPortalMessage(client.portalId, {
      type: 'window.client',
      clientId,
      sessionId: client.sessionId,
      message: { type: 'stop', sessionId: client.sessionId },
    });
  } catch {
    // Portal is already gone; dropping the relay client is enough.
  }

  windowClients.delete(clientId);
};

export const forwardWindowClientMessage = (
  clientId: string,
  rawMessage: Record<string, unknown>,
) => {
  const client = windowClients.get(clientId);
  if (!client) throw new Error('Window relay client is not connected.');
  const message = sanitizeViewerMessage(rawMessage, client.token);
  sendPortalMessage(client.portalId, {
    type: 'window.client',
    clientId,
    sessionId: client.sessionId,
    message,
  });
};

export const handleWindowPortalMessage = (message: Record<string, unknown>) => {
  if (message.type !== 'window.event' || typeof message.clientId !== 'string') return false;
  const client = windowClients.get(message.clientId);
  if (!client) return true;
  try {
    client.ws.send(JSON.stringify(message.event ?? { type: 'error', error: 'Window event was empty.' }));
  } catch {
    disconnectWindowRelayClient(message.clientId);
  }
  return true;
};
