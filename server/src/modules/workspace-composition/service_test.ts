import type { Project } from '../../products/types.ts';
import { WorkspaceCompositionService } from './service.ts';

const project = (ownerId: string): Project => ({
  id: 'project-1',
  userId: ownerId,
  name: 'Project',
  projectKind: 'git',
  workspaces: [{
    id: 'workspace-1',
    projectId: 'project-1',
    workspaceKind: 'primary',
    name: 'Workspace',
    status: 'ready',
    createdAt: '2026-08-10T12:00:00.000Z',
    updatedAt: '2026-08-10T12:00:00.000Z',
  }],
  createdAt: '2026-08-10T12:00:00.000Z',
  updatedAt: '2026-08-10T12:00:00.000Z',
});

Deno.test('WorkspaceCompositionService get-or-creates only an owner-scoped persisted Workspace', async () => {
  const getOrCreateScopes: string[] = [];
  const service = new WorkspaceCompositionService(
    {
      get: (ownerId, projectId) =>
        Promise.resolve(
          ownerId === 'owner-1' && projectId === 'project-1' ? project(ownerId) : undefined,
        ),
    },
    {
      getOrCreate: (ownerId, workspaceId) => {
        getOrCreateScopes.push(`${ownerId}:${workspaceId}`);
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
    },
  );

  const composition = await service.getOrCreate('owner-1', 'project-1', 'workspace-1');
  if (composition.tabs[0]?.name !== 'New Tab') throw new Error('expected default Workspace Tab');
  if (
    JSON.stringify(getOrCreateScopes) !==
      JSON.stringify(['owner-1:workspace-1'])
  ) {
    throw new Error(
      `unexpected persistence scope: ${JSON.stringify(getOrCreateScopes)}`,
    );
  }

  for (
    const [projectId, workspaceId] of [
      ['project-missing', 'workspace-1'],
      ['project-1', 'workspace-missing'],
    ]
  ) {
    try {
      await service.getOrCreate('owner-1', projectId, workspaceId);
      throw new Error('expected missing Workspace to reject');
    } catch (error) {
      const failure = error as Error & { status?: number };
      if (failure.status !== 404 || failure.message !== 'Workspace was not found.') throw error;
    }
  }
});
