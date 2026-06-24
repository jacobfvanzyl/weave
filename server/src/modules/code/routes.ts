import { editorRoutes } from '../../mastra/routes/editor';
import { projectRoutes } from '../../mastra/routes/projects';
import { terminalRoutes } from '../../mastra/routes/terminals';
import { mountRoutes, replacePrefix } from '../../server/route-adapter';
import { registerAgentContribution } from '../../agent/contributions';
import type { ServerModule } from '../types';

registerAgentContribution({ moduleId: 'code' });

const projectCanonicalPath = (path: string) => {
  if (path === '/projects/resolve-workspace') return '/code/workspaces/resolve';
  if (path.startsWith('/portals')) return undefined;
  return replacePrefix(path, '/projects', '/code/projects');
};

export const codeModule: ServerModule = {
  id: 'code',
  registerRoutes: app => {
    mountRoutes(app, projectRoutes.filter(route => !route.path.startsWith('/portals')), projectCanonicalPath);
    mountRoutes(app, editorRoutes, path => replacePrefix(path, '/editor', '/code/editor'));
    mountRoutes(app, terminalRoutes, path => replacePrefix(path, '/terminals', '/code/terminals'));
  },
};
