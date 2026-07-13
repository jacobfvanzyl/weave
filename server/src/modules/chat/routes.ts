import { mountRoute } from '../../server/routes';
import { registerAgentContribution } from '../../agent/contributions';
import { contributionDescription } from '../../instructions/contribution-instructions';
import type { ServerModule } from '../types';
import { productProjectRoutes } from '../code/routes/projects';

const chatProjectPath = (path: string) =>
  path === '/code/projects'
    ? '/chat/projects'
    : path.startsWith('/code/projects/')
    ? `/chat/projects${path.slice('/code/projects'.length)}`
    : undefined;

registerAgentContribution({
  moduleId: 'chat',
  runtimeContextProviders: [
    { id: 'chat.thread', description: contributionDescription('chat.thread') },
  ],
  memoryPolicyHints: [
    { id: 'chat.context-window', description: contributionDescription('chat.context-window') },
  ],
});

export const chatModule: ServerModule = {
  id: 'chat',
  registerInternalRoutes: (app) => {
    for (const route of productProjectRoutes) {
      const canonicalPath = chatProjectPath(route.path);
      if (canonicalPath) mountRoute(app, route, { canonicalPath });
    }
  },
};
