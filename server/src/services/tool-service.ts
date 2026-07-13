import type { ServiceBindingRepository, ServiceProviderKind } from './bindings';
import type { PortalToolTarget, ResolvedPortalToolTarget } from './providers/portal-provider';
import { PortalProvider, portalToolScope } from './providers/portal-provider';
import { StubProvider } from './providers/stub-providers';
import type { ServiceCaller, ServiceGrant, ServiceResult, ServiceScope } from './types';
import { requireServiceGrant, serviceAudit, ServiceError, serviceErrorResult, serviceOk } from './types';

export type ToolInvocation = {
  caller: ServiceCaller;
  toolId: string;
  scope: ServiceScope;
  input: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
  grants?: ServiceGrant[];
};

export interface ToolService {
  invoke<T = unknown>(input: ToolInvocation): Promise<T>;
  invokeResult<T = unknown>(input: ToolInvocation): Promise<ServiceResult<T>>;
  resolvePortalTarget(caller: ServiceCaller, scope: ServiceScope): Promise<ResolvedPortalToolTarget>;
  requestPortal(input: {
    caller: ServiceCaller;
    scope?: ServiceScope;
    target?: PortalToolTarget;
    tool: string;
    args: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
    grants?: ServiceGrant[];
  }): Promise<unknown>;
  portalToolRequester(caller: ServiceCaller, target?: PortalToolTarget): (input: {
    portalId: string;
    projectId?: string;
    workspaceId?: string;
    rootId?: string;
    repoPath?: string;
    workspacePath?: string;
    tool: string;
    args: unknown;
    timeoutMs?: number;
  }) => Promise<unknown>;
}

type ProviderRegistry = {
  portal: PortalProvider;
  client: StubProvider;
  server: StubProvider;
  external: StubProvider;
};

const portalLocatorTypes = new Set(['portal', 'portal-target']);
const portalToolAliases = new Set(['read', 'write', 'edit', 'bash']);

const providerForTool = (toolId: string): ServiceProviderKind => {
  if (toolId.startsWith('portal.')) return 'portal';
  if (portalToolAliases.has(toolId)) return 'portal';
  return 'server';
};

const providerForInvocation = (toolId: string, scope: ServiceScope): ServiceProviderKind => {
  if (scope.ref.kind === 'locator' && portalLocatorTypes.has(scope.ref.locatorType)) return 'portal';
  return providerForTool(toolId);
};

export class DefaultToolService implements ToolService {
  constructor(
    private readonly bindings: ServiceBindingRepository,
    private readonly providers: ProviderRegistry,
  ) {}

  async invoke<T = unknown>(input: ToolInvocation): Promise<T> {
    const result = await this.invokeResult<T>(input);
    if (!result.ok) {
      throw new ServiceError(result.error.code, result.error.message, result.error.status, result.error.details);
    }
    return result.value;
  }

  async invokeResult<T = unknown>(input: ToolInvocation): Promise<ServiceResult<T>> {
    const audit = [];

    try {
      requireServiceGrant(input.grants, { service: 'tool', operation: input.toolId, scope: input.scope });

      audit.push(serviceAudit({
        service: 'tool',
        operation: input.toolId,
        caller: input.caller,
        scope: input.scope,
        provider: providerForInvocation(input.toolId, input.scope),
        status: 'allowed',
      }));

      const { providerKind, scope } = await this.resolveProviderScope(input.caller, input.scope, input.toolId);
      const provider = this.providers[providerKind];
      if (!provider) throw new ServiceError('provider_not_found', `No provider registered for ${providerKind}.`, 501);
      const value = await provider.invokeTool({
        caller: input.caller,
        scope,
        toolId: input.toolId,
        args: input.input,
        timeoutMs: input.timeoutMs,
        idempotencyKey: input.idempotencyKey,
      }) as T;
      audit.push(serviceAudit({
        service: 'tool',
        operation: input.toolId,
        caller: input.caller,
        scope,
        provider: providerKind,
        status: 'ok',
      }));
      return serviceOk(value, audit);
    } catch (error) {
      audit.push(serviceAudit({
        service: 'tool',
        operation: input.toolId,
        caller: input.caller,
        scope: input.scope,
        provider: providerForInvocation(input.toolId, input.scope),
        status: error instanceof ServiceError && error.code === 'permission_denied' ? 'denied' : 'error',
        message: error instanceof Error ? error.message : String(error),
      }));
      return serviceErrorResult(error, audit);
    }
  }

  async resolvePortalTarget(caller: ServiceCaller, scope: ServiceScope) {
    const { providerKind, scope: resolvedScope } = await this.resolveProviderScope(caller, scope, 'portal.resolve');
    if (providerKind !== 'portal') {
      throw new ServiceError('invalid_scope', 'Scope does not resolve to a Portal provider.', 400);
    }
    return this.providers.portal.resolveTarget(caller, resolvedScope);
  }

  async requestPortal(input: {
    caller: ServiceCaller;
    scope?: ServiceScope;
    target?: PortalToolTarget;
    tool: string;
    args: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
    grants?: ServiceGrant[];
  }) {
    return this.invoke({
      caller: input.caller,
      toolId: input.tool,
      scope: input.scope ?? portalToolScope(input.target ?? {}),
      input: input.args,
      timeoutMs: input.timeoutMs,
      idempotencyKey: input.idempotencyKey,
      grants: input.grants,
    });
  }

  portalToolRequester(caller: ServiceCaller, target?: PortalToolTarget) {
    return (input: {
      portalId: string;
      projectId?: string;
      workspaceId?: string;
      rootId?: string;
      repoPath?: string;
      workspacePath?: string;
      tool: string;
      args: unknown;
      timeoutMs?: number;
    }) =>
      this.requestPortal({
        caller,
        target: {
          ...target,
          portalId: input.portalId,
          projectId: input.projectId ?? target?.projectId,
          workspaceId: input.workspaceId ?? target?.workspaceId,
          rootId: input.rootId ?? target?.rootId,
          repoPath: input.repoPath ?? target?.repoPath,
          workspacePath: input.workspacePath ?? target?.workspacePath,
        },
        tool: input.tool,
        args: input.args,
        timeoutMs: input.timeoutMs,
      });
  }

  private async resolveProviderScope(caller: ServiceCaller, scope: ServiceScope, toolId: string): Promise<{
    providerKind: ServiceProviderKind;
    scope: ServiceScope;
  }> {
    if (scope.ref.kind !== 'binding') return { providerKind: providerForInvocation(toolId, scope), scope };

    const binding = await this.bindings.get(caller, scope.ref.bindingId);
    if (!binding) throw new ServiceError('binding_not_found', 'Service binding was not found.', 404);
    return {
      providerKind: binding.providerKind,
      scope: {
        ref: {
          kind: 'locator',
          locatorType: binding.scopeKind,
          value: binding.data,
        },
      },
    };
  }
}
