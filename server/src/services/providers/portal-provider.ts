import type { PortalConnection } from '../../portal/registry';
import {
  getPortalConnection,
  listPortalConnections,
  requestPortalTool,
  resolvePortalForTarget,
} from '../../portal/registry';
import type { JsonValue, ServiceCaller, ServiceScope } from '../types';
import { isJsonObject, optionalString, ServiceError, serviceLocatorScope } from '../types';

export type PortalToolTarget = {
  portalId?: string;
  projectId?: string;
  workspaceId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
};

export type ResolvedPortalToolTarget = PortalToolTarget & {
  portalId: string;
  portal: PortalConnection;
};

const portalLocatorTypes = new Set(['portal', 'portal-target']);

const jsonTargetToPortalTarget = (value: JsonValue): PortalToolTarget => {
  if (!isJsonObject(value)) throw new ServiceError('invalid_scope', 'Portal scope locator must be an object.', 400);
  return {
    portalId: optionalString(value.portalId),
    projectId: optionalString(value.projectId),
    workspaceId: optionalString(value.workspaceId),
    rootId: optionalString(value.rootId),
    repoPath: optionalString(value.repoPath),
    workspacePath: optionalString(value.workspacePath),
  };
};

const defaultRootId = (portal: PortalConnection) => {
  const firstRoot = Array.isArray(portal.roots)
    ? portal.roots.find((root): root is Record<string, unknown> => {
      if (!root || typeof root !== 'object' || Array.isArray(root)) return false;
      return typeof (root as Record<string, unknown>).id === 'string';
    })
    : undefined;
  return typeof firstRoot?.id === 'string' ? firstRoot.id : undefined;
};

export const portalToolScope = (target: PortalToolTarget): ServiceScope =>
  serviceLocatorScope('portal-target', {
    ...(target.portalId ? { portalId: target.portalId } : {}),
    ...(target.projectId ? { projectId: target.projectId } : {}),
    ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
    ...(target.rootId ? { rootId: target.rootId } : {}),
    ...(target.repoPath ? { repoPath: target.repoPath } : {}),
    ...(target.workspacePath ? { workspacePath: target.workspacePath } : {}),
  });

export class PortalProvider {
  readonly kind = 'portal' as const;

  listConnections(ownerId: string) {
    return listPortalConnections(ownerId);
  }

  getConnection(portalId: string) {
    return getPortalConnection(portalId);
  }

  resolveTarget(caller: ServiceCaller, scope: ServiceScope): ResolvedPortalToolTarget {
    if (scope.ref.kind !== 'locator' || !portalLocatorTypes.has(scope.ref.locatorType)) {
      throw new ServiceError('invalid_scope', 'Portal provider requires a portal locator scope.', 400);
    }

    const target = jsonTargetToPortalTarget(scope.ref.value);
    const portal = resolvePortalForTarget({
      userId: caller.ownerId,
      portalId: target.portalId,
      projectId: target.projectId,
      rootId: target.rootId,
      repoPath: target.repoPath,
      workspacePath: target.workspacePath,
    });
    if (!portal) throw new ServiceError('provider_offline', 'No online Portal is available for this scope.', 400);
    if (target.portalId && portal.portalId !== target.portalId) {
      throw new ServiceError('provider_offline', 'Requested Portal is offline or unavailable for this scope.', 400);
    }
    if (portal.userId !== caller.ownerId) {
      throw new ServiceError('permission_denied', 'Portal is not available for this owner.', 403);
    }

    return {
      ...target,
      portalId: portal.portalId,
      rootId: target.rootId ?? defaultRootId(portal),
      portal,
    };
  }

  async invokeTool(input: {
    caller: ServiceCaller;
    scope: ServiceScope;
    toolId: string;
    args: unknown;
    timeoutMs?: number;
  }) {
    const target = this.resolveTarget(input.caller, input.scope);
    return requestPortalTool({
      portalId: target.portalId,
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      rootId: target.rootId,
      repoPath: target.repoPath,
      workspacePath: target.workspacePath,
      tool: input.toolId,
      args: input.args,
      timeoutMs: input.timeoutMs,
    });
  }
}
