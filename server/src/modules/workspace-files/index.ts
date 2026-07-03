import { mountRoute } from '../../server/routes';
import type { ServerModule } from '../types';
import { workspaceFileRoutes } from './routes';

export const workspaceFilesModule: ServerModule = {
  id: 'workspace-files',
  registerRoutes: app => {
    for (const route of workspaceFileRoutes) mountRoute(app, route);
  },
};
