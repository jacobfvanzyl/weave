export type AgentContribution = {
  moduleId: string;
  tools?: Record<string, unknown>;
  profiles?: unknown[];
  prompts?: unknown[];
  sources?: unknown[];
  runtimeContextProviders?: unknown[];
  memoryPolicyHints?: unknown[];
};

const contributions = new Map<string, AgentContribution>();

export const registerAgentContribution = (contribution: AgentContribution) => {
  if (!contribution.moduleId.trim()) throw new Error('Agent contribution moduleId is required.');
  contributions.set(contribution.moduleId, contribution);
};

export const listAgentContributions = () => [...contributions.values()];
