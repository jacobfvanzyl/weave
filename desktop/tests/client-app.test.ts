import { afterEach, describe, expect, it, vi } from 'vitest';

const createStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
};

const loadClientApp = async (storage = createStorage()) => {
  vi.resetModules();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
  return {
    storage,
    module: await import('../../packages/client/src/lib/client-app'),
  };
};

describe('client app definitions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('defaults to Flare and defines the split app surfaces', async () => {
    const { module } = await loadClientApp();

    expect(module.getBuildClientAppId()).toBe('flare');
    expect(module.clientAppDefinitions.flare).toMatchObject({
      displayName: 'Flare',
      allowedProducts: ['code'],
      defaultProduct: 'code',
    });
    expect(module.clientAppDefinitions.coppermind).toMatchObject({
      displayName: 'Coppermind',
      allowedProducts: ['notes', 'chat'],
      selectableProducts: ['notes'],
      navigationProducts: [],
      sidebarProducts: ['notes', 'chat'],
      defaultProduct: 'notes',
    });
  });

  it('sanitizes products to the active app boundary', async () => {
    const { module } = await loadClientApp();

    expect(module.sanitizeProductForClientApp('chat', module.clientAppDefinitions.flare)).toBe('code');
    expect(module.sanitizeProductForClientApp('code', module.clientAppDefinitions.coppermind)).toBe('notes');
    expect(module.sanitizeProductForClientApp('chat', module.clientAppDefinitions.coppermind)).toBe('notes');
    expect(module.isProductAllowedForClientApp('chat', module.clientAppDefinitions.coppermind)).toBe(true);
    expect(module.isProductSelectableForClientApp('chat', module.clientAppDefinitions.coppermind)).toBe(false);
    expect(module.getClientAppNavigationProducts(module.clientAppDefinitions.coppermind)).toEqual([]);
    expect(module.getClientAppSidebarProducts(module.clientAppDefinitions.coppermind)).toEqual(['notes', 'chat']);
    expect(module.getClientAppProductLabel(module.clientAppDefinitions.coppermind, 'chat')).toBe('Threads');
  });

  it('reads legacy storage as a fallback and writes app-scoped keys', async () => {
    const storage = createStorage();
    storage.setItem('weave-theme', 'legacy');
    const { module } = await loadClientApp(storage);

    expect(module.getClientAppStorageItem('weave-theme', module.clientAppDefinitions.flare)).toBe('legacy');
    expect(storage.getItem('weave-theme')).toBe('legacy');
    expect(storage.getItem('weave-theme.flare')).toBe('legacy');

    module.setClientAppStorageItem('weave-theme', 'flare', module.clientAppDefinitions.flare);
    module.setClientAppStorageItem('weave-theme', 'coppermind', module.clientAppDefinitions.coppermind);

    expect(storage.getItem('weave-theme')).toBe('legacy');
    expect(storage.getItem('weave-theme.flare')).toBe('flare');
    expect(storage.getItem('weave-theme.coppermind')).toBe('coppermind');
  });
});
