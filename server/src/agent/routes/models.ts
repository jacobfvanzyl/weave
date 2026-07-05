import { defineRoute } from '../../server/routes';
import { agentService } from '../service';
export type { ModelOption } from '../model-options';

export const modelRoutes = [
  defineRoute('/agent/models', {
    method: 'GET',
    handler: async (c) => c.json(await agentService.listModels()),
  }),
];
