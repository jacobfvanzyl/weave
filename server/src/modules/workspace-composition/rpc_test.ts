import { parseRpcRequestResult } from '@weave/protocol';
import { registerWorkspaceCompositionRpcMethods, type WorkspaceCompositionRpcRouter } from './rpc.ts';

Deno.test('workspace.composition.get resolves through the public module RPC seam', async () => {
  type Handler = Parameters<WorkspaceCompositionRpcRouter['registerValidated']>[2];
  const handlers = new Map<string, Handler>();
  const router: WorkspaceCompositionRpcRouter = {
    registerValidated: (method, _role, handler) => {
      handlers.set(method, handler);
    },
  };
  const getOrCreateCalls: unknown[] = [];

  registerWorkspaceCompositionRpcMethods(router, {
    getOrCreate: (ownerId, projectId, workspaceId) => {
      getOrCreateCalls.push({ ownerId, projectId, workspaceId });
      return Promise.resolve({
        workspaceId,
        schemaVersion: 1 as const,
        revision: 1,
        defaultPaneType: 'editor' as const,
        tabs: [{
          tabId: 'tab-1',
          name: 'New Tab',
          layout: { kind: 'empty' as const, layoutId: 'layout-1' },
          panes: [],
        }],
      });
    },
  });

  const rawResult = await handlers.get('workspace.composition.get')?.(
    { projectId: 'project-1', workspaceId: 'workspace-1' },
    { session: { ownerContext: { owner: { id: 'owner-1' } } } },
  );
  const result = parseRpcRequestResult(
    'client',
    'server',
    'workspace.composition.get',
    rawResult,
  );

  if (result.composition?.tabs[0]?.name !== 'New Tab') {
    throw new Error(`unexpected RPC result: ${JSON.stringify(result)}`);
  }
  if (
    JSON.stringify(getOrCreateCalls) !== JSON.stringify([{
      ownerId: 'owner-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
    }])
  ) {
    throw new Error(
      `unexpected service call: ${JSON.stringify(getOrCreateCalls)}`,
    );
  }
});
