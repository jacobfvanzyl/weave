import { mountRoute } from '../../server/routes';
import { registerAgentContribution } from '../../agent/contributions';
import type { ServerModule } from '../types';
import { vaultRoutes } from './routes/vault';

registerAgentContribution({
  moduleId: 'notes',
  tools: [
    { id: 'vault_index', description: 'Index the current Notes vault.' },
    { id: 'vault_read', description: 'Read notes from the current Notes vault.' },
    { id: 'vault_write', description: 'Write notes in the current Notes vault.' },
    { id: 'vault_mkdir', description: 'Create folders in the current Notes vault.' },
    { id: 'vault_move', description: 'Move notes or folders in the current Notes vault.' },
    { id: 'vault_delete', description: 'Delete notes or folders in the current Notes vault.' },
    { id: 'vault_upload', description: 'Upload attachments into the current Notes vault.' },
  ],
  sources: [
    { id: 'notes.vault.context', description: 'Notes vault context resolved through the configured notes storage backend.' },
  ],
});

export const notesModule: ServerModule = {
  id: 'notes',
  registerRoutes: app => {
    for (const route of vaultRoutes) mountRoute(app, route);
  },
};
