import { createJSONStorage, type StateStorage } from 'zustand/middleware';
import { type ClientAppId, type ClientAppInputId, getClientAppDefinition } from './client-app';

export interface ClientSessionIdentity {
  clientAppId: ClientAppId;
  serverUrl: string;
  ownerId: string;
}

export type ClientSessionPhase = 'inactive' | 'hydrating' | 'waiting-for-entities' | 'ready';

let activeClientSessionIdentity: ClientSessionIdentity | undefined;

const getBrowserStorage = () => {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
    return globalThis.localStorage as Storage | undefined;
  }
  return undefined;
};

export const normalizeClientSessionServerUrl = (input: string) => {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    url.hash = '';
    url.search = '';
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
};

const encodeStorageSegment = (value: string) => encodeURIComponent(value);

export const createClientSessionIdentity = (
  clientApp: ClientAppInputId | undefined,
  serverUrl: string,
  ownerId: string,
): ClientSessionIdentity => ({
  clientAppId: getClientAppDefinition(clientApp).id,
  serverUrl: normalizeClientSessionServerUrl(serverUrl),
  ownerId,
});

export const getClientSessionScopeKey = (identity: ClientSessionIdentity) =>
  [identity.clientAppId, encodeStorageSegment(identity.serverUrl), encodeStorageSegment(identity.ownerId)].join('.');

export const getClientSessionStorageKey = (key: string, identity = activeClientSessionIdentity) =>
  identity ? `${key}.session-v1.${getClientSessionScopeKey(identity)}` : `${key}.${getClientAppDefinition().id}`;

export const setActiveClientSessionIdentity = (identity: ClientSessionIdentity | undefined) => {
  activeClientSessionIdentity = identity;
};

export const getActiveClientSessionIdentity = () => activeClientSessionIdentity;

export const createClientSessionPersistStorage = <T>() =>
  createJSONStorage<T>(() => {
    const storage = getBrowserStorage();
    const scopedStorage: StateStorage = {
      getItem: (name) => storage?.getItem(name) ?? null,
      setItem: (name, value) => storage?.setItem(name, value),
      removeItem: (name) => storage?.removeItem(name),
    };
    return scopedStorage;
  });

export const claimLegacyClientSessionStorage = (destinationKey: string, legacyKeys: readonly string[]) => {
  const storage = getBrowserStorage();
  if (!storage) return false;
  const destinationExists = storage.getItem(destinationKey) !== null;
  for (const legacyKey of legacyKeys) {
    const claimKey = `weave.client-session-legacy-claim.v1.${encodeStorageSegment(legacyKey)}`;
    if (storage.getItem(claimKey) !== null) continue;
    const value = storage.getItem(legacyKey);
    if (value === null) continue;
    if (!destinationExists) storage.setItem(destinationKey, value);
    for (const claimedLegacyKey of legacyKeys) {
      storage.setItem(`weave.client-session-legacy-claim.v1.${encodeStorageSegment(claimedLegacyKey)}`, destinationKey);
    }
    return !destinationExists;
  }
  return false;
};

export const claimLegacyClientSessionValue = (
  legacyKey: string,
  identity = activeClientSessionIdentity,
) => {
  const storage = getBrowserStorage();
  if (!storage || !identity) return null;
  const claimKey = `weave.client-session-legacy-claim.v1.${encodeStorageSegment(legacyKey)}`;
  if (storage.getItem(claimKey) !== null) return null;
  const value = storage.getItem(legacyKey);
  if (value === null) return null;
  storage.setItem(claimKey, getClientSessionScopeKey(identity));
  return value;
};

export const readClientSessionStorageValue = (key: string) => getBrowserStorage()?.getItem(key) ?? null;

export const restoreClientSessionStorageValue = (key: string, value: string | null) => {
  const storage = getBrowserStorage();
  if (!storage) return;
  if (value === null) storage.removeItem(key);
  else storage.setItem(key, value);
};
