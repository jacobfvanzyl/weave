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

  it('defaults to Weave and resolves legacy app ids as aliases', async () => {
    const { module } = await loadClientApp();

    expect(module.getBuildClientAppId()).toBe('weave');
    expect(module.resolveClientAppId('flare')).toBe('weave');
    expect(module.resolveClientAppId('coppermind')).toBe('weave');
    expect(module.clientAppDefinitions.weave).toMatchObject({
      displayName: 'Weave',
      allowedProducts: ['code', 'notes', 'chat'],
      navigationProducts: [],
      sidebarProducts: ['code', 'notes', 'chat'],
      defaultProduct: 'code',
    });
    expect(module.clientAppDefinitions.flare).toBe(module.clientAppDefinitions.weave);
    expect(module.clientAppDefinitions.coppermind).toBe(module.clientAppDefinitions.weave);
  });

  it('allows all internal products while hiding top-level product navigation', async () => {
    const { module } = await loadClientApp();
    const app = module.clientAppDefinitions.weave;

    expect(module.sanitizeProductForClientApp('chat', app)).toBe('chat');
    expect(module.sanitizeProductForClientApp('notes', app)).toBe('notes');
    expect(module.sanitizeProductForClientApp(undefined, app)).toBe('code');
    expect(module.isProductAllowedForClientApp('chat', app)).toBe(true);
    expect(module.isProductSelectableForClientApp('chat', app)).toBe(true);
    expect(module.getClientAppNavigationProducts(app)).toEqual([]);
    expect(module.getClientAppSidebarProducts(app)).toEqual(['code', 'notes', 'chat']);
    expect(module.getClientAppProductLabel(app, 'code')).toBe('Git');
    expect(module.getClientAppProductLabel(app, 'chat')).toBe('Threads');
  });

  it('reads legacy storage as a fallback and writes Weave-scoped keys', async () => {
    const storage = createStorage();
    storage.setItem('weave-theme', 'legacy');
    const { module } = await loadClientApp(storage);

    expect(module.getClientAppStorageItem('weave-theme', module.clientAppDefinitions.weave)).toBe('legacy');
    expect(storage.getItem('weave-theme')).toBe('legacy');
    expect(storage.getItem('weave-theme.weave')).toBe('legacy');

    module.setClientAppStorageItem('weave-theme', 'weave', module.clientAppDefinitions.weave);

    expect(storage.getItem('weave-theme')).toBe('legacy');
    expect(storage.getItem('weave-theme.weave')).toBe('weave');
  });

  it('imports old Coppermind and Flare scoped storage without deleting it', async () => {
    const storage = createStorage();
    storage.setItem('weave-theme.coppermind', 'coppermind');
    storage.setItem('weave-theme.flare', 'flare');
    const { module } = await loadClientApp(storage);

    expect(module.getClientAppStorageItem('weave-theme')).toBe('coppermind');
    expect(storage.getItem('weave-theme.weave')).toBe('coppermind');
    expect(storage.getItem('weave-theme.coppermind')).toBe('coppermind');
    expect(storage.getItem('weave-theme.flare')).toBe('flare');
  });
});
