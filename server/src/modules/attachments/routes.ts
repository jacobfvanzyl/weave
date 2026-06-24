import { attachmentRoutes } from '../../mastra/routes/attachments';
import { mountRoute } from '../../server/route-adapter';
import type { ServerModule } from '../types';

export const attachmentsModule: ServerModule = {
  id: 'attachments',
  registerRoutes: app => {
    for (const route of attachmentRoutes) mountRoute(app, route);
  },
};
