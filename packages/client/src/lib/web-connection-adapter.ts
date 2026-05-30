import type { ConnectionAdapter, ConnectionInput, ConnectionSettings, ConnectionTestResult } from './connection-types';

type PersistedWebConnectionSettings = {
  mastraUrl?: string;
  authToken?: string | null;
};

const WEB_CONNECTION_STORAGE_KEY = 'weave.connection.v1';
const DEFAULT_MASTRA_URL = 'http://localhost:4111';
const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};

const hasProtocol = (value: string) => /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value);

const trimToken = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed || undefined;
};

const getDefaultMastraUrl = () => {
  if (typeof window === 'undefined') return DEFAULT_MASTRA_URL;
  return `${window.location.protocol}//${window.location.hostname}:4111`;
};

const normalizeMastraUrl = (input?: string) => {
  const trimmed = input?.trim() || DEFAULT_MASTRA_URL;
  const withProtocol = hasProtocol(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withProtocol);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Weave server URL must use http or https.');
  }

  if (url.username || url.password) {
    throw new Error('Weave server URL must not include credentials.');
  }

  url.hash = '';
  url.search = '';

  return url.toString().replace(/\/+$/, '');
};

const getBuildAuthToken = () => {
  if (typeof __WEAVE_AUTH_TOKEN__ === 'string') return trimToken(__WEAVE_AUTH_TOKEN__);
  return trimToken(viteEnv.VITE_WEAVE_AUTH_TOKEN);
};

const getBuildMastraUrl = () => normalizeMastraUrl(viteEnv.VITE_MASTRA_URL ?? getDefaultMastraUrl());

const getStorage = () => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

const readPersistedSettings = (): PersistedWebConnectionSettings => {
  const storage = getStorage();
  if (!storage) return {};

  try {
    const parsed = JSON.parse(storage.getItem(WEB_CONNECTION_STORAGE_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as PersistedWebConnectionSettings
      : {};
  } catch {
    return {};
  }
};

const writePersistedSettings = (settings: PersistedWebConnectionSettings) => {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(WEB_CONNECTION_STORAGE_KEY, JSON.stringify(settings));
};

const getAuthToken = (settings = readPersistedSettings()) => {
  if (typeof settings.authToken === 'string') return trimToken(settings.authToken);
  if (settings.authToken === null) return undefined;
  return getBuildAuthToken();
};

const getSettings = (): ConnectionSettings => {
  const persisted = readPersistedSettings();
  return {
    mastraUrl: normalizeMastraUrl(persisted.mastraUrl ?? getBuildMastraUrl()),
    hasAuthToken: Boolean(getAuthToken(persisted)),
  };
};

const saveSettings = (input: ConnectionInput): ConnectionSettings => {
  const persisted = readPersistedSettings();
  persisted.mastraUrl = normalizeMastraUrl(input.mastraUrl);

  if (Object.hasOwn(input, 'authToken')) {
    const authToken = trimToken(input.authToken);
    persisted.authToken = authToken ?? null;
  }

  writePersistedSettings(persisted);
  return getSettings();
};

const testConnection = async (input?: ConnectionInput): Promise<ConnectionTestResult> => {
  try {
    const savedSettings = getSettings();
    const mastraUrl = normalizeMastraUrl(input?.mastraUrl ?? savedSettings.mastraUrl);
    const authToken = Object.hasOwn(input ?? {}, 'authToken') ? trimToken(input?.authToken) : getAuthToken();
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
    const response = await fetch(`${mastraUrl}/chat-state/me`, { headers });

    if (!response.ok) {
      const error = (await response.text()).trim();
      return { ok: false, status: response.status, error: error || `HTTP ${response.status}` };
    }

    const data = await response.json() as { user?: { id?: unknown; name?: unknown } };
    if (typeof data.user?.id !== 'string' || typeof data.user.name !== 'string') {
      return { ok: false, error: 'Connection response did not include a valid user.' };
    }

    return { ok: true, user: { id: data.user.id, name: data.user.name } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' };
  }
};

export const createWebConnectionAdapter = (): ConnectionAdapter => ({
  getSettings,
  saveSettings,
  testConnection,
  getClientAuthToken: () => getAuthToken() ?? null,
});
