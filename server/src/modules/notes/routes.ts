import { mountRoute } from '../../server/routes';
import { registerAgentContribution } from '../../agent/contributions';
import type { ServerModule } from '../types';
import { productProjectRoutes } from '../code/routes/projects';

const notesProjectPath = (path: string) =>
  path === '/code/projects' ? '/notes/projects'
    : path.startsWith('/code/projects/') ? `/notes/projects${path.slice('/code/projects'.length)}`
    : undefined;

registerAgentContribution({
  moduleId: 'notes',
  tools: [
    { id: 'file_index', description: 'Index the current Notes workspace files.' },
    { id: 'file_read', description: 'Read files from the current Notes workspace, including Markdown and .cpr documents.' },
    { id: 'file_write', description: 'Write files in the current Notes workspace, including Markdown and .cpr documents.' },
    { id: 'file_mkdir', description: 'Create folders in the current Notes workspace.' },
    { id: 'file_move', description: 'Move files or folders in the current Notes workspace.' },
    { id: 'file_delete', description: 'Delete files or folders in the current Notes workspace.' },
    { id: 'file_upload', description: 'Upload attachments into the current Notes workspace.' },
  ],
  sources: [
    { id: 'notes.workspace-files.context', description: 'Notes workspace-file context resolved through the configured notes storage backend.' },
  ],
});

export const notesModule: ServerModule = {
  id: 'notes',
  registerRoutes: app => {
    for (const route of productProjectRoutes) {
      const canonicalPath = notesProjectPath(route.path);
      if (canonicalPath) mountRoute(app, route, { canonicalPath });
    }
  },
};
