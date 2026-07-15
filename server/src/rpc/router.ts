import type { RpcPeer } from '@weave/protocol/peer';
import {
  parseRpcRequestResult,
  rpcAllowedSourceRoles,
  type RpcRequestMethod,
  type RpcRequestParams,
  type RpcRequestParsedParams,
  type RpcRequestResult,
  type RpcRequestSource,
} from '@weave/protocol';
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

type RpcServerMethod = RpcRequestMethod<RpcSessionRole, 'server'>;
type RpcServerSource<Method extends RpcServerMethod> = RpcRequestSource<'server', Method> & RpcSessionRole;

export type RpcHandlerContext<Method extends RpcServerMethod = RpcServerMethod> = {
  session: Extract<RpcSession, { role: RpcServerSource<Method> }>;
  signal: AbortSignal;
};

export type RpcServerHandler<Method extends RpcServerMethod = RpcServerMethod> = (
  params: RpcRequestParsedParams<RpcServerSource<Method>, 'server', Method>,
  context: RpcHandlerContext<Method>,
) => RpcRequestResult<RpcServerSource<Method>, 'server', Method> |
  Promise<RpcRequestResult<RpcServerSource<Method>, 'server', Method>>;

type HandlerRegistration = {
  roles: ReadonlySet<RpcSessionRole>;
  handler: (params: unknown, context: RpcHandlerContext) => unknown | Promise<unknown>;
};

export class RpcRouter {
  private readonly handlers = new Map<string, HandlerRegistration>();

  register<Method extends RpcServerMethod>(
    method: Method,
    roles: RpcServerSource<Method> | RpcServerSource<Method>[],
    handler: RpcServerHandler<Method>,
  ) {
    this.addRegistration(method, roles, handler);
  }

  registerValidated<Method extends RpcServerMethod>(
    method: Method,
    roles: RpcServerSource<Method> | RpcServerSource<Method>[],
    handler: (
      params: RpcRequestParsedParams<RpcServerSource<Method>, 'server', Method>,
      context: RpcHandlerContext<Method>,
    ) => unknown | Promise<unknown>,
  ) {
    this.addRegistration(method, roles, async (params, context) =>
      parseRpcRequestResult(
        context.session.role,
        'server',
        method,
        await handler(params, context),
      )
    );
  }

  private addRegistration<Method extends RpcServerMethod>(
    method: Method,
    roles: RpcServerSource<Method> | RpcServerSource<Method>[],
    handler: (
      params: RpcRequestParsedParams<RpcServerSource<Method>, 'server', Method>,
      context: RpcHandlerContext<Method>,
    ) => unknown | Promise<unknown>,
  ) {
    if (this.handlers.has(method)) {
      throw new Error(`RPC server method already registered: ${method}`);
    }
    const allowedRoles = rpcAllowedSourceRoles(method, 'server', 'request') as RpcSessionRole[];
    const declaredRoles = Array.isArray(roles) ? roles : [roles];
    if (
      allowedRoles.length !== declaredRoles.length ||
      allowedRoles.some((role) => !declaredRoles.includes(role as RpcServerSource<Method>))
    ) {
      throw new Error(`RPC roles for ${method} must match the protocol registry: ${allowedRoles.join(', ')}.`);
    }
    this.handlers.set(method, {
      roles: new Set(allowedRoles),
      handler: handler as unknown as HandlerRegistration['handler'],
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
