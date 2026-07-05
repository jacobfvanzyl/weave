import {
  clearEventServiceForTests,
  DefaultEventService,
  serviceAuditEventStream,
  serviceRunEventStream,
} from './event-service.ts';
import { callerForOwner } from './types.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const owner = callerForOwner('owner-1', 'workflow', { workflowRunId: 'workflow-run-1' });

Deno.test('EventService replays generic events after a sequence', async () => {
  clearEventServiceForTests();
  const events = new DefaultEventService();
  await events.publishEvent(owner, { stream: 'workflow:run-1', type: 'started', data: { step: 1 } });
  const second = await events.publishEvent(owner, {
    stream: 'workflow:run-1',
    type: 'completed',
    data: { step: 2 },
  });

  const reader = events.observeEvents({ ownerId: 'owner-1' }, 'workflow:run-1', 1).getReader();
  const replayed = await reader.read();
  await reader.cancel();

  assertEquals(replayed.done, false);
  assertEquals(replayed.value, second);
});

Deno.test('EventService isolates owner and stream event feeds', async () => {
  clearEventServiceForTests();
  const events = new DefaultEventService();
  const reader = events.observeEvents({ ownerId: 'owner-1' }, 'agent-run:run-1').getReader();

  await events.publishEvent(callerForOwner('owner-2', 'workflow'), {
    stream: 'agent-run:run-1',
    type: 'foreign',
    data: {},
  });
  await events.publishEvent(owner, { stream: 'agent-run:run-2', type: 'other-stream', data: {} });
  const local = await events.publishEvent(owner, { stream: 'agent-run:run-1', type: 'local', data: { ok: true } });

  const received = await reader.read();
  await reader.cancel();

  assertEquals(received.value, local);
});

Deno.test('EventService exposes run and audit stream helpers', async () => {
  clearEventServiceForTests();
  const events = new DefaultEventService();

  const runEvent = await events.publishRunEvent(owner, {
    runKind: 'workflow',
    runId: 'run-1',
    type: 'state.completed',
    data: { stateId: 'prompt' },
  });
  const auditEvent = await events.publishAuditEvent(owner, {
    scope: 'workflow:run-1',
    type: 'grant.allowed',
    data: { operation: 'agent.run' },
  });

  assertEquals(runEvent.stream, serviceRunEventStream('workflow', 'run-1'));
  assertEquals(auditEvent.stream, serviceAuditEventStream('workflow:run-1'));

  const runReader = events.observeRunEvents({ ownerId: 'owner-1' }, 'workflow', 'run-1').getReader();
  const auditReader = events.observeAuditEvents({ ownerId: 'owner-1' }, 'workflow:run-1').getReader();
  const replayedRun = await runReader.read();
  const replayedAudit = await auditReader.read();
  await runReader.cancel();
  await auditReader.cancel();

  assertEquals(replayedRun.value, runEvent);
  assertEquals(replayedAudit.value, auditEvent);
});
