import { Preferences } from '@capacitor/preferences';

export type PersistedPortalConnection = {
  hostId: string;
  displayName: string;
  hostUrl: string;
  credentialId: string;
  keyId: string;
};

export type PersistedPortalConnections = {
  connections: PersistedPortalConnection[];
  selectedHostId?: string;
};

interface PortalConnectionPreferences {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
}

const PORTAL_CONNECTION_STORAGE_KEY = 'weave.portal.connections.v2';

const connection = (value: unknown): PersistedPortalConnection | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  const fields = ['hostId', 'displayName', 'hostUrl', 'credentialId', 'keyId'] as const;
  if (fields.some((field) => typeof input[field] !== 'string' || !input[field])) return;
  return Object.fromEntries(fields.map((field) => [field, input[field]])) as PersistedPortalConnection;
};

const parseConnections = (value: string | null): PersistedPortalConnections => {
  if (!value) return { connections: [] };
  try {
    const input = JSON.parse(value) as Record<string, unknown>;
    if (!input || !Array.isArray(input.connections)) return { connections: [] };
    const connections = input.connections
      .map(connection)
      .filter((item): item is PersistedPortalConnection => Boolean(item));
    const unique = [...new Map(connections.map((item) => [item.hostId, item])).values()];
    const selectedHostId = typeof input.selectedHostId === 'string' &&
        unique.some(({ hostId }) => hostId === input.selectedHostId)
      ? input.selectedHostId
      : unique[0]?.hostId;
    return { connections: unique, ...(selectedHostId ? { selectedHostId } : {}) };
  } catch {
    return { connections: [] };
  }
};

export async function loadPortalConnections(preferences: PortalConnectionPreferences = Preferences) {
  try {
    const { value } = await preferences.get({ key: PORTAL_CONNECTION_STORAGE_KEY });
    return parseConnections(value);
  } catch {
    return { connections: [] };
  }
}

export async function savePortalConnections(
  connections: PersistedPortalConnections,
  preferences: PortalConnectionPreferences = Preferences,
) {
  await preferences.set({
    key: PORTAL_CONNECTION_STORAGE_KEY,
    value: JSON.stringify(connections),
  });
}
