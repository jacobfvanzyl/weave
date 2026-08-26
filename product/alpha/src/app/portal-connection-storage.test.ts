import { describe, expect, it, vi } from 'vitest';
import { loadPortalConnections, savePortalConnections } from './portal-connection-storage';

const connection = {
  hostId: 'host-1',
  displayName: 'Bazzite',
  hostUrl: 'wss://bazzite.example.test:4122',
  credentialId: 'credential-1',
  keyId: 'key-1',
};

function preferences(value: string | null = null) {
  return {
    get: vi.fn().mockResolvedValue({ value }),
    set: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Portal connection storage', () => {
  it('restores Host metadata without storing credential secrets', async () => {
    const stored = { connections: [connection], selectedHostId: connection.hostId };
    const store = preferences(JSON.stringify(stored));

    await expect(loadPortalConnections(store)).resolves.toEqual(stored);
    expect(store.get).toHaveBeenCalledWith({ key: 'weave.portal.connections.v2' });
    expect(JSON.stringify(stored)).not.toContain('privateKey');
  });

  it('persists multiple Hosts and the selected Host', async () => {
    const store = preferences();
    const stored = { connections: [connection], selectedHostId: connection.hostId };

    await savePortalConnections(stored, store);

    expect(store.set).toHaveBeenCalledWith({
      key: 'weave.portal.connections.v2',
      value: JSON.stringify(stored),
    });
  });

  it.each([
    null,
    'not-json',
    JSON.stringify({ connections: [{ hostId: connection.hostId }] }),
  ])('fails closed for missing or malformed metadata', async (value) => {
    await expect(loadPortalConnections(preferences(value))).resolves.toEqual({ connections: [] });
  });

  it('deduplicates Hosts and repairs an invalid selection', async () => {
    const duplicate = { ...connection, displayName: 'Latest name' };
    const store = preferences(JSON.stringify({ connections: [connection, duplicate], selectedHostId: 'missing' }));
    await expect(loadPortalConnections(store)).resolves.toEqual({
      connections: [duplicate],
      selectedHostId: connection.hostId,
    });
  });
});
