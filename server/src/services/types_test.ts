import {
  requireServiceGrant,
  serviceBindingScope,
  serviceGrantAllows,
  serviceLocatorScope,
  serviceScopeEquals,
} from './types.ts';
import { ServiceError } from './types.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const assertThrowsServiceError = (operation: () => unknown, code: string) => {
  try {
    operation();
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    assertEquals(error.code, code);
    return error;
  }
  throw new Error('Expected operation to throw.');
};

Deno.test('serviceScopeEquals compares locator scopes structurally', () => {
  const left = serviceLocatorScope('portal-target', {
    portalId: 'portal-1',
    workspacePath: '/repo',
    nested: { b: true, a: 1 },
  });
  const right = serviceLocatorScope('portal-target', {
    nested: { a: 1, b: true },
    workspacePath: '/repo',
    portalId: 'portal-1',
  });

  assertEquals(serviceScopeEquals(left, right), true);
  assertEquals(serviceScopeEquals(left, serviceLocatorScope('portal-target', { portalId: 'portal-2' })), false);
});

Deno.test('serviceGrantAllows matches service operation and scope independently', () => {
  const scope = serviceBindingScope('workspace-binding');

  assertEquals(
    serviceGrantAllows(
      { service: 'tool', operation: 'portal.fs.read', scope },
      { service: 'tool', operation: 'portal.fs.read', scope: serviceBindingScope('workspace-binding') },
    ),
    true,
  );
  assertEquals(
    serviceGrantAllows(
      { service: 'tool', operation: 'portal.fs.read', scope },
      { service: 'tool', operation: 'portal.fs.write', scope },
    ),
    false,
  );
  assertEquals(
    serviceGrantAllows(
      { service: 'session', scope },
      { service: 'session', operation: 'portal.terminal.issue', scope },
    ),
    true,
  );
  assertEquals(
    serviceGrantAllows(
      { service: 'tool', operation: 'portal.fs.read' },
      { service: 'tool', operation: 'portal.fs.read', scope: serviceLocatorScope('portal-target', {}) },
    ),
    true,
  );
});

Deno.test('requireServiceGrant preserves allow-by-default and denies explicit empty grants', () => {
  const request = {
    service: 'session' as const,
    operation: 'portal.terminal.issue',
    scope: serviceBindingScope('workspace-binding'),
  };

  requireServiceGrant(undefined, request);
  const error = assertThrowsServiceError(() => requireServiceGrant([], request), 'permission_denied');
  assertEquals(error.status, 403);
});
