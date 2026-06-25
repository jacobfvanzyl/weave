import { mountRoute } from '../../server/routes';
import type { ServerModule } from '../types';
import { attachmentRoutes } from './routes/attachments';

export const attachmentsModule: ServerModule = {
  id: 'attachments',
  registerRoutes: app => {
    for (const route of attachmentRoutes) mountRoute(app, route);
  },
};
