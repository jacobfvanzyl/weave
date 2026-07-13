import { DefaultWorkflowServiceRuntime, type WorkflowServiceContext } from './service-runtime.ts';
import type { AgentRunRequest, AgentService } from '../agent/index.ts';
import type { AttachmentPayload } from '../modules/attachments/storage.ts';
import type { EventService, ResourceService, ToolService } from '../services/index.ts';
import { type ServiceCaller, serviceLocatorScope, serviceResourceScope, serviceScopeNone } from '../services/types.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const assertRejects = async (operation: () => unknown | Promise<unknown>, expectedMessage: string) => {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expectedMessage)) {
      throw new Error(`Expected error message to include ${expectedMessage}, received ${message}`);
    }
    return;
  }
  throw new Error('Expected operation to reject.');
};

const baseContext = (grants: WorkflowServiceContext['grants']): WorkflowServiceContext => ({
  ownerId: 'owner-1',
  workflowRunId: 'workflow-run-1',
  requestId: 'request-1',
  grants,
});

const createRuntime = (deps: {
  agents?: Partial<AgentService>;
  tools?: Partial<ToolService>;
  resources?: Partial<ResourceService>;
  events?: Partial<EventService>;
}) =>
  new DefaultWorkflowServiceRuntime(
    deps.agents as AgentService,
    deps.tools as ToolService,
    deps.resources as ResourceService,
    deps.events as EventService,
  );

Deno.test('WorkflowServiceRuntime starts agent runs with workflow caller, memory, and grants', async () => {
  let captured: AgentRunRequest | undefined;
  const runtime = createRuntime({
    agents: {
      startRun: async (input: AgentRunRequest) => {
        captured = input;
        return {
          runId: 'agent-run-1',
          agentId: input.agentId ?? 'mage-hand',
          status: 'running',
          createdAt: '2026-07-05T00:00:00.000Z',
          updatedAt: '2026-07-05T00:00:00.000Z',
        };
      },
    },
  });

  const snapshot = await runtime.startAgentRun(
    baseContext([{ service: 'agent', operation: 'agent.run', scope: serviceResourceScope('agent', 'mage-hand') }]),
    { input: { prompt: 'Summarize this' } },
  );

  assertEquals(snapshot.runId, 'agent-run-1');
  assertEquals(captured?.caller, {
    kind: 'workflow',
    ownerId: 'owner-1',
    correlation: { requestId: 'request-1', workflowRunId: 'workflow-run-1' },
  });
  assertEquals(captured?.agentId, 'mage-hand');
  assertEquals(captured?.memory, { scope: 'workflow', workflowRunId: 'workflow-run-1' });
});

Deno.test('WorkflowServiceRuntime rejects ungranted agent operations before delegation', async () => {
  let invoked = false;
  const runtime = createRuntime({
    agents: {
      runPrompt: async () => {
        invoked = true;
        return {};
      },
    },
  });

  await assertRejects(
    () => runtime.runAgentPrompt(baseContext([]), { input: 'Run this' }),
    'not granted',
  );
  assertEquals(invoked, false);
});

Deno.test('WorkflowServiceRuntime exposes agent capabilities and models through grants', async () => {
  const runtime = createRuntime({
    agents: {
      listCapabilities: async () => ({ runLifecycle: { runPrompt: true } }),
      listModels: async () => ({ defaultModel: 'openai/gpt-5.5', options: [] }),
    },
  });
  const context = baseContext([
    { service: 'agent', operation: 'agent.capabilities', scope: serviceScopeNone() },
    { service: 'agent', operation: 'agent.models', scope: serviceScopeNone() },
  ]);

  assertEquals(await runtime.listAgentCapabilities(context), { runLifecycle: { runPrompt: true } });
  assertEquals(await runtime.listAgentModels(context), { defaultModel: 'openai/gpt-5.5', options: [] });
});

Deno.test('WorkflowServiceRuntime invokes tools with explicit scope grants', async () => {
  const scope = serviceLocatorScope('portal-target', { portalId: 'portal-1', workspacePath: '/repo' });
  let captured: unknown;
  const runtime = createRuntime({
    tools: {
      invoke: async <T>(input: Parameters<ToolService['invoke']>[0]) => {
        captured = input;
        return { ok: true } as T;
      },
    },
  });
  const context = baseContext([{ service: 'tool', operation: 'portal.fs.read', scope }]);

  const result = await runtime.invokeTool(context, {
    toolId: 'portal.fs.read',
    scope,
    input: { path: 'README.md' },
  });

  assertEquals(result, { ok: true });
  assertEquals((captured as { caller?: ServiceCaller }).caller?.kind, 'workflow');
  assertEquals((captured as { scope?: unknown }).scope, scope);
  assertEquals((captured as { grants?: unknown }).grants, context.grants);
});

Deno.test('WorkflowServiceRuntime routes resources and events through workflow callers', async () => {
  const calls: unknown[] = [];
  const runtime = createRuntime({
    resources: {
      putAttachment: async (caller: ServiceCaller, input: AttachmentPayload) => {
        calls.push({ kind: 'putAttachment', caller, input });
        return {
          id: 'att-1',
          urlPath: '/attachments/att-1',
          mimeType: input.mimeType,
          sizeBytes: 1,
          originalName: input.originalName,
        };
      },
      getAttachment: async () => null,
      findAttachmentsByThread: async () => [],
      findAttachmentsByOriginalName: async () => [],
      deleteAttachment: async () => undefined,
    },
    events: {
      publishRunEvent: async (caller, input) => {
        calls.push({ kind: 'publishRunEvent', caller, input });
        return {
          id: 'evt-1',
          ownerId: caller.ownerId,
          stream: `workflow-run:${input.runId}`,
          type: input.type,
          data: input.data,
          createdAt: '2026-07-05T00:00:00.000Z',
          sequence: 1,
        };
      },
    },
  });
  const context = baseContext([
    { service: 'resource', operation: 'attachment.put', scope: serviceScopeNone() },
    { service: 'event', operation: 'runEvent.publish', scope: serviceResourceScope('workflow-run', 'workflow-run-1') },
  ]);

  await runtime.putAttachment(context, {
    bytes: new Uint8Array([1]),
    mimeType: 'text/plain',
    originalName: 'note.txt',
  });
  const event = await runtime.publishWorkflowRunEvent(context, { type: 'state.completed', data: { stateId: 'agent' } });

  assertEquals(event.stream, 'workflow-run:workflow-run-1');
  assertEquals((calls[0] as { caller: ServiceCaller }).caller.kind, 'workflow');
  assertEquals((calls[1] as { caller: ServiceCaller }).caller.correlation?.workflowRunId, 'workflow-run-1');
  assert((calls[0] as { input: AttachmentPayload }).input.bytes instanceof Uint8Array, 'expected attachment bytes');
});
