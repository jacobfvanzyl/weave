import type {
  ServerNotificationInput,
  StoredNotificationEvent,
  WeaveNotificationEvent,
  WeaveNotificationPriority,
} from './types';

const maxBufferedEventsPerResource = 100;

type ResourceNotificationState = {
  nextSequence: number;
  buffer: StoredNotificationEvent[];
  listeners: Set<(event: StoredNotificationEvent) => void>;
};

const resourceStates = new Map<string, ResourceNotificationState>();

const getResourceState = (resourceId: string) => {
  let state = resourceStates.get(resourceId);
  if (!state) {
    state = {
      nextSequence: 1,
      buffer: [],
      listeners: new Set(),
    };
    resourceStates.set(resourceId, state);
  }

  return state;
};

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const normalizePriority = (value: unknown): WeaveNotificationPriority =>
  value === 'low' || value === 'high' ? value : 'normal';

const createServerNotificationEvent = (
  resourceId: string,
  sequence: number,
  input: ServerNotificationInput,
): WeaveNotificationEvent => {
  const kind = optionalString(input.kind);
  const title = optionalString(input.title);
  const body = optionalString(input.body);
  const dedupeKey = optionalString(input.dedupeKey);
  if (!kind) throw new Error('Notification kind is required.');
  if (!title) throw new Error('Notification title is required.');

  return {
    id: optionalString(input.id) ?? `server:${resourceId}:${sequence}`,
    kind,
    title,
    ...(body ? { body } : {}),
    createdAt: optionalString(input.createdAt) ?? new Date().toISOString(),
    ...(dedupeKey ? { dedupeKey } : {}),
    priority: normalizePriority(input.priority),
    ...(input.target ? { target: input.target } : {}),
    source: 'server',
  };
};

export const publishServerNotification = (
  resourceId: string,
  input: ServerNotificationInput,
): StoredNotificationEvent => {
  const trimmedResourceId = optionalString(resourceId);
  if (!trimmedResourceId) throw new Error('Notification resource id is required.');

  const state = getResourceState(trimmedResourceId);
  const sequence = state.nextSequence;
  state.nextSequence += 1;

  const event = createServerNotificationEvent(trimmedResourceId, sequence, input);
  const stored = { sequence, event };
  state.buffer.push(stored);
  if (state.buffer.length > maxBufferedEventsPerResource) {
    state.buffer.splice(0, state.buffer.length - maxBufferedEventsPerResource);
  }

  for (const listener of state.listeners) listener(stored);
  return stored;
};

export const observeServerNotifications = (
  resourceId: string,
  afterSequence = 0,
): ReadableStream<StoredNotificationEvent> => {
  const trimmedResourceId = optionalString(resourceId);
  if (!trimmedResourceId) throw new Error('Notification resource id is required.');

  let cleanup = () => undefined;

  return new ReadableStream<StoredNotificationEvent>({
    start(controller) {
      const state = getResourceState(trimmedResourceId);
      for (const event of state.buffer) {
        if (event.sequence > afterSequence) controller.enqueue(event);
      }

      const listener = (event: StoredNotificationEvent) => controller.enqueue(event);
      state.listeners.add(listener);
      cleanup = () => {
        state.listeners.delete(listener);
      };
    },
    cancel() {
      cleanup();
    },
  });
};

export const clearNotificationHubForTests = () => {
  resourceStates.clear();
};
