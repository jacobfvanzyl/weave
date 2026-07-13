import { chatgptAuthRoutes } from '../agent/routes/chatgpt-auth';
import { modelRoutes } from '../agent/routes/models';
import { promptRoutes } from '../agent/routes/prompts';
import type { AgentService } from '../agent/service';
import { createChatRoutes } from '../modules/chat/routes/chat';
import { createChatStateRoutes } from '../modules/chat/routes/chat-state';
import { projectRoutes } from '../modules/code/routes/projects';
import { terminalRoutes } from '../modules/code/routes/terminals';
import { portalRoutes } from '../portal/routes/portals';
import { createWindowSessionRoutes } from '../portal/routes/window-sessions';
import type { ResourceService } from '../services/resource-service';
import type { SessionService } from '../services/session-service';
import { mountRoute, type RouteDefinition } from './routes';
import type { WeaveApp } from './types';

type CompatibilityRouteServices = {
  agent: AgentService;
  resources: Pick<ResourceService, 'findAttachmentsByThread' | 'putAttachment'>;
  sessions?: SessionService;
};

const replacePrefix = (path: string, from: string, to: string) =>
  path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : undefined;

const aliasRoutes = (
  app: WeaveApp,
  routes: RouteDefinition[],
  aliasPath: (canonicalPath: string) => string | undefined,
) => {
  for (const route of routes) {
    const canonicalPath = aliasPath(route.path);
    if (canonicalPath) mountRoute(app, route, { canonicalPath });
  }
};

const chatRunAlias = (path: string) => {
  if (path === '/chat/runs') return '/chat';
  if (path === '/chat/runs/:threadId') return '/chat/:threadId/run';
  if (path === '/chat/runs/:threadId/cancel') return '/chat/:threadId/cancel';
  if (path === '/chat/runs/:threadId/steer') return '/chat/:threadId/steer';
  if (path === '/chat/runs/:threadId/stream') return '/chat/:threadId/stream';
  if (path === '/chat/runs/:threadId/resume') return '/chat/:threadId/resume';
  if (path === '/chat/runs/:threadId/tool-approvals/:toolCallId') {
    return '/chat/:threadId/tool-approvals/:toolCallId';
  }
  return undefined;
};

const chatStateAlias = (path: string) => {
  if (path === '/owner/me') return '/chat-state/me';
  return replacePrefix(path, '/chat/threads', '/chat-state/threads');
};

const codeProjectAlias = (path: string) => {
  if (path === '/code/workspaces/resolve') return '/projects/resolve-workspace';
  return replacePrefix(path, '/code/projects', '/projects');
};

export const registerCompatibilityRoutes = (app: WeaveApp, services: CompatibilityRouteServices) => {
  aliasRoutes(app, createChatStateRoutes(services.agent), chatStateAlias);
  aliasRoutes(app, createChatRoutes(services.agent, services.resources), chatRunAlias);
  aliasRoutes(app, projectRoutes, codeProjectAlias);
  aliasRoutes(app, terminalRoutes, (path) => replacePrefix(path, '/code/terminals', '/terminals'));
  aliasRoutes(app, promptRoutes, (path) => replacePrefix(path, '/agent/prompts', '/prompts'));
  aliasRoutes(app, modelRoutes, (path) => replacePrefix(path, '/agent/models', '/models'));
  aliasRoutes(app, chatgptAuthRoutes, (path) => replacePrefix(path, '/agent/chatgpt', '/chatgpt'));
  aliasRoutes(app, portalRoutes, (path) => replacePrefix(path, '/portal', '/portals'));
  aliasRoutes(
    app,
    createWindowSessionRoutes({ sessions: services.sessions }),
    (path) => replacePrefix(path, '/portal/window-sessions', '/window-sessions'),
  );
};

export const __compatibilityRoutesTest = {
  chatRunAlias,
  chatStateAlias,
  codeProjectAlias,
  replacePrefix,
};
