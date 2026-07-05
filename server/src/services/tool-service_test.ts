import { DefaultToolService } from './tool-service.ts';
import type { ServiceBinding, ServiceBindingRepository } from './bindings.ts';
import type { ServiceCaller, ServiceScope } from './types.ts';
import { callerForOwner, serviceBindingScope, serviceLocatorScope, serviceScopeNone } from './types.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
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

class MemoryBindings implements ServiceBindingRepository {
  bindings = new Map<string, ServiceBinding>();

  async get(caller: Pick<ServiceCaller, 'ownerId'>, bindingId: string) {
    const binding = this.bindings.get(`${caller.ownerId}:${bindingId}`);
    return binding;
  }

  async list(ownerId: string) {
    return [...this.bindings.values()].filter((binding) => binding.ownerId === ownerId);
  }

  async upsert(input: {
    ownerId: string;
    bindingId?: string;
    providerKind: ServiceBinding['providerKind'];
    scopeKind: string;
    data: ServiceBinding['data'];
  }) {
    const at = new Date().toISOString();
    const binding: ServiceBinding = {
      ownerId: input.ownerId,
      bindingId: input.bindingId ?? 'binding-test',
      providerKind: input.providerKind,
      scopeKind: input.scopeKind,
      data: input.data,
      createdAt: at,
      updatedAt: at,
    };
    this.bindings.set(`${binding.ownerId}:${binding.bindingId}`, binding);
    return binding;
  }

  async delete(caller: Pick<ServiceCaller, 'ownerId'>, bindingId: string) {
    return this.bindings.delete(`${caller.ownerId}:${bindingId}`);
  }
}

const createToolService = (
  handler: (input: {
    caller: ServiceCaller;
    scope: ServiceScope;
    toolId: string;
    args: unknown;
    timeoutMs?: number;
  }) => unknown | Promise<unknown>,
  bindings = new MemoryBindings(),
) =>
  new DefaultToolService(bindings, {
    portal: {
      invokeTool: handler,
      resolveTarget: () => {
        throw new Error('resolveTarget not needed');
      },
    },
    client: { invokeTool: handler },
    server: { invokeTool: handler },
    external: { invokeTool: handler },
  } as any);

Deno.test('ToolService routes portal locator scopes without putting toolId into the scope', async () => {
  const caller = callerForOwner('owner-1', 'workflow', { workflowRunId: 'wf-run-1' });
  let received: { toolId?: string; scope?: ServiceScope; args?: unknown } = {};
  const tools = createToolService((input) => {
    received = { toolId: input.toolId, scope: input.scope, args: input.args };
    return { ok: true };
  });

  const scope = serviceLocatorScope('portal-target', { portalId: 'portal-1', workspacePath: '/repo' });
  const result = await tools.invoke({ caller, toolId: 'read', scope, input: { path: 'README.md' } });

  assertEquals(result, { ok: true });
  assertEquals(received.toolId, 'read');
  assertEquals(received.scope, scope);
  assertEquals(received.args, { path: 'README.md' });
});

Deno.test('ToolService resolves opaque bindings before provider invocation', async () => {
  const bindings = new MemoryBindings();
  await bindings.upsert({
    ownerId: 'owner-1',
    bindingId: 'workspace-binding',
    providerKind: 'portal',
    scopeKind: 'portal-target',
    data: { portalId: 'portal-1', workspacePath: '/repo' },
  });
  let receivedScope: ServiceScope | undefined;
  const tools = createToolService((input) => {
    receivedScope = input.scope;
    return { ok: true };
  }, bindings);

  await tools.invoke({
    caller: callerForOwner('owner-1', 'workflow'),
    toolId: 'portal.fs.read',
    scope: serviceBindingScope('workspace-binding'),
    input: { path: 'README.md' },
  });

  assertEquals(receivedScope, serviceLocatorScope('portal-target', { portalId: 'portal-1', workspacePath: '/repo' }));
});

Deno.test('ToolService denies ungranted operations before provider invocation', async () => {
  let invoked = false;
  const tools = createToolService(() => {
    invoked = true;
    return { ok: true };
  });

  await assertRejects(
    () =>
      tools.invoke({
        caller: callerForOwner('owner-1', 'workflow'),
        toolId: 'portal.fs.write',
        scope: serviceLocatorScope('portal-target', { portalId: 'portal-1' }),
        input: { path: 'README.md', content: 'changed' },
        grants: [{ service: 'tool', operation: 'portal.fs.read', scope: serviceScopeNone() }],
      }),
    'not granted',
  );
  assertEquals(invoked, false);
});

Deno.test('ToolService returns denied audit for ungranted invokeResult calls', async () => {
  let invoked = false;
  const tools = createToolService(() => {
    invoked = true;
    return { ok: true };
  });

  const result = await tools.invokeResult({
    caller: callerForOwner('owner-1', 'workflow'),
    toolId: 'portal.fs.write',
    scope: serviceLocatorScope('portal-target', { portalId: 'portal-1' }),
    input: { path: 'README.md', content: 'changed' },
    grants: [{ service: 'tool', operation: 'portal.fs.read' }],
  });

  assertEquals(invoked, false);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, 'permission_denied');
  assertEquals(result.audit?.map((event) => event.status), ['denied']);
});
