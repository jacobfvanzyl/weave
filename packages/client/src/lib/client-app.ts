import { createJSONStorage, type StateStorage } from 'zustand/middleware';
import { productLabels, type ProductId } from './products';

export type ClientAppId = 'flare' | 'coppermind';

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

const clientAppIds = new Set<ClientAppId>(['flare', 'coppermind']);

export const clientAppDefinitions: Record<ClientAppId, ClientAppDefinition> = {
  flare: {
    id: 'flare',
    displayName: 'Flare',
    allowedProducts: ['code'],
    defaultProduct: 'code',
    productLabels: {
      code: 'Code',
    },
  },
  coppermind: {
    id: 'coppermind',
    displayName: 'Coppermind',
    allowedProducts: ['notes', 'chat'],
    selectableProducts: ['notes'],
    navigationProducts: [],
    sidebarProducts: ['notes', 'chat'],
    defaultProduct: 'notes',
    productLabels: {
      notes: 'Notes',
      chat: 'Threads',
    },
  },
};

export const isClientAppId = (value: unknown): value is ClientAppId =>
  typeof value === 'string' && clientAppIds.has(value as ClientAppId);

export const resolveClientAppId = (value: unknown): ClientAppId =>
  isClientAppId(value) ? value : 'flare';

export const getBuildClientAppId = (): ClientAppId =>
  resolveClientAppId(
    typeof __WEAVE_CLIENT_APP__ === 'string' ? __WEAVE_CLIENT_APP__ : undefined,
  );

export const getClientAppDefinition = (
  value: ClientAppId | ClientAppDefinition = getBuildClientAppId(),
): ClientAppDefinition => typeof value === 'string' ? clientAppDefinitions[value] : value;

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
  const scopedValue = storage.getItem(scopedKey);
  if (scopedValue !== null) return scopedValue;
  const legacyValue = storage.getItem(key);
  if (legacyValue !== null) storage.setItem(scopedKey, legacyValue);
  return legacyValue;
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
        const scopedValue = storage?.getItem(name);
        if (scopedValue !== null && scopedValue !== undefined) return scopedValue;
        const legacyValue = storage?.getItem(key) ?? null;
        if (legacyValue !== null) storage?.setItem(name, legacyValue);
        return legacyValue;
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
