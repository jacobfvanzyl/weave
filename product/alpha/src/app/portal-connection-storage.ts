import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { DEFAULT_PORTAL_ADDRESS } from '@/portal-address';

export const DEFAULT_PORTAL_URL = DEFAULT_PORTAL_ADDRESS;

export type PersistedPortalConnection = {
  hostUrl: string;
  accessToken: string;
};

interface PortalConnectionPreferences {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
}

const PORTAL_CONNECTION_STORAGE_KEY = 'weave.portal.connection.v1';

const parseConnection = (value: string | null): PersistedPortalConnection | undefined => {
  if (!value) return undefined;

  try {
    const candidate = JSON.parse(value) as unknown;
    if (
      !candidate
      || typeof candidate !== 'object'
      || !('hostUrl' in candidate)
      || !('accessToken' in candidate)
      || typeof candidate.hostUrl !== 'string'
      || typeof candidate.accessToken !== 'string'
      || !candidate.hostUrl
      || !candidate.accessToken
    ) {
      return undefined;
    }

    return {
      hostUrl: candidate.hostUrl,
      accessToken: candidate.accessToken,
    };
  } catch {
    return undefined;
  }
};

export async function loadPortalConnection(
  platform = Capacitor.getPlatform(),
  preferences: PortalConnectionPreferences = Preferences,
) {
  if (platform !== 'ios') return undefined;

  try {
    const { value } = await preferences.get({ key: PORTAL_CONNECTION_STORAGE_KEY });
    return parseConnection(value);
  } catch {
    return undefined;
  }
}

export async function savePortalConnection(
  connection: PersistedPortalConnection,
  platform = Capacitor.getPlatform(),
  preferences: PortalConnectionPreferences = Preferences,
) {
  if (platform !== 'ios') return;

  await preferences.set({
    key: PORTAL_CONNECTION_STORAGE_KEY,
    value: JSON.stringify(connection),
  });
}
