import { mountRoute } from '../server/routes';
import type { WeaveApp } from '../server/types';
import { startPortalRealtimeServer } from './realtime';
import { portalRoutes } from './routes/portals';
import { windowSessionRoutes } from './routes/window-sessions';

type PortalRouteServices = {
  mastra: import('@mastra/core/mastra').Mastra;
};

export const registerPortalRoutes = (app: WeaveApp, services: PortalRouteServices) => {
  for (const route of portalRoutes) mountRoute(app, route);
  for (const route of windowSessionRoutes) mountRoute(app, route);
  startPortalRealtimeServer(services.mastra);
};
