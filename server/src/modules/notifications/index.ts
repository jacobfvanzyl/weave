import { mountRoute } from '../../server/routes';
import type { ServerModule } from '../types';
import { notificationRoutes } from './routes';

export const notificationsModule: ServerModule = {
  id: 'notifications',
  registerRoutes: (app) => {
    for (const route of notificationRoutes) mountRoute(app, route);
  },
};

export { publishServerNotification } from './service';
export type { ServerNotificationInput, WeaveNotificationEvent } from './types';
