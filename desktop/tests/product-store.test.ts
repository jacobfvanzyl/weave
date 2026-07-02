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

const loadFreshProductStore = async (seed?: (storage: Storage) => void) => {
  vi.resetModules();
  const storage = createStorage();
  seed?.(storage);
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
  return import('../../packages/client/src/stores/product-store');
};

describe('product store', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('keeps persisted product mode within the merged Weave surface', async () => {
    const { useProductStore } = await loadFreshProductStore(storage => {
      storage.setItem('weave.product-mode.v1', JSON.stringify({
        state: { activeProduct: 'chat' },
        version: 1,
      }));
    });

    expect(useProductStore.getState().activeProduct).toBe('chat');

    useProductStore.getState().setActiveProduct('notes');
    expect(useProductStore.getState().activeProduct).toBe('notes');
  });

  it('defaults unknown product state to Git/code', async () => {
    const { useProductStore } = await loadFreshProductStore(storage => {
      storage.setItem('weave.product-mode.v1', JSON.stringify({
        state: { activeProduct: 'unknown' },
        version: 1,
      }));
    });

    expect(useProductStore.getState().activeProduct).toBe('code');
  });
});
