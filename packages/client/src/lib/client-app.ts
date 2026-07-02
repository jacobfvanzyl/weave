import { createJSONStorage, type StateStorage } from 'zustand/middleware';
import { productLabels, type ProductId } from './products';

export type ClientAppId = 'weave';
export type LegacyClientAppId = 'flare' | 'coppermind';
export type ClientAppInputId = ClientAppId | LegacyClientAppId;

export type ClientAppDefinition = {
  id: ClientAppId;
  displayName: string;
  allowedProducts: ProductId[];
  selectableProducts?: ProductId[];
  navigationProducts?: ProductId[];
  sidebarProducts?: ProductId[];
  defaultProduct: ProductId;
  productLabels: Partial<Record<ProductId, string>>;
};

const canonicalClientAppIds = new Set<ClientAppId>(['weave']);
const legacyClientAppIds = new Set<LegacyClientAppId>(['flare', 'coppermind']);
const legacyStorageAppIds: LegacyClientAppId[] = ['coppermind', 'flare'];

const weaveClientAppDefinition: ClientAppDefinition = {
  id: 'weave',
  displayName: 'Weave',
  allowedProducts: ['code', 'notes', 'chat'],
  navigationProducts: [],
  sidebarProducts: ['code', 'notes', 'chat'],
  defaultProduct: 'code',
  productLabels: {
    code: 'Git',
    notes: 'Notes',
    chat: 'Threads',
  },
};

export const clientAppDefinitions: Record<ClientAppId | LegacyClientAppId, ClientAppDefinition> = {
  weave: weaveClientAppDefinition,
  flare: weaveClientAppDefinition,
  coppermind: weaveClientAppDefinition,
};

export const isClientAppId = (value: unknown): value is ClientAppId =>
  typeof value === 'string' && canonicalClientAppIds.has(value as ClientAppId);

export const isLegacyClientAppId = (value: unknown): value is LegacyClientAppId =>
  typeof value === 'string' && legacyClientAppIds.has(value as LegacyClientAppId);

export const resolveClientAppId = (value: unknown): ClientAppId => {
  if (isClientAppId(value)) return value;
  if (isLegacyClientAppId(value)) return 'weave';
  return 'weave';
};

export const getBuildClientAppId = (): ClientAppId =>
  resolveClientAppId(
    typeof __WEAVE_CLIENT_APP__ === 'string' ? __WEAVE_CLIENT_APP__ : undefined,
  );

export const getClientAppDefinition = (
  value: ClientAppInputId | ClientAppDefinition = getBuildClientAppId(),
): ClientAppDefinition => typeof value === 'string' ? clientAppDefinitions[resolveClientAppId(value)] : value;

export const isProductAllowedForClientApp = (
  product: ProductId,
  app: ClientAppDefinition = getClientAppDefinition(),
) => app.allowedProducts.includes(product);

export const getClientAppSelectableProducts = (
  app: ClientAppDefinition = getClientAppDefinition(),
) => app.selectableProducts ?? app.allowedProducts;

export const getClientAppNavigationProducts = (
  app: ClientAppDefinition = getClientAppDefinition(),
) => app.navigationProducts ?? getClientAppSelectableProducts(app);

export const getClientAppSidebarProducts = (
  app: ClientAppDefinition = getClientAppDefinition(),
) => app.sidebarProducts ?? app.allowedProducts;

export const isProductSelectableForClientApp = (
  product: ProductId,
  app: ClientAppDefinition = getClientAppDefinition(),
) => getClientAppSelectableProducts(app).includes(product);

export const sanitizeProductForClientApp = (
  product: ProductId | undefined,
  app: ClientAppDefinition = getClientAppDefinition(),
): ProductId => product && isProductSelectableForClientApp(product, app)
  ? product
  : app.defaultProduct;

export const getClientAppProductLabel = (
  app: ClientAppDefinition,
  product: ProductId,
) => app.productLabels[product] ?? productLabels[product];

export const getClientAppStorageKey = (
  key: string,
  app: ClientAppDefinition = getClientAppDefinition(),
) => `${key}.${app.id}`;

const getClientAppStorageFallbackKeys = (
  key: string,
  app: ClientAppDefinition = getClientAppDefinition(),
) => [
  getClientAppStorageKey(key, app),
  key,
  ...legacyStorageAppIds.map(id => `${key}.${id}`),
];

const getFirstClientAppStorageValue = (
  storage: Storage | undefined,
  key: string,
  app: ClientAppDefinition = getClientAppDefinition(),
) => {
  if (!storage) return null;
  for (const fallbackKey of getClientAppStorageFallbackKeys(key, app)) {
    const value = storage.getItem(fallbackKey);
    if (value !== null) return { key: fallbackKey, value };
  }
  return null;
};

const getBrowserStorage = () => {
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
    return globalThis.localStorage as Storage | undefined;
  }
  return undefined;
};

export const getClientAppStorageItem = (
  key: string,
  app: ClientAppDefinition = getClientAppDefinition(),
) => {
  const storage = getBrowserStorage();
  if (!storage) return null;
  const scopedKey = getClientAppStorageKey(key, app);
  const fallback = getFirstClientAppStorageValue(storage, key, app);
  if (fallback && fallback.key !== scopedKey) storage.setItem(scopedKey, fallback.value);
  return fallback?.value ?? null;
};

export const setClientAppStorageItem = (
  key: string,
  value: string,
  app: ClientAppDefinition = getClientAppDefinition(),
) => {
  getBrowserStorage()?.setItem(getClientAppStorageKey(key, app), value);
};

export const createClientAppPersistStorage = <T>(key: string) =>
  createJSONStorage<T>(() => {
    const storage = getBrowserStorage();
    const scopedStorage: StateStorage = {
      getItem: name => {
        const fallback = getFirstClientAppStorageValue(storage, key);
        if (fallback && fallback.key !== name) storage?.setItem(name, fallback.value);
        return fallback?.value ?? null;
      },
      setItem: (name, value) => {
        storage?.setItem(name, value);
      },
      removeItem: name => {
        storage?.removeItem(name);
      },
    };
    return scopedStorage;
  });
