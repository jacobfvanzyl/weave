import { projectRoutes } from '../../mastra/routes/projects';
import { windowSessionRoutes } from '../../mastra/routes/window-sessions';
import { mountRoutes, replacePrefix } from '../../server/route-adapter';
import { registerAgentContribution } from '../../agent/contributions';
import { startPortalRealtimeServer } from './realtime';
import type { ServerModule } from '../types';

registerAgentContribution({ moduleId: 'portal' });

export const portalModule: ServerModule = {
  id: 'portal',
  registerRoutes: (app, services) => {
    mountRoutes(app, projectRoutes.filter(route => route.path.startsWith('/portals')), path =>
      replacePrefix(path, '/portals', '/portal'));
    mountRoutes(app, windowSessionRoutes, path => replacePrefix(path, '/window-sessions', '/portal/window-sessions'));
    startPortalRealtimeServer(services.mastra);
  },
};
