import { listAgentContributions, registerAgentContribution, type AgentContribution } from './contributions';
import { mastra } from './mastra/index';
import { registerAgentRoutes } from './routes';

export type AgentCore = {
  mastra: typeof mastra;
  registerRoutes: typeof registerAgentRoutes;
  registerContribution: typeof registerAgentContribution;
  listContributions: typeof listAgentContributions;
};

export const agentCore: AgentCore = {
  mastra,
  registerRoutes: registerAgentRoutes,
  registerContribution: registerAgentContribution,
  listContributions: listAgentContributions,
};

export { listAgentContributions, mastra, registerAgentContribution, type AgentContribution };
