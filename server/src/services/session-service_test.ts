import { DefaultSessionService } from './session-service.ts';
import type { ToolInvocation, ToolService } from './tool-service.ts';
import type { ResolvedPortalToolTarget } from './providers/portal-provider.ts';
import { callerForOwner, ServiceError, serviceLocatorScope } from './types.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const assertRejectsServiceError = async (operation: () => unknown | Promise<unknown>, code: string) => {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    assertEquals(error.code, code);
    return error;
  }
  throw new Error('Expected operation to reject.');
};

Deno.test('SessionService denies ungranted session operations before resolving providers', async () => {
  let resolved = false;
  const tools: ToolService = {
    invoke: <T = unknown>(_input: ToolInvocation) => Promise.resolve(undefined as T),
    invokeResult: <T = unknown>(_input: ToolInvocation) => Promise.resolve({ ok: true, value: undefined as T }),
    resolvePortalTarget: () => {
      resolved = true;
      throw new Error('Should not resolve Portal target.');
    },
    requestPortal: () => Promise.resolve({ ok: true }),
    portalToolRequester: () => () => Promise.resolve({ ok: true }),
  };
  const sessions = new DefaultSessionService(tools);
  const scope = serviceLocatorScope('portal-target', { portalId: 'portal-1' });

  await assertRejectsServiceError(
    () =>
      sessions.issueTerminalToken({
        caller: callerForOwner('owner-1', 'workflow'),
        scope,
        kind: 'workspace',
        grants: [{ service: 'tool', operation: 'portal.terminal.issue', scope }],
      }),
    'permission_denied',
  );
  assertEquals(resolved, false);
});

const createPortalTarget = (capabilities: string[]): ResolvedPortalToolTarget => ({
  portalId: 'portal-1',
  portal: {
    portalId: 'portal-1',
    userId: 'owner-1',
    capabilities,
    mounts: [],
    roots: [{ id: 'default' }],
    status: 'online',
    connectedAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
  },
});

Deno.test('SessionService routes window operations through the Portal provider', async () => {
  const requested: Array<{ tool: string; args: unknown; timeoutMs?: number }> = [];
  const target = createPortalTarget([
    'portal.window.session',
    'portal.window.list',
    'portal.applications.list',
    'portal.applications.open',
  ]);
  const tools: ToolService = {
    invoke: <T = unknown>(_input: ToolInvocation) => Promise.resolve(undefined as T),
    invokeResult: <T = unknown>(_input: ToolInvocation) => Promise.resolve({ ok: true, value: undefined as T }),
    resolvePortalTarget: () => Promise.resolve(target),
    requestPortal: (input) => {
      requested.push({ tool: input.tool, args: input.args, timeoutMs: input.timeoutMs });
      if (input.tool === 'portal.window.list') return Promise.resolve({ ok: true, windows: [{ id: 'window-1' }] });
      if (input.tool === 'portal.applications.list') {
        return Promise.resolve({ ok: true, applications: [{ id: 'app-1' }] });
      }
      return Promise.resolve({ ok: true, application: { id: 'app-1' } });
    },
    portalToolRequester: () => () => Promise.resolve({ ok: true }),
  };
  const sessions = new DefaultSessionService(tools);
  const caller = callerForOwner('owner-1', 'ui');
  const scope = serviceLocatorScope('portal-target', { portalId: 'portal-1' });

  assertEquals(await sessions.listWindows({ caller, scope, timeoutMs: 10_000 }), {
    ok: true,
    windows: [{ id: 'window-1' }],
    target,
  });
  assertEquals(await sessions.listApplications({ caller, scope, timeoutMs: 10_000 }), {
    ok: true,
    applications: [{ id: 'app-1' }],
    target,
  });
  assertEquals(await sessions.openApplication({ caller, scope, applicationId: 'app-1', timeoutMs: 15_000 }), {
    ok: true,
    application: { id: 'app-1' },
    target,
  });

  const session = await sessions.issueWindowSessionToken({ caller, scope, windowId: 'window-1' });
  assertEquals(session.target, target);
  assertEquals(session.token.startsWith('win_'), true);
  assertEquals(session.sessionId.startsWith('window_'), true);
  assertEquals(requested, [
    { tool: 'portal.window.list', args: {}, timeoutMs: 10_000 },
    { tool: 'portal.applications.list', args: {}, timeoutMs: 10_000 },
    { tool: 'portal.applications.open', args: { applicationId: 'app-1' }, timeoutMs: 15_000 },
  ]);
});

Deno.test('SessionService denies ungranted window sessions before resolving providers', async () => {
  let resolved = false;
  const tools: ToolService = {
    invoke: <T = unknown>(_input: ToolInvocation) => Promise.resolve(undefined as T),
    invokeResult: <T = unknown>(_input: ToolInvocation) => Promise.resolve({ ok: true, value: undefined as T }),
    resolvePortalTarget: () => {
      resolved = true;
      return Promise.resolve(createPortalTarget(['portal.window.session']));
    },
    requestPortal: () => Promise.resolve({ ok: true }),
    portalToolRequester: () => () => Promise.resolve({ ok: true }),
  };
  const sessions = new DefaultSessionService(tools);
  const scope = serviceLocatorScope('portal-target', { portalId: 'portal-1' });

  await assertRejectsServiceError(
    () =>
      sessions.issueWindowSessionToken({
        caller: callerForOwner('owner-1', 'workflow'),
        scope,
        grants: [{ service: 'session', operation: 'portal.window.list', scope }],
      }),
    'permission_denied',
  );
  assertEquals(resolved, false);
});
