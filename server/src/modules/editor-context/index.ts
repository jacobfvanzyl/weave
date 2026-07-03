import { mountRoute } from '../../server/routes';
import type { ServerModule } from '../types';
import { editorContextRoutes } from './routes';

export const editorContextModule: ServerModule = {
  id: 'editor-context',
  registerRoutes: app => {
    for (const route of editorContextRoutes) mountRoute(app, route);
  },
};
