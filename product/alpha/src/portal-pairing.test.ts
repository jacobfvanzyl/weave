import { describe, expect, it } from 'vitest';
import { parsePortalPairingCode } from './portal-pairing';

describe('Portal pairing codes', () => {
  it('parses the complete one-time offer emitted by Portal', () => {
    const code = {
      hostId: 'host-1',
      displayName: 'Jaco’s MacBook Air',
      publicUrl: 'wss://host.example:4122',
      offerId: 'offer-1',
      secret: 'secret',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      grants: { actions: [], workspaceIds: [], agentIds: [] },
    };
    expect(parsePortalPairingCode(JSON.stringify(code))).toEqual(
      expect.objectContaining({
        hostId: code.hostId,
        publicUrl: code.publicUrl,
        secret: code.secret,
      }),
    );
  });

  it('rejects malformed, incomplete, and expired offers', () => {
    expect(() => parsePortalPairingCode('not-json')).toThrow('valid JSON');
    expect(() => parsePortalPairingCode('{}')).toThrow('incomplete');
    expect(() =>
      parsePortalPairingCode(JSON.stringify({
        hostId: 'host-1',
        displayName: 'Host',
        offerId: 'offer-1',
        secret: 'secret',
        expiresAt: new Date(Date.now() - 1).toISOString(),
      }))
    ).toThrow('expired');
  });
});
