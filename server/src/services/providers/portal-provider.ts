import type { PortalConnection } from '../../portal/registry';
import { parsePortalToolArgs, portalToolNameSchema } from '@weave/protocol';
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
  executionProfile?: 'observe' | 'workspace' | 'host';
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
    executionProfile: value.executionProfile === 'observe' || value.executionProfile === 'host'
      ? value.executionProfile
      : value.executionProfile === 'workspace'
      ? 'workspace'
      : undefined,
  };
};

const defaultRootId = (portal: PortalConnection) => portal.roots[0]?.id;

export const portalToolScope = (target: PortalToolTarget): ServiceScope =>
  serviceLocatorScope('portal-target', {
    ...(target.portalId ? { portalId: target.portalId } : {}),
    ...(target.projectId ? { projectId: target.projectId } : {}),
    ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
    ...(target.rootId ? { rootId: target.rootId } : {}),
    ...(target.repoPath ? { repoPath: target.repoPath } : {}),
    ...(target.workspacePath ? { workspacePath: target.workspacePath } : {}),
    ...(target.executionProfile ? { executionProfile: target.executionProfile } : {}),
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
    idempotencyKey?: string;
  }) {
    const target = this.resolveTarget(input.caller, input.scope);
    const tool = portalToolNameSchema.parse(input.toolId);
    const args = parsePortalToolArgs(tool, input.args);
    return requestPortalTool({
      portalId: target.portalId,
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      rootId: target.rootId,
      repoPath: target.repoPath,
      workspacePath: target.workspacePath,
      executionProfile: target.executionProfile,
      tool,
      args,
      timeoutMs: input.timeoutMs,
      idempotencyKey: input.idempotencyKey,
    });
  }
}
