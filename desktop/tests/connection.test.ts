import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getServerOrigin, normalizeMastraUrl, parseDesktopConnectionInput } from '../src/shared/connection';
import { ConnectionSettingsStore, type EncryptionProvider } from '../src/main/settings-store';

const createEncryption = (available = true): EncryptionProvider => ({
  isEncryptionAvailable: () => available,
  encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: value => value.toString('utf8').replace(/^encrypted:/, ''),
});

const withTempStore = <T>(callback: (path: string) => T) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'weave-desktop-'));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe('normalizeMastraUrl', () => {
  it('defaults to the local Mastra server', () => {
    expect(normalizeMastraUrl()).toBe('http://localhost:4111');
  });

  it('adds http and removes trailing slashes', () => {
    expect(normalizeMastraUrl('localhost:4111///')).toBe('http://localhost:4111');
  });

  it('preserves a proxy base path without query or hash', () => {
    expect(normalizeMastraUrl('https://example.com/weave/?debug=true#top')).toBe('https://example.com/weave');
  });

  it('rejects non-http protocols and credentials', () => {
    expect(() => normalizeMastraUrl('file:///tmp/weave')).toThrow(/http or https/);
    expect(() => normalizeMastraUrl('https://token@example.com')).toThrow(/credentials/);
  });

  it('extracts the exact origin for auth injection', () => {
    expect(getServerOrigin('https://example.com/weave')).toBe('https://example.com');
  });
});

describe('parseDesktopConnectionInput', () => {
  it('accepts a server URL with optional token states', () => {
    expect(parseDesktopConnectionInput({ mastraUrl: 'http://localhost:4111' })).toEqual({
      mastraUrl: 'http://localhost:4111',
    });
    expect(parseDesktopConnectionInput({ mastraUrl: 'http://localhost:4111', authToken: null })).toEqual({
      mastraUrl: 'http://localhost:4111',
      authToken: null,
    });
  });

  it('rejects malformed IPC payloads', () => {
    expect(() => parseDesktopConnectionInput(null)).toThrow(/object/);
    expect(() => parseDesktopConnectionInput({ mastraUrl: 4111 })).toThrow(/server URL/);
    expect(() => parseDesktopConnectionInput({ mastraUrl: 'http://localhost:4111', authToken: 123 })).toThrow(
      /auth token/,
    );
  });
});

describe('ConnectionSettingsStore', () => {
  it('persists server URLs and encrypted auth tokens', () => withTempStore(directory => {
    const firstStore = new ConnectionSettingsStore({
      userDataPath: directory,
      encryption: createEncryption(),
      env: {},
    });

    expect(firstStore.saveSettings({ mastraUrl: 'localhost:4111', authToken: 'secret' })).toEqual({
      mastraUrl: 'http://localhost:4111',
      hasAuthToken: true,
    });

    const secondStore = new ConnectionSettingsStore({
      userDataPath: directory,
      encryption: createEncryption(),
      env: {},
    });

    expect(secondStore.getAuthToken()).toBe('secret');
  }));

  it('keeps tokens session-only when safe storage is unavailable', () => withTempStore(directory => {
    const store = new ConnectionSettingsStore({
      userDataPath: directory,
      encryption: createEncryption(false),
      env: {},
    });

    store.saveSettings({ mastraUrl: 'localhost:4111', authToken: 'session-secret' });
    expect(store.getAuthToken()).toBe('session-secret');

    const restartedStore = new ConnectionSettingsStore({
      userDataPath: directory,
      encryption: createEncryption(false),
      env: {},
    });

    expect(restartedStore.getAuthToken()).toBeUndefined();
  }));

  it('clears stored tokens explicitly', () => withTempStore(directory => {
    const store = new ConnectionSettingsStore({
      userDataPath: directory,
      encryption: createEncryption(),
      env: {},
    });

    store.saveSettings({ mastraUrl: 'localhost:4111', authToken: 'secret' });
    store.saveSettings({ mastraUrl: 'localhost:4111', authToken: null });

    expect(store.getSettings().hasAuthToken).toBe(false);
    expect(store.getAuthToken()).toBeUndefined();
  }));

  it('uses environment defaults before persisted settings exist', () => withTempStore(directory => {
    const store = new ConnectionSettingsStore({
      userDataPath: directory,
      encryption: createEncryption(),
      env: {
        WEAVE_DESKTOP_SERVER_URL: 'https://weave.example.test',
        WEAVE_AUTH_TOKEN: 'env-secret',
      },
    });

    expect(store.getSettings()).toEqual({
      mastraUrl: 'https://weave.example.test',
      hasAuthToken: true,
    });
    expect(store.getAuthToken()).toBe('env-secret');
  }));
});
