import { mountRoute } from '../server/routes';
import type { WeaveApp } from '../server/types';
import type { SessionService } from '../services/session-service';
import { startPortalRealtimeServer } from './realtime';
import { portalRoutes } from './routes/portals';
import { createWindowSessionRoutes } from './routes/window-sessions';

type PortalRouteServices = {
  mastra: import('@mastra/core/mastra').Mastra;
  sessions?: SessionService;
};

export const registerPortalRoutes = (app: WeaveApp, services: PortalRouteServices) => {
  for (const route of portalRoutes) mountRoute(app, route);
  for (const route of createWindowSessionRoutes({ sessions: services.sessions })) mountRoute(app, route);
  startPortalRealtimeServer(services.mastra);
};
