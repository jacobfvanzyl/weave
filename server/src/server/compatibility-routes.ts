import { chatgptAuthRoutes } from '../agent/routes/chatgpt-auth';
import { modelRoutes } from '../agent/routes/models';
import { profileRoutes } from '../agent/routes/profiles';
import { promptRoutes } from '../agent/routes/prompts';
import { chatRoutes } from '../modules/chat/routes/chat';
import { chatStateRoutes } from '../modules/chat/routes/chat-state';
import { editorRoutes } from '../modules/code/routes/editor';
import { projectRoutes } from '../modules/code/routes/projects';
import { terminalRoutes } from '../modules/code/routes/terminals';
import { vaultRoutes } from '../modules/notes/routes/vault';
import { portalRoutes } from '../portal/routes/portals';
import { windowSessionRoutes } from '../portal/routes/window-sessions';
import { mountRoute, type RouteDefinition } from './routes';
import type { WeaveApp } from './types';

const replacePrefix = (path: string, from: string, to: string) =>
  path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : undefined;

const aliasRoutes = (app: WeaveApp, routes: RouteDefinition[], aliasPath: (canonicalPath: string) => string | undefined) => {
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

export const registerCompatibilityRoutes = (app: WeaveApp) => {
  aliasRoutes(app, chatStateRoutes, chatStateAlias);
  aliasRoutes(app, chatRoutes, chatRunAlias);
  aliasRoutes(app, projectRoutes, codeProjectAlias);
  aliasRoutes(app, editorRoutes, path => replacePrefix(path, '/code/editor', '/editor'));
  aliasRoutes(app, terminalRoutes, path => replacePrefix(path, '/code/terminals', '/terminals'));
  aliasRoutes(app, vaultRoutes, path => replacePrefix(path, '/notes/vault', '/vault'));
  aliasRoutes(app, profileRoutes, path => replacePrefix(path, '/agent/profiles', '/profiles'));
  aliasRoutes(app, promptRoutes, path => replacePrefix(path, '/agent/prompts', '/prompts'));
  aliasRoutes(app, modelRoutes, path => replacePrefix(path, '/agent/models', '/models'));
  aliasRoutes(app, chatgptAuthRoutes, path => replacePrefix(path, '/agent/chatgpt', '/chatgpt'));
  aliasRoutes(app, portalRoutes, path => replacePrefix(path, '/portal', '/portals'));
  aliasRoutes(app, windowSessionRoutes, path => replacePrefix(path, '/portal/window-sessions', '/window-sessions'));
};

export const __compatibilityRoutesTest = {
  chatRunAlias,
  chatStateAlias,
  codeProjectAlias,
  replacePrefix,
};
