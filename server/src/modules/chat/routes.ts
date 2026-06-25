import { mountRoute } from '../../server/routes';
import { registerAgentContribution } from '../../agent/contributions';
import type { ServerModule } from '../types';
import { productProjectRoutes } from '../code/routes/projects';
import { chatRoutes } from './routes/chat';
import { chatStateRoutes } from './routes/chat-state';

const chatProjectPath = (path: string) =>
  path === '/code/projects' ? '/chat/projects'
    : path.startsWith('/code/projects/') ? `/chat/projects${path.slice('/code/projects'.length)}`
    : undefined;

registerAgentContribution({
  moduleId: 'chat',
  runtimeContextProviders: [
    { id: 'chat.thread', description: 'Thread metadata, selected profile, model, and run context.' },
  ],
  memoryPolicyHints: [
    { id: 'chat.context-window', description: 'Context-window and compaction policy for chat runs.' },
  ],
});

export const chatModule: ServerModule = {
  id: 'chat',
  registerRoutes: app => {
    for (const route of productProjectRoutes) {
      const canonicalPath = chatProjectPath(route.path);
      if (canonicalPath) mountRoute(app, route, { canonicalPath });
    }
    for (const route of chatStateRoutes) mountRoute(app, route);
    for (const route of chatRoutes) mountRoute(app, route);
  },
};
