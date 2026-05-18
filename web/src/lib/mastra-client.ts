const defaultMastraUrl = `${window.location.protocol}//${window.location.hostname}:4111`;
export const mastraUrl = import.meta.env.VITE_MASTRA_URL ?? defaultMastraUrl;
export const agentId = import.meta.env.VITE_AGENT_ID ?? 'mage-hand';
export const chatUrl = `${mastraUrl}/chat`;

const authToken = import.meta.env.VITE_WEAVE_AUTH_TOKEN;

export const getAuthHeaders = (): Record<string, string> => {
  if (!authToken) return {};
  return { Authorization: `Bearer ${authToken}` };
};
