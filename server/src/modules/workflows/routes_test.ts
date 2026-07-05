import { Hono } from 'hono';
import { createOwnerAuthMiddleware } from '../../owner/auth.ts';
import { mountRoute } from '../../server/routes.ts';
import type { ServerVariables, WeaveApp } from '../../server/types.ts';
import type { WorkflowControlService } from '../../workflows/control-service.ts';
import type { WorkflowDefinition } from '../../workflows/definition.ts';
import type {
  StoredWorkflowDefinition,
  WorkflowRunEventRecord,
  WorkflowRunRecord,
} from '../../workflows/repository.ts';
import { createWorkflowRoutes } from './routes.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const definition = (): WorkflowDefinition => ({
  id: 'workflow-1',
  version: '1',
  name: 'Workflow',
  initialStateId: 'end',
  grants: [],
  states: {
    end: { type: 'end', result: 'done' },
  },
});

const storedDefinition = (ownerId = 'owner-1'): StoredWorkflowDefinition => ({
  ownerId,
  workflowId: 'workflow-1',
  version: '1',
  name: 'Workflow',
  createdAt: '2026-07-05T00:00:00.000Z',
  updatedAt: '2026-07-05T00:00:00.000Z',
  definition: definition(),
});

const runRecord = (ownerId = 'owner-1'): WorkflowRunRecord => ({
  ownerId,
  runId: 'run-1',
  workflowId: 'workflow-1',
  workflowVersion: '1',
  status: 'running',
  backend: 'direct',
  requestId: 'request-1',
  input: { prompt: 'Hello' },
  definition: definition(),
  createdAt: '2026-07-05T00:00:00.000Z',
  updatedAt: '2026-07-05T00:00:00.000Z',
  startedAt: '2026-07-05T00:00:00.000Z',
});

const runEventRecord = (overrides: Partial<WorkflowRunEventRecord> = {}): WorkflowRunEventRecord => ({
  ownerId: 'owner-1',
  runId: 'run-1',
  eventId: 'event-1',
  sequence: 1,
  type: 'workflow.run.started',
  data: { backend: 'direct' },
  createdAt: '2026-07-05T00:00:00.000Z',
  ...overrides,
});

const createTestApp = (service: WorkflowControlService) => {
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(
    '*',
    createOwnerAuthMiddleware({
      auth: {
        token: 'test-token',
        owner: { id: 'owner-1', name: 'Test Owner', role: 'owner' },
      },
      mastra: {} as ServerVariables['mastra'],
    }),
  );
  for (const route of createWorkflowRoutes(service)) mountRoute(app as WeaveApp, route);
  return app;
};

Deno.test('workflow routes require owner auth', async () => {
  const app = createTestApp({
    listDefinitions: () => Promise.resolve([]),
  } as unknown as WorkflowControlService);

  const response = await app.request('/workflows');
  assertEquals(response.status, 401);
});

Deno.test('workflow routes create and list workflow definitions for the authenticated owner', async () => {
  let saved: { ownerId?: string; definition?: WorkflowDefinition } = {};
  const service = {
    saveDefinition: (ownerId: string, nextDefinition: WorkflowDefinition) => {
      saved = { ownerId, definition: nextDefinition };
      return Promise.resolve(storedDefinition(ownerId));
    },
    listDefinitions: (ownerId: string) => Promise.resolve([storedDefinition(ownerId)]),
  } as unknown as WorkflowControlService;
  const app = createTestApp(service);

  const createResponse = await app.request('/workflows', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ definition: definition() }),
  });
  const createJson = await createResponse.json();

  const listResponse = await app.request('/workflows', {
    headers: { authorization: 'Bearer test-token' },
  });
  const listJson = await listResponse.json();

  assertEquals(createResponse.status, 201);
  assertEquals(saved.ownerId, 'owner-1');
  assertEquals(saved.definition?.id, 'workflow-1');
  assertEquals(createJson.workflow.workflowId, 'workflow-1');
  assertEquals(listResponse.status, 200);
  assertEquals(listJson.workflows.map((item: { workflowId: string }) => item.workflowId), ['workflow-1']);
});

Deno.test('workflow run route starts owner-scoped runs', async () => {
  let startInput: Record<string, unknown> | undefined;
  const service = {
    startRun: (input: Record<string, unknown>) => {
      startInput = input;
      return Promise.resolve(runRecord(String(input.ownerId)));
    },
  } as unknown as WorkflowControlService;
  const app = createTestApp(service);

  const response = await app.request('/workflows/workflow-1/runs', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ input: { prompt: 'Hello' }, requestId: 'request-1' }),
  });
  const json = await response.json();

  assertEquals(response.status, 202);
  assertEquals(startInput, {
    ownerId: 'owner-1',
    workflowId: 'workflow-1',
    input: { prompt: 'Hello' },
    requestId: 'request-1',
    runId: undefined,
  });
  assertEquals(json.run.runId, 'run-1');
});

Deno.test('workflow run cancel route delegates owner-scoped cancellation', async () => {
  let cancelled: { ownerId?: string; runId?: string } = {};
  const service = {
    cancelRun: (ownerId: string, runId: string) => {
      cancelled = { ownerId, runId };
      return Promise.resolve(
        {
          ...runRecord(ownerId),
          runId,
          status: 'cancelled',
          error: { message: 'Workflow run was cancelled.' },
        } satisfies WorkflowRunRecord,
      );
    },
  } as unknown as WorkflowControlService;
  const app = createTestApp(service);

  const response = await app.request('/workflow-runs/run-1/cancel', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
  });
  const json = await response.json();

  assertEquals(response.status, 200);
  assertEquals(cancelled, { ownerId: 'owner-1', runId: 'run-1' });
  assertEquals(json.run.status, 'cancelled');
  assertEquals(json.run.error, { message: 'Workflow run was cancelled.' });
});

Deno.test('workflow run events route replays owner-scoped events', async () => {
  let replayInput: { ownerId?: string; runId?: string; afterSequence?: number; limit?: number } = {};
  const service = {
    listRunEvents: (ownerId: string, runId: string, options?: { afterSequence?: number; limit?: number }) => {
      replayInput = { ownerId, runId, ...options };
      return Promise.resolve([
        runEventRecord(),
        runEventRecord({
          eventId: 'event-2',
          sequence: 2,
          type: 'workflow.run.completed',
          data: 'done',
        }),
      ]);
    },
  } as unknown as WorkflowControlService;
  const app = createTestApp(service);

  const response = await app.request('/workflow-runs/run-1/events?afterSequence=1&limit=10', {
    headers: { authorization: 'Bearer test-token' },
  });
  const json = await response.json();

  assertEquals(response.status, 200);
  assertEquals(replayInput, { ownerId: 'owner-1', runId: 'run-1', afterSequence: 1, limit: 10 });
  assertEquals(json.events.map((event: { type: string }) => event.type), [
    'workflow.run.started',
    'workflow.run.completed',
  ]);
});
