import { mountRoute } from '../../server/routes';
import { registerAgentContribution } from '../../agent/contributions';
import type { ServerModule } from '../types';
import { chatRoutes } from './routes/chat';
import { chatStateRoutes } from './routes/chat-state';

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
    for (const route of chatStateRoutes) mountRoute(app, route);
    for (const route of chatRoutes) mountRoute(app, route);
  },
};
