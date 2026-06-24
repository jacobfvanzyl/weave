import { modelRoutes } from '../../mastra/routes/models';
import { profileRoutes } from '../../mastra/routes/profiles';
import { promptRoutes } from '../../mastra/routes/prompts';
import { chatgptAuthRoutes } from '../../mastra/routes/chatgpt-auth';
import { mountRoutes, replacePrefix } from '../../server/route-adapter';
import { listAgentContributions, registerAgentContribution } from '../../agent/contributions';
import type { ServerModule } from '../types';

registerAgentContribution({ moduleId: 'agent' });

export const agentModule: ServerModule = {
  id: 'agent',
  registerRoutes: app => {
    mountRoutes(app, profileRoutes, path => replacePrefix(path, '/profiles', '/agent/profiles'));
    mountRoutes(app, promptRoutes, path => replacePrefix(path, '/prompts', '/agent/prompts'));
    mountRoutes(app, modelRoutes, path => replacePrefix(path, '/models', '/agent/models'));
    mountRoutes(app, chatgptAuthRoutes, path => replacePrefix(path, '/chatgpt', '/agent/chatgpt'));
    app.get('/agent/tools', c => c.json({ contributions: listAgentContributions() }));
  },
};
