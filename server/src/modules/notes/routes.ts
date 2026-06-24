import { vaultRoutes } from '../../mastra/routes/vault';
import { mountRoutes, replacePrefix } from '../../server/route-adapter';
import { registerAgentContribution } from '../../agent/contributions';
import type { ServerModule } from '../types';

registerAgentContribution({ moduleId: 'notes' });

export const notesModule: ServerModule = {
  id: 'notes',
  registerRoutes: app => {
    mountRoutes(app, vaultRoutes, path => replacePrefix(path, '/vault', '/notes/vault'));
  },
};
