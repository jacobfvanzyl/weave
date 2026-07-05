import { agentService } from '../../agent';

export const hasActiveThreadRun = (resourceId: string | undefined, threadId: string | undefined) =>
  agentService.hasActiveThreadRun(resourceId, threadId);
