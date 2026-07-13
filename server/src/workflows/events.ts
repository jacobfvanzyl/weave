import type { EventService } from '../services/event-service';
import { eventService as defaultEventService } from '../services/event-service';
import { callerForOwner } from '../services/types';
import type { WorkflowRunInput } from './definition';
import { type AppendWorkflowRunEventInput, type WorkflowRepository, workflowRepository } from './repository';
import type { WorkflowRunnerEvent, WorkflowRunnerEventHandler } from './runner';
import type { WorkflowRunEventRecord } from './repository';

export type WorkflowRunEventRecorderDeps = {
  repository?: Pick<WorkflowRepository, 'appendRunEvent'>;
  events?: EventService;
};

const liveWorkflowRunListeners = new Map<string, Set<(event: WorkflowRunEventRecord) => void>>();
const liveWorkflowRunKey = (ownerId: string, runId: string) => `${ownerId}:${runId}`;

export const subscribePersistedWorkflowRunEvents = (
  ownerId: string,
  runId: string,
  listener: (event: WorkflowRunEventRecord) => void,
) => {
  const key = liveWorkflowRunKey(ownerId, runId);
  const listeners = liveWorkflowRunListeners.get(key) ?? new Set();
  listeners.add(listener);
  liveWorkflowRunListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) liveWorkflowRunListeners.delete(key);
  };
};

export const workflowRunEventId = (runId: string, key: string) => `workflow-run:${runId}:${key}`;

export const recordWorkflowRunEvent = async (
  input: AppendWorkflowRunEventInput,
  deps: WorkflowRunEventRecorderDeps = {},
) => {
  const repository = deps.repository ?? workflowRepository;
  const events = deps.events ?? defaultEventService;
  const event = await repository.appendRunEvent(input);
  for (const listener of liveWorkflowRunListeners.get(liveWorkflowRunKey(input.ownerId, input.runId)) ?? []) {
    listener(event);
  }
  await events.publishRunEvent(callerForOwner(input.ownerId, 'system', { workflowRunId: input.runId }), {
    runKind: 'workflow',
    runId: input.runId,
    type: input.type,
    data: input.data,
  }).catch(() => undefined);
  return event;
};

export const createWorkflowRunnerEventRecorder = (
  input: WorkflowRunInput,
  deps: WorkflowRunEventRecorderDeps = {},
): WorkflowRunnerEventHandler =>
async (event: WorkflowRunnerEvent) => {
  await recordWorkflowRunEvent({
    ownerId: input.ownerId,
    runId: input.workflowRunId,
    eventId: event.eventId,
    type: event.type,
    data: event.data,
  }, deps).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[workflows] failed to record runner event ${event.type}: ${message}`);
  });
};
