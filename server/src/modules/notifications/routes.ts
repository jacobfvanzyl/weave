import { getOwner } from '../../owner/auth';
import { defineRoute } from '../../server/routes';
import { type EventService, eventService as defaultEventService } from '../../services/event-service';
import { callerForOwner } from '../../services/types';
import type { StoredNotificationEvent } from './types';

const sseKeepAliveIntervalMs = 15_000;
const maxTestNotificationTitleLength = 160;
const maxTestNotificationBodyLength = 512;

const parseSequence = (value: string | undefined | null) => {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
};

const encodeSseEvent = (event: StoredNotificationEvent) =>
  `id: ${event.sequence}\nevent: notification\ndata: ${JSON.stringify(event.event)}\n\n`;

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const limitString = (value: string, maxLength: number) => value.length > maxLength ? value.slice(0, maxLength) : value;

const parseTestNotificationBody = (body: unknown) => {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const title = optionalString(record.title);
  if (!title) return { error: 'Notification title is required.' };

  const notificationBody = optionalString(record.body);
  return {
    title: limitString(title, maxTestNotificationTitleLength),
    ...(notificationBody ? { body: limitString(notificationBody, maxTestNotificationBodyLength) } : {}),
  };
};

const toNotificationSseResponse = (stream: ReadableStream<StoredNotificationEvent>) => {
  const reader = stream.getReader();
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

  const clearKeepAliveTimer = () => {
    if (!keepAliveTimer) return;
    clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  };

  const sseStream = new ReadableStream<string>({
    async start(controller) {
      controller.enqueue(': connected\n\n');
      keepAliveTimer = setInterval(() => {
        controller.enqueue(': keep-alive\n\n');
      }, sseKeepAliveIntervalMs);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(encodeSseEvent(value));
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        clearKeepAliveTimer();
        reader.releaseLock();
      }
    },
    cancel(reason) {
      clearKeepAliveTimer();
      return reader.cancel(reason).catch(() => undefined);
    },
  });

  return new Response(sseStream.pipeThrough(new TextEncoderStream()), {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
};

export const createNotificationRoutes = (events: EventService = defaultEventService) => [
  defineRoute('/notifications/events', {
    method: 'GET',
    handler: (c) => {
      const owner = getOwner(c);
      const afterSequence = parseSequence(c.req.query('after') ?? c.req.header('Last-Event-ID'));
      return toNotificationSseResponse(events.observeNotifications({ ownerId: owner.id }, afterSequence));
    },
  }),
  defineRoute('/notifications/test', {
    method: 'POST',
    handler: async (c) => {
      const owner = getOwner(c);
      const body = await c.req.json().catch(() => undefined);
      const input = parseTestNotificationBody(body);
      if ('error' in input) return c.json({ error: input.error }, 400);

      const notificationInput = {
        kind: 'notification.test',
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        priority: 'normal',
      } as const;
      const stored = await events.publishNotification(callerForOwner(owner.id, 'ui'), notificationInput);

      return c.json({ ok: true, sequence: stored.sequence, event: stored.event });
    },
  }),
];

export const notificationRoutes = createNotificationRoutes();
