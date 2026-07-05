import { mountRoute } from '../../server/routes';
import type { ServerModule } from '../types';
import { getNotesVaultBackend } from '../notes/storage/registry';
import { createServicePortalNotesVaultBackend } from '../notes/storage/portal-backend';
import { createWorkspaceFileRoutes } from './routes';

export const workspaceFilesModule: ServerModule = {
  id: 'workspace-files',
  registerRoutes: (app, services) => {
    const workspaceFileRoutes = createWorkspaceFileRoutes({
      tools: services.internal.tools,
      sessions: services.internal.sessions,
      getBackend: (kind) =>
        kind === 'portal' ? createServicePortalNotesVaultBackend(services.internal.tools) : getNotesVaultBackend(kind),
    });
    for (const route of workspaceFileRoutes) mountRoute(app, route);
  },
};
