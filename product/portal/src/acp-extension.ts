import {
  WEAVE_ACP_META_NAMESPACE,
  WEAVE_ACP_RUNTIME_STATE_METHOD,
  WEAVE_ACP_THREAD_EVENT_META,
  WEAVE_ACP_THREAD_EVENTS_ACK_METHOD,
  WEAVE_ACP_THREAD_EVENTS_LOAD_META,
  WEAVE_ACP_THREAD_EVENTS_SYNC_METHOD,
} from '@weave/product-protocol';
import type { JsonRpcMessage } from './json-rpc.ts';
import type { ThreadEventRecord } from './thread-journal.ts';

export const THREAD_EVENTS_ACK_METHOD = WEAVE_ACP_THREAD_EVENTS_ACK_METHOD;
export const THREAD_EVENTS_SYNC_METHOD = WEAVE_ACP_THREAD_EVENTS_SYNC_METHOD;
export const RUNTIME_STATE_METHOD = WEAVE_ACP_RUNTIME_STATE_METHOD;
export const RESUME_GAP_ERROR = -32060;
export const RUNTIME_UNAVAILABLE_ERROR = -32050;

const objectFrom = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export const withWeaveCapabilities = (value: unknown) => {
  const initialize = objectFrom(value);
  const agentCapabilities = objectFrom(initialize.agentCapabilities);
  const meta = objectFrom(agentCapabilities._meta);
  const weave = objectFrom(meta[WEAVE_ACP_META_NAMESPACE]);
  return {
    ...initialize,
    agentCapabilities: {
      ...agentCapabilities,
      _meta: {
        ...meta,
        [WEAVE_ACP_META_NAMESPACE]: {
          ...weave,
          threadEvents: {
            version: 1,
            ackMethod: THREAD_EVENTS_ACK_METHOD,
            syncNotification: THREAD_EVENTS_SYNC_METHOD,
          },
          runtimeRecovery: { version: 1, stateNotification: RUNTIME_STATE_METHOD },
        },
      },
    },
  };
};

export const threadEventsCursorFrom = (
  params: unknown,
): { enabled: false } | { enabled: true; afterSequence?: number } => {
  const extension = objectFrom(objectFrom(objectFrom(params)._meta)[WEAVE_ACP_THREAD_EVENTS_LOAD_META]);
  if (!Object.keys(extension).length) return { enabled: false };
  const cursor = extension.afterSequence;
  if (cursor === null) return { enabled: true };
  if (!Number.isInteger(cursor) || Number(cursor) < 0) {
    throw new Error('Thread event cursor must be a non-negative integer or null.');
  }
  return { enabled: true, afterSequence: Number(cursor) };
};

export const threadEventAckFrom = (params: unknown) => {
  const record = objectFrom(params);
  if (typeof record.sessionId !== 'string' || !record.sessionId || !Number.isInteger(record.sequence)) {
    throw new Error('Invalid Thread event acknowledgement.');
  }
  const sequence = Number(record.sequence);
  if (sequence < 0) throw new Error('Invalid Thread event acknowledgement.');
  return { sessionId: record.sessionId, sequence };
};

export const messageForThreadEvent = (event: ThreadEventRecord): JsonRpcMessage => {
  const params = objectFrom(event.message.params);
  const update = objectFrom(params.update);
  return {
    ...event.message,
    params: {
      ...params,
      update: {
        ...update,
        _meta: {
          ...objectFrom(update._meta),
          [WEAVE_ACP_THREAD_EVENT_META]: {
            sequence: event.sequence,
            eventId: event.eventId,
            createdAt: event.createdAt,
          },
        },
      },
    },
  };
};
