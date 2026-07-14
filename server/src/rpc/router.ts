import type { RpcPeer } from '@weave/protocol/peer';
import { rpcMethodNameSchema } from '@weave/protocol';
import type { OwnerContext } from '../owner/context.ts';

export type RpcSessionRole = 'client' | 'portal';

export type RpcClientSession = {
  role: 'client';
  connectionId: string;
  peer: RpcPeer;
  ownerContext: OwnerContext;
  clientId: string;
  capabilities: string[];
  lifetimeSignal: AbortSignal;
};

export type RpcPortalSession = {
  role: 'portal';
  connectionId: string;
  peer: RpcPeer;
  ownerContext: OwnerContext;
  portalId: string;
  capabilities: string[];
  lifetimeSignal: AbortSignal;
};

export type RpcSession = RpcClientSession | RpcPortalSession;

export type RpcHandlerContext = {
  session: RpcSession;
  signal: AbortSignal;
};

export type RpcServerHandler = (
  params: unknown,
  context: RpcHandlerContext,
) => unknown | Promise<unknown>;

type HandlerRegistration = {
  roles: ReadonlySet<RpcSessionRole>;
  handler: RpcServerHandler;
};

export class RpcRouter {
  private readonly handlers = new Map<string, HandlerRegistration>();

  register(
    method: string,
    roles: RpcSessionRole | RpcSessionRole[],
    handler: RpcServerHandler,
  ) {
    rpcMethodNameSchema.parse(method);
    if (this.handlers.has(method)) {
      throw new Error(`RPC server method already registered: ${method}`);
    }
    this.handlers.set(method, {
      roles: new Set(Array.isArray(roles) ? roles : [roles]),
      handler,
    });
  }

  attach(session: RpcSession) {
    const disposers: Array<() => void> = [];
    for (const [method, registration] of this.handlers) {
      if (!registration.roles.has(session.role)) continue;
      disposers.push(
        session.peer.register(
          method,
          (params, context) => registration.handler(params, { session, signal: context.signal }),
        ),
      );
    }
    return () => disposers.forEach((dispose) => dispose());
  }

  listMethods(role?: RpcSessionRole) {
    return [...this.handlers.entries()]
      .filter(([, registration]) => !role || registration.roles.has(role))
      .map(([method]) => method)
      .sort();
  }
}
