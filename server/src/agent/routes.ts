import { listAgentContributions } from './contributions';
import { mountRoute } from '../server/routes';
import type { WeaveApp } from '../server/types';
import { chatgptAuthRoutes } from './routes/chatgpt-auth';
import { modelRoutes } from './routes/models';
import { profileRoutes } from './routes/profiles';
import { promptRoutes } from './routes/prompts';

export const registerAgentRoutes = (app: WeaveApp) => {
  for (const route of profileRoutes) mountRoute(app, route);
  for (const route of promptRoutes) mountRoute(app, route);
  for (const route of modelRoutes) mountRoute(app, route);
  for (const route of chatgptAuthRoutes) mountRoute(app, route);
  app.get('/agent/tools', c => c.json({ contributions: listAgentContributions() }));
};
