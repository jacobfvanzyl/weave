import { DefaultSessionService } from './session-service.ts';
import type { ToolInvocation, ToolService } from './tool-service.ts';
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
