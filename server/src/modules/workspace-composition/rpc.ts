import { guarded, recordParams, requiredString } from '../../rpc/handlers.ts';
import { type WorkspaceCompositionService, workspaceCompositionService } from './service.ts';

type CompositionService = Pick<WorkspaceCompositionService, 'getOrCreate'>;
type WorkspaceCompositionRpcHandler = (
  params: Record<string, unknown>,
  context: {
    session: { ownerContext: { owner: { id: string } } };
  },
) => unknown | Promise<unknown>;

export type WorkspaceCompositionRpcRouter = {
  registerValidated(
    method: 'workspace.composition.get',
    role: 'client',
    handler: WorkspaceCompositionRpcHandler,
  ): void;
};

export const registerWorkspaceCompositionRpcMethods = (
  router: WorkspaceCompositionRpcRouter,
  service: CompositionService = workspaceCompositionService,
) => {
  router.registerValidated('workspace.composition.get', 'client', (params, context) => {
    const body = recordParams(params);
    return guarded(async () => ({
      composition: await service.getOrCreate(
        context.session.ownerContext.owner.id,
        requiredString(body.projectId, 'projectId'),
        requiredString(body.workspaceId, 'workspaceId'),
      ),
    }));
  });
};
