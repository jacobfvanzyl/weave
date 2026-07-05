import type { EventService } from '../services/event-service';
import { eventService as defaultEventService } from '../services/event-service';
import { callerForOwner } from '../services/types';
import type { WorkflowRunInput } from './definition';
import { type AppendWorkflowRunEventInput, type WorkflowRepository, workflowRepository } from './repository';
import type { WorkflowRunnerEvent, WorkflowRunnerEventHandler } from './runner';

export type WorkflowRunEventRecorderDeps = {
  repository?: Pick<WorkflowRepository, 'appendRunEvent'>;
  events?: EventService;
};

export const workflowRunEventId = (runId: string, key: string) => `workflow-run:${runId}:${key}`;

export const recordWorkflowRunEvent = async (
  input: AppendWorkflowRunEventInput,
  deps: WorkflowRunEventRecorderDeps = {},
) => {
  const repository = deps.repository ?? workflowRepository;
  const events = deps.events ?? defaultEventService;
  const event = await repository.appendRunEvent(input);
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
