import { type AgentContribution, listAgentContributions, registerAgentContribution } from './contributions';
import { mastra } from './mastra/index';
import { registerAgentRoutes } from './routes';
import { type AgentService, agentService } from './service';

export type AgentCore = {
  mastra: typeof mastra;
  service: AgentService;
  registerRoutes: typeof registerAgentRoutes;
  registerContribution: typeof registerAgentContribution;
  listContributions: typeof listAgentContributions;
};

export const agentCore: AgentCore = {
  mastra,
  service: agentService,
  registerRoutes: registerAgentRoutes,
  registerContribution: registerAgentContribution,
  listContributions: listAgentContributions,
};

export { type AgentContribution, agentService, listAgentContributions, mastra, registerAgentContribution };
export { contextUsageRecallOptions, estimateContextTokens, estimateMemoryContextTokens } from './service';
export type { AgentRunEvent, AgentRunRequest, AgentRunSnapshot, AgentRunStatus, AgentService } from './service';
export type { ModelConfig, ModelOption } from './model-options';
