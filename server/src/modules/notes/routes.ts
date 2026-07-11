import { mountRoute } from '../../server/routes';
import { registerAgentContribution } from '../../agent/contributions';
import { contributionDescription } from '../../instructions/contribution-instructions';
import { toolDescription } from '../../instructions/tool-instructions';
import type { ServerModule } from '../types';
import { productProjectRoutes } from '../code/routes/projects';
import { createNotesJupyterRoutes } from './jupyter-routes';

const notesProjectPath = (path: string) =>
  path === '/code/projects'
    ? '/notes/projects'
    : path.startsWith('/code/projects/')
    ? `/notes/projects${path.slice('/code/projects'.length)}`
    : undefined;

registerAgentContribution({
  moduleId: 'notes',
  tools: [
    { id: 'file_index', description: toolDescription('file_index') },
    { id: 'file_read', description: toolDescription('file_read') },
    { id: 'file_write', description: toolDescription('file_write') },
    { id: 'file_mkdir', description: toolDescription('file_mkdir') },
    { id: 'file_move', description: toolDescription('file_move') },
    { id: 'file_delete', description: toolDescription('file_delete') },
    { id: 'file_upload', description: toolDescription('file_upload') },
  ],
  sources: [
    {
      id: 'notes.workspace-files.context',
      description: contributionDescription('notes.workspace-files.context'),
    },
  ],
});

export const notesModule: ServerModule = {
  id: 'notes',
  registerRoutes: (app, services) => {
    for (const route of productProjectRoutes) {
      const canonicalPath = notesProjectPath(route.path);
      if (canonicalPath) mountRoute(app, route, { canonicalPath });
    }
    for (
      const route of createNotesJupyterRoutes({
        sessions: services.internal.sessions,
        tools: services.internal.tools,
      })
    ) {
      mountRoute(app, route);
    }
  },
};
