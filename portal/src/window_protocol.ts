export type PortalWindowInfo = {
  id: string;
  title?: string;
  appName?: string;
  pid?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

export type WindowStreamVideoCodecCapability = {
  mimeType: string;
  clockRate?: number;
  sdpFmtpLine?: string;
};

export type WindowClientMessage =
  | {
    type: 'start';
    sessionId: string;
    windowId?: string;
    iceServers?: unknown[];
    videoCodecs?: WindowStreamVideoCodecCapability[];
  }
  | { type: 'answer'; sessionId: string; answer: { type: 'answer'; sdp: string } }
  | { type: 'ice-candidate'; sessionId: string; candidate: unknown }
  | { type: 'stop'; sessionId: string };

export type WindowHostEvent =
  | { type: 'started'; sessionId: string }
  | { type: 'offer'; sessionId: string; offer: { type: 'offer'; sdp: string } }
  | { type: 'ice-candidate'; sessionId: string; candidate: unknown }
  | { type: 'stopped'; sessionId: string }
  | { type: 'error'; sessionId?: string; error: string }
  | { type: 'stats'; sessionId: string; stats: Record<string, unknown> };

export type WindowClientEnvelope = {
  type: 'window.client';
  clientId: string;
  sessionId?: string;
  message: WindowClientMessage;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object');

export const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

export const toErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message) return error.message;
  const direct = optionalString(error);
  if (direct) return direct;
  if (isRecord(error)) {
    const nested = optionalString(error.message) ?? optionalString(error.error) ?? optionalString(error.reason);
    if (nested) return nested;
    try {
      return JSON.stringify(error);
    } catch {
      // Fall through to String().
    }
  }
  return String(error);
};

export const normalizeVideoCodecs = (value: unknown): WindowStreamVideoCodecCapability[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const mimeType = optionalString(item.mimeType);
    if (!mimeType) return [];
    return [{
      mimeType,
      clockRate: typeof item.clockRate === 'number' ? item.clockRate : undefined,
      sdpFmtpLine: optionalString(item.sdpFmtpLine),
    }];
  });
};

export const isWindowClientEnvelope = (message: Record<string, unknown>): message is WindowClientEnvelope =>
  message.type === 'window.client' &&
  typeof message.clientId === 'string' &&
  Boolean(message.message && typeof message.message === 'object');
