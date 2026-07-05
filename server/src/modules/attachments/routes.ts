import { mountRoute } from '../../server/routes';
import type { ServerModule } from '../types';
import { createAttachmentRoutes } from './routes/attachments';

export const attachmentsModule: ServerModule = {
  id: 'attachments',
  registerRoutes: (app, services) => {
    const attachmentRoutes = createAttachmentRoutes(services.internal.resources);
    for (const route of attachmentRoutes) mountRoute(app, route);
  },
};
