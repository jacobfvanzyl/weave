export const mastraUrl = import.meta.env.VITE_MASTRA_URL ?? 'http://localhost:4111';
export const agentId = import.meta.env.VITE_AGENT_ID ?? 'mage-hand';
export const chatUrl = `${mastraUrl}/chat`;

const authToken = import.meta.env.VITE_WEAVE_AUTH_TOKEN;

export const getAuthHeaders = (): Record<string, string> => {
  if (!authToken) return {};
  return { Authorization: `Bearer ${authToken}` };
};
