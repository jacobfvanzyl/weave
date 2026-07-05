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

export type ServiceRunEventKind = 'agent' | 'workflow';

export type PublishServiceEventInput = {
  stream: string;
  type: string;
  data: JsonValue;
};

export type PublishRunEventInput = {
  runKind: ServiceRunEventKind;
  runId: string;
  type: string;
  data: JsonValue;
};

export type PublishAuditEventInput = {
  scope?: string;
  type: string;
  data: JsonValue;
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
  publishEvent(caller: ServiceCaller, input: PublishServiceEventInput): Promise<ServiceEvent>;
  observeEvents(
    caller: Pick<ServiceCaller, 'ownerId'>,
    stream: string,
    afterSequence?: number,
  ): ReadableStream<ServiceEvent>;
  publishRunEvent(caller: ServiceCaller, input: PublishRunEventInput): Promise<ServiceEvent>;
  observeRunEvents(
    caller: Pick<ServiceCaller, 'ownerId'>,
    runKind: ServiceRunEventKind,
    runId: string,
    afterSequence?: number,
  ): ReadableStream<ServiceEvent>;
  publishAuditEvent(caller: ServiceCaller, input: PublishAuditEventInput): Promise<ServiceEvent>;
  observeAuditEvents(
    caller: Pick<ServiceCaller, 'ownerId'>,
    scope?: string,
    afterSequence?: number,
  ): ReadableStream<ServiceEvent>;
}

const maxBufferedEventsPerStream = 250;
const streams = new Map<string, EventStreamState>();

const streamKey = (ownerId: string, stream: string) => `${ownerId}:${stream}`;

export const serviceRunEventStream = (runKind: ServiceRunEventKind, runId: string) => {
  const id = optionalString(runId);
  if (!id) throw new ServiceError('invalid_scope', 'Run id is required.', 400);
  return `${runKind}-run:${id}`;
};

export const serviceAuditEventStream = (scope?: string) => {
  const normalizedScope = optionalString(scope) ?? 'global';
  return `audit:${normalizedScope}`;
};

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

  async publishEvent(caller: ServiceCaller, input: PublishServiceEventInput) {
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

  publishRunEvent(caller: ServiceCaller, input: PublishRunEventInput) {
    return this.publishEvent(caller, {
      stream: serviceRunEventStream(input.runKind, input.runId),
      type: input.type,
      data: input.data,
    });
  }

  observeRunEvents(
    caller: Pick<ServiceCaller, 'ownerId'>,
    runKind: ServiceRunEventKind,
    runId: string,
    afterSequence = 0,
  ) {
    return this.observeEvents(caller, serviceRunEventStream(runKind, runId), afterSequence);
  }

  publishAuditEvent(caller: ServiceCaller, input: PublishAuditEventInput) {
    return this.publishEvent(caller, {
      stream: serviceAuditEventStream(input.scope),
      type: input.type,
      data: input.data,
    });
  }

  observeAuditEvents(caller: Pick<ServiceCaller, 'ownerId'>, scope?: string, afterSequence = 0) {
    return this.observeEvents(caller, serviceAuditEventStream(scope), afterSequence);
  }
}

export const eventService = new DefaultEventService();

export const clearEventServiceForTests = () => {
  streams.clear();
};
