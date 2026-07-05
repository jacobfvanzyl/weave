import { observeServerNotifications, publishServerNotification } from '../modules/notifications/service';
import type { ServerNotificationInput, StoredNotificationEvent } from '../modules/notifications/types';
import type { JsonValue, ServiceCaller } from './types';
import { optionalString, ServiceError } from './types';

export type ServiceEvent = {
  id: string;
  ownerId: string;
  stream: string;
  type: string;
  data: JsonValue;
  createdAt: string;
  sequence: number;
};

type EventStreamState = {
  nextSequence: number;
  buffer: ServiceEvent[];
  listeners: Set<(event: ServiceEvent) => void>;
};

export interface EventService {
  publishNotification(caller: ServiceCaller, input: ServerNotificationInput): Promise<StoredNotificationEvent>;
  observeNotifications(
    caller: Pick<ServiceCaller, 'ownerId'>,
    afterSequence?: number,
  ): ReadableStream<StoredNotificationEvent>;
  publishEvent(caller: ServiceCaller, input: { stream: string; type: string; data: JsonValue }): Promise<ServiceEvent>;
  observeEvents(
    caller: Pick<ServiceCaller, 'ownerId'>,
    stream: string,
    afterSequence?: number,
  ): ReadableStream<ServiceEvent>;
}

const maxBufferedEventsPerStream = 250;
const streams = new Map<string, EventStreamState>();

const streamKey = (ownerId: string, stream: string) => `${ownerId}:${stream}`;

const getStreamState = (ownerId: string, stream: string) => {
  const key = streamKey(ownerId, stream);
  let state = streams.get(key);
  if (!state) {
    state = { nextSequence: 1, buffer: [], listeners: new Set() };
    streams.set(key, state);
  }
  return state;
};

export class DefaultEventService implements EventService {
  async publishNotification(caller: ServiceCaller, input: ServerNotificationInput) {
    return publishServerNotification(caller.ownerId, input);
  }

  observeNotifications(caller: Pick<ServiceCaller, 'ownerId'>, afterSequence = 0) {
    return observeServerNotifications(caller.ownerId, afterSequence);
  }

  async publishEvent(caller: ServiceCaller, input: { stream: string; type: string; data: JsonValue }) {
    const stream = optionalString(input.stream);
    const type = optionalString(input.type);
    if (!stream) throw new ServiceError('invalid_scope', 'Event stream is required.', 400);
    if (!type) throw new ServiceError('operation_failed', 'Event type is required.', 400);

    const state = getStreamState(caller.ownerId, stream);
    const event: ServiceEvent = {
      id: `evt_${crypto.randomUUID()}`,
      ownerId: caller.ownerId,
      stream,
      type,
      data: input.data,
      createdAt: new Date().toISOString(),
      sequence: state.nextSequence,
    };
    state.nextSequence += 1;
    state.buffer.push(event);
    if (state.buffer.length > maxBufferedEventsPerStream) {
      state.buffer.splice(0, state.buffer.length - maxBufferedEventsPerStream);
    }
    for (const listener of state.listeners) listener(event);
    return event;
  }

  observeEvents(caller: Pick<ServiceCaller, 'ownerId'>, stream: string, afterSequence = 0) {
    const normalizedStream = optionalString(stream);
    if (!normalizedStream) throw new ServiceError('invalid_scope', 'Event stream is required.', 400);
    let cleanup = () => undefined;
    return new ReadableStream<ServiceEvent>({
      start(controller) {
        const state = getStreamState(caller.ownerId, normalizedStream);
        for (const event of state.buffer) {
          if (event.sequence > afterSequence) controller.enqueue(event);
        }
        const listener = (event: ServiceEvent) => controller.enqueue(event);
        state.listeners.add(listener);
        cleanup = () => {
          state.listeners.delete(listener);
        };
      },
      cancel() {
        cleanup();
      },
    });
  }
}
