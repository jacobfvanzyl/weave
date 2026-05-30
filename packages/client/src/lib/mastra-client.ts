type MastraConnectionConfig = {
  mastraUrl?: string;
  authToken?: string | null;
};

const getDefaultMastraUrl = () => {
  if (typeof window === 'undefined') return 'http://localhost:4111';
  return `${window.location.protocol}//${window.location.hostname}:4111`;
};

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');
const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};

const initialMastraUrl = viteEnv.VITE_MASTRA_URL ?? getDefaultMastraUrl();
const initialAuthToken =
  typeof __WEAVE_AUTH_TOKEN__ === 'string' && __WEAVE_AUTH_TOKEN__.trim()
    ? __WEAVE_AUTH_TOKEN__.trim()
    : viteEnv.VITE_WEAVE_AUTH_TOKEN ?? null;

let connectionConfig = {
  mastraUrl: trimTrailingSlash(initialMastraUrl),
  authToken: initialAuthToken as string | null,
};

export const agentId = viteEnv.VITE_AGENT_ID ?? 'mage-hand';

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
