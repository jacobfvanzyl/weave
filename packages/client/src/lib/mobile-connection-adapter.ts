import { Preferences } from '@capacitor/preferences';
import type { ConnectionAdapter, ConnectionInput, ConnectionSettings, ConnectionTestResult } from './connection-types';
import { testRpcConnection } from './mastra-client';

type PersistedMobileConnectionSettings = {
  mastraUrl?: string;
  authToken?: string | null;
};

const MOBILE_CONNECTION_STORAGE_KEY = 'weave.connection.v1';
const DEFAULT_MASTRA_URL = 'http://localhost:4111';
const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | boolean | undefined> }).env ?? {};
const processEnv = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } })
  .process?.env ?? {};

const hasProtocol = (value: string) => /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value);

const trimToken = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed || undefined;
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
  return trimToken(
    typeof viteEnv.VITE_WEAVE_AUTH_TOKEN === 'string'
      ? viteEnv.VITE_WEAVE_AUTH_TOKEN
      : processEnv.VITE_WEAVE_AUTH_TOKEN,
  );
};

const getBuildMastraUrl = () => normalizeMastraUrl(
  typeof viteEnv.VITE_MASTRA_URL === 'string'
    ? viteEnv.VITE_MASTRA_URL
    : processEnv.VITE_MASTRA_URL ?? DEFAULT_MASTRA_URL,
);

const isTruthyEnvFlag = (value: unknown) => value === true || value === 'true' || value === '1';

const isDevConnectionOverride = () =>
  (isTruthyEnvFlag(viteEnv.DEV) || isTruthyEnvFlag(processEnv.DEV))
  && (viteEnv.VITE_WEAVE_DEV_CONNECTION_OVERRIDE === '1' || processEnv.VITE_WEAVE_DEV_CONNECTION_OVERRIDE === '1');

let cachedPersistedSettings: PersistedMobileConnectionSettings | undefined;
let cachedAuthToken: string | undefined = getBuildAuthToken();

const getAuthToken = (settings = cachedPersistedSettings) => {
  const buildAuthToken = getBuildAuthToken();
  if (isDevConnectionOverride() && buildAuthToken) return buildAuthToken;
  if (typeof settings?.authToken === 'string') return trimToken(settings.authToken);
  if (settings?.authToken === null) return undefined;
  return buildAuthToken;
};

const coercePersistedSettings = (value: unknown): PersistedMobileConnectionSettings =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as PersistedMobileConnectionSettings
    : {};

const readPersistedSettings = async (): Promise<PersistedMobileConnectionSettings> => {
  if (cachedPersistedSettings) return cachedPersistedSettings;

  try {
    const { value } = await Preferences.get({ key: MOBILE_CONNECTION_STORAGE_KEY });
    cachedPersistedSettings = coercePersistedSettings(JSON.parse(value ?? '{}') as unknown);
  } catch {
    cachedPersistedSettings = {};
  }

  cachedAuthToken = getAuthToken(cachedPersistedSettings);
  return cachedPersistedSettings;
};

const writePersistedSettings = async (settings: PersistedMobileConnectionSettings) => {
  cachedPersistedSettings = settings;
  cachedAuthToken = getAuthToken(settings);
  await Preferences.set({ key: MOBILE_CONNECTION_STORAGE_KEY, value: JSON.stringify(settings) });
};

const getSettings = async (): Promise<ConnectionSettings> => {
  const persisted = await readPersistedSettings();
  return {
    mastraUrl: isDevConnectionOverride()
      ? getBuildMastraUrl()
      : normalizeMastraUrl(persisted.mastraUrl ?? getBuildMastraUrl()),
    hasAuthToken: Boolean(getAuthToken(persisted)),
  };
};

const saveSettings = async (input: ConnectionInput): Promise<ConnectionSettings> => {
  const persisted = await readPersistedSettings();
  persisted.mastraUrl = normalizeMastraUrl(input.mastraUrl);

  if (Object.hasOwn(input, 'authToken')) {
    const authToken = trimToken(input.authToken);
    persisted.authToken = authToken ?? null;
  }

  await writePersistedSettings(persisted);
  return getSettings();
};

const testConnection = async (input?: ConnectionInput): Promise<ConnectionTestResult> => {
  try {
    const savedSettings = await getSettings();
    const mastraUrl = normalizeMastraUrl(input?.mastraUrl ?? savedSettings.mastraUrl);
    const authToken = Object.hasOwn(input ?? {}, 'authToken') ? trimToken(input?.authToken) : getAuthToken();
    if (!authToken) return { ok: false, error: 'Authentication token is required.' };
    const data = await testRpcConnection(mastraUrl, authToken);
    const user = data.owner;
    if (typeof user?.id !== 'string' || typeof user.name !== 'string') {
      return { ok: false, error: 'Connection response did not include a valid owner.' };
    }

    return { ok: true, user: { id: user.id, name: user.name } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' };
  }
};

export const createMobileConnectionAdapter = (): ConnectionAdapter => ({
  getSettings,
  saveSettings,
  testConnection,
  getClientAuthToken: () => cachedAuthToken ?? null,
});
