export type AgentToolContribution = {
  id: string;
  description?: string;
};

export type AgentProfileContribution = {
  id: string;
  description?: string;
};

export type AgentPromptContribution = {
  id: string;
  description?: string;
};

export type AgentSourceProviderContribution = {
  id: string;
  description?: string;
};

export type AgentRuntimeContextProviderContribution = {
  id: string;
  description?: string;
};

export type AgentMemoryPolicyHintContribution = {
  id: string;
  description?: string;
};

export type AgentContribution = {
  moduleId: string;
  tools?: AgentToolContribution[];
  profiles?: AgentProfileContribution[];
  prompts?: AgentPromptContribution[];
  sources?: AgentSourceProviderContribution[];
  runtimeContextProviders?: AgentRuntimeContextProviderContribution[];
  memoryPolicyHints?: AgentMemoryPolicyHintContribution[];
};

const contributions = new Map<string, AgentContribution>();

export const registerAgentContribution = (contribution: AgentContribution) => {
  if (!contribution.moduleId.trim()) throw new Error('Agent contribution moduleId is required.');
  contributions.set(contribution.moduleId, contribution);
};

export const listAgentContributions = () => [...contributions.values()];
