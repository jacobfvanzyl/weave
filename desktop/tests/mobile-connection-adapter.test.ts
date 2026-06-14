import { afterEach, describe, expect, it, vi } from 'vitest';

const preferencesMock = vi.hoisted(() => {
  const state = {
    value: null as string | null,
    getCalls: [] as Array<{ key: string }>,
    setCalls: [] as Array<{ key: string; value: string }>,
  };

  return {
    getCalls: state.getCalls,
    setCalls: state.setCalls,
    reset(value: string | null = null) {
      state.value = value;
      state.getCalls.length = 0;
      state.setCalls.length = 0;
    },
    async get(options: { key: string }) {
      state.getCalls.push(options);
      return { value: state.value };
    },
    async set(options: { key: string; value: string }) {
      state.setCalls.push(options);
      state.value = options.value;
    },
  };
});

const mockVirtual = vi.mock as unknown as (
  path: string,
  factory: () => unknown,
  options: { virtual: true },
) => void;

mockVirtual('@capacitor/preferences', () => ({
  Preferences: {
    get: preferencesMock.get,
    set: preferencesMock.set,
  },
}), { virtual: true });

mockVirtual('__vite-optional-peer-dep:@capacitor/preferences:@weave/client:false', () => ({
  Preferences: {
    get: preferencesMock.get,
    set: preferencesMock.set,
  },
}), { virtual: true });

type PersistedSettings = {
  mastraUrl?: string;
  authToken?: string | null;
};

type Env = {
  VITE_MASTRA_URL?: string;
  VITE_WEAVE_AUTH_TOKEN?: string;
  VITE_WEAVE_DEV_CONNECTION_OVERRIDE?: string;
};

const loadFreshAdapter = async (env: Env, persisted?: PersistedSettings) => {
  vi.resetModules();
  vi.unstubAllEnvs();
  preferencesMock.reset(persisted ? JSON.stringify(persisted) : null);
  vi.stubEnv('DEV', true);

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) vi.stubEnv(key, value);
  }

  const { createMobileConnectionAdapter } = await import('../../packages/client/src/lib/mobile-connection-adapter');
  return createMobileConnectionAdapter();
};

describe('mobile connection adapter dev overrides', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    preferencesMock.reset();
  });

  it('uses the injected dev URL instead of a persisted URL when override is enabled', async () => {
    const adapter = await loadFreshAdapter(
      {
        VITE_MASTRA_URL: 'http://192.168.110.63:4111',
        VITE_WEAVE_DEV_CONNECTION_OVERRIDE: '1',
      },
      {
        mastraUrl: 'http://saved.example:4111',
        authToken: 'saved-token',
      },
    );

    await expect(adapter.getSettings()).resolves.toEqual({
      mastraUrl: 'http://192.168.110.63:4111',
      hasAuthToken: true,
    });
  });

  it('uses the injected dev token instead of a persisted token when override is enabled', async () => {
    const adapter = await loadFreshAdapter(
      {
        VITE_MASTRA_URL: 'http://192.168.110.63:4111',
        VITE_WEAVE_AUTH_TOKEN: 'env-token',
        VITE_WEAVE_DEV_CONNECTION_OVERRIDE: '1',
      },
      {
        mastraUrl: 'http://saved.example:4111',
        authToken: 'saved-token',
      },
    );

    await adapter.getSettings();
    expect(adapter.getClientAuthToken?.()).toBe('env-token');
  });

  it('falls back to the persisted token in dev override mode when no env token is available', async () => {
    const adapter = await loadFreshAdapter(
      {
        VITE_MASTRA_URL: 'http://192.168.110.63:4111',
        VITE_WEAVE_DEV_CONNECTION_OVERRIDE: '1',
      },
      {
        mastraUrl: 'http://saved.example:4111',
        authToken: 'saved-token',
      },
    );

    await adapter.getSettings();
    expect(adapter.getClientAuthToken?.()).toBe('saved-token');
  });

  it('keeps persisted settings first when dev override is disabled', async () => {
    const adapter = await loadFreshAdapter(
      {
        VITE_MASTRA_URL: 'http://192.168.110.63:4111',
        VITE_WEAVE_AUTH_TOKEN: 'env-token',
      },
      {
        mastraUrl: 'http://saved.example:4111',
        authToken: 'saved-token',
      },
    );

    await expect(adapter.getSettings()).resolves.toEqual({
      mastraUrl: 'http://saved.example:4111',
      hasAuthToken: true,
    });
    expect(adapter.getClientAuthToken?.()).toBe('saved-token');
  });
});
