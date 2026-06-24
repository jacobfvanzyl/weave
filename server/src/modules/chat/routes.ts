import { chatRoutes } from '../../mastra/routes/chat';
import { chatStateRoutes } from '../../mastra/routes/chat-state';
import { mountRoute, mountRoutes, replacePrefix } from '../../server/route-adapter';
import { ownerResponse } from '../../owner/auth';
import type { ServerModule } from '../types';

const chatStateCanonicalPath = (path: string) => {
  if (path === '/chat-state/me') return '/owner/me';
  return replacePrefix(path, '/chat-state/threads', '/chat/threads');
};

const chatRunCanonicalPath = (path: string) => {
  if (path === '/chat') return '/chat/runs';
  if (path === '/chat/:threadId/run') return '/chat/runs/:threadId';
  if (path === '/chat/:threadId/cancel') return '/chat/runs/:threadId/cancel';
  if (path === '/chat/:threadId/stream') return '/chat/runs/:threadId/stream';
  return undefined;
};

export const chatModule: ServerModule = {
  id: 'chat',
  registerRoutes: app => {
    app.get('/owner/me', c => c.json(ownerResponse(c.get('owner'))));
    mountRoutes(app, chatStateRoutes, chatStateCanonicalPath);
    mountRoutes(app, chatRoutes, chatRunCanonicalPath);
  },
};
