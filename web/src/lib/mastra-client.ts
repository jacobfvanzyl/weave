type MastraConnectionConfig = {
  mastraUrl?: string;
  authToken?: string | null;
};

const getDefaultMastraUrl = () => {
  if (typeof window === 'undefined') return 'http://localhost:4111';
  return `${window.location.protocol}//${window.location.hostname}:4111`;
};

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const initialMastraUrl = import.meta.env.VITE_MASTRA_URL ?? getDefaultMastraUrl();
const initialAuthToken = import.meta.env.VITE_WEAVE_AUTH_TOKEN ?? null;

let connectionConfig = {
  mastraUrl: trimTrailingSlash(initialMastraUrl),
  authToken: initialAuthToken as string | null,
};

export const agentId = import.meta.env.VITE_AGENT_ID ?? 'mage-hand';

export const configureMastraConnection = (config: MastraConnectionConfig) => {
  connectionConfig = {
    mastraUrl: config.mastraUrl ? trimTrailingSlash(config.mastraUrl) : connectionConfig.mastraUrl,
    authToken: Object.hasOwn(config, 'authToken') ? config.authToken ?? null : connectionConfig.authToken,
  };
};

export const getMastraUrl = () => connectionConfig.mastraUrl;

export const getChatUrl = () => `${getMastraUrl()}/chat`;

export const getAuthHeaders = (): Record<string, string> => {
  if (!connectionConfig.authToken) return {};
  return { Authorization: `Bearer ${connectionConfig.authToken}` };
};
