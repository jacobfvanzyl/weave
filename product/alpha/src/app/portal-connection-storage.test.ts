import { describe, expect, it, vi } from 'vitest';
import {
  loadPortalConnection,
  savePortalConnection,
} from './portal-connection-storage';

const connection = {
  hostUrl: 'wss://bazzite.example.test:4122',
  accessToken: 'secret-token',
};

function preferences(value: string | null = null) {
  return {
    get: vi.fn().mockResolvedValue({ value }),
    set: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Portal connection storage', () => {
  it('restores a complete iOS connection', async () => {
    const store = preferences(JSON.stringify(connection));

    await expect(loadPortalConnection('ios', store)).resolves.toEqual(connection);
    expect(store.get).toHaveBeenCalledWith({ key: 'weave.portal.connection.v1' });
  });

  it('persists the host and token together on iOS', async () => {
    const store = preferences();

    await savePortalConnection(connection, 'ios', store);

    expect(store.set).toHaveBeenCalledWith({
      key: 'weave.portal.connection.v1',
      value: JSON.stringify(connection),
    });
  });

  it.each([
    null,
    'not-json',
    JSON.stringify({ hostUrl: connection.hostUrl }),
    JSON.stringify({ hostUrl: '', accessToken: connection.accessToken }),
  ])('ignores missing or malformed stored values', async (value) => {
    await expect(loadPortalConnection('ios', preferences(value))).resolves.toBeUndefined();
  });

  it('does not read or write native credentials in a browser', async () => {
    const store = preferences(JSON.stringify(connection));

    await expect(loadPortalConnection('web', store)).resolves.toBeUndefined();
    await savePortalConnection(connection, 'web', store);

    expect(store.get).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });
});
