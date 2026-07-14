import { RpcPeer, type RpcSocket } from '@weave/protocol/peer';
import { connectPortalRpc, disconnectPortalRpc } from '../../portal/registry.ts';
import { callerForOwner, ServiceError } from '../types.ts';
import { PortalProvider, portalToolScope } from './portal-provider.ts';

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

const socket = (): RpcSocket => ({
  readyState: WebSocket.OPEN,
  bufferedAmount: 0,
  send: (_data: string) => undefined,
  close: (_code?: number, _reason?: string) => undefined,
});

Deno.test('PortalProvider treats explicit portalId scopes as exact targets', () => {
  const peer = new RpcPeer(socket());
  connectPortalRpc({
    portalId: 'provider-test-portal-2',
    userId: 'owner-1',
    peer,
    capabilities: ['portal.fs.read'],
    roots: [{ id: 'default' }],
  });
  try {
    const provider = new PortalProvider();
    const caller = callerForOwner('owner-1', 'workflow');

    assertEquals(provider.resolveTarget(caller, portalToolScope({})).portalId, 'provider-test-portal-2');
    const error = assertThrowsServiceError(
      () => provider.resolveTarget(caller, portalToolScope({ portalId: 'provider-test-portal-1' })),
      'provider_offline',
    );
    assertEquals(error.status, 400);
  } finally {
    disconnectPortalRpc('provider-test-portal-2', peer);
  }
});
