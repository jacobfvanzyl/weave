import { getAuthHeaders } from '../mastra-client';
import { weaveRoutes } from '../weave-routes';
import { parseWeaveNotificationEvent, type WeaveNotificationEvent } from './types';

type SseMessage = {
  id?: string;
  event?: string;
  data: string;
};

type NotificationStreamOptions = {
  onEvent: (event: WeaveNotificationEvent) => void;
  retryMs?: number;
};

const createSseParser = (onMessage: (message: SseMessage) => void) => {
  let buffer = '';

  const parseBlock = (block: string) => {
    const message: { id?: string; event?: string; data: string[] } = { data: [] };
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line || line.startsWith(':')) continue;
      const separatorIndex = line.indexOf(':');
      const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
      const rawValue = separatorIndex === -1 ? '' : line.slice(separatorIndex + 1);
      const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

      if (field === 'id') message.id = value;
      else if (field === 'event') message.event = value;
      else if (field === 'data') message.data.push(value);
    }

    if (message.data.length > 0) onMessage({ ...message, data: message.data.join('\n') });
  };

  return {
    feed(chunk: string) {
      buffer += chunk;
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';
      for (const block of blocks) parseBlock(block);
    },
    flush() {
      if (!buffer.trim()) return;
      parseBlock(buffer);
      buffer = '';
    },
  };
};

export const parseNotificationSseChunk = (chunk: string) => {
  const messages: SseMessage[] = [];
  const parser = createSseParser(message => messages.push(message));
  parser.feed(chunk);
  parser.flush();
  return messages;
};

const readNotificationStream = async (
  response: Response,
  onMessage: (message: SseMessage) => void,
  signal: AbortSignal,
) => {
  if (!response.body) throw new Error('Notification stream response did not include a body.');

  const parser = createSseParser(onMessage);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(value);
    }
    parser.flush();
  } finally {
    reader.releaseLock();
  }
};

export const connectServerNotificationStream = ({ onEvent, retryMs = 3_000 }: NotificationStreamOptions) => {
  const controller = new AbortController();
  let lastSequence = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveRetry: (() => void) | undefined;

  const connect = async () => {
    const params = lastSequence > 0 ? new URLSearchParams({ after: String(lastSequence) }) : undefined;
    const response = await fetch(weaveRoutes.notifications.events(params), {
      headers: {
        ...getAuthHeaders(),
        Accept: 'text/event-stream',
      },
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`Notification stream failed: HTTP ${response.status}`);

    await readNotificationStream(response, message => {
      const parsedSequence = Number(message.id);
      if (Number.isInteger(parsedSequence) && parsedSequence > lastSequence) lastSequence = parsedSequence;
      if (message.event && message.event !== 'notification') return;
      try {
        const event = parseWeaveNotificationEvent(JSON.parse(message.data) as unknown);
        if (event) onEvent(event);
      } catch {
        // Ignore malformed stream payloads.
      }
    }, controller.signal);
  };

  const loop = async () => {
    while (!controller.signal.aborted) {
      try {
        await connect();
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn('[notifications] server stream disconnected', error);
      }

      await new Promise<void>(resolve => {
        if (controller.signal.aborted) {
          resolve();
          return;
        }
        resolveRetry = resolve;
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          resolveRetry = undefined;
          resolve();
        }, retryMs);
      });
    }
  };

  void loop();

  return () => {
    if (retryTimer) clearTimeout(retryTimer);
    resolveRetry?.();
    retryTimer = undefined;
    resolveRetry = undefined;
    controller.abort();
  };
};
