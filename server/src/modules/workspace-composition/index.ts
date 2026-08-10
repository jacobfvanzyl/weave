import type { ServerModule } from '../types.ts';
import { registerWorkspaceCompositionRpcMethods } from './rpc.ts';

export const workspaceCompositionModule: ServerModule = {
  id: 'workspace-composition',
  registerRpc: (router) => registerWorkspaceCompositionRpcMethods(router),
};
