import { describe, expect, it } from 'vitest';
import {
  PORTAL_PAIRING_TOKEN_ALGORITHM,
  PORTAL_PAIRING_TOKEN_AUDIENCE,
  PORTAL_PAIRING_TOKEN_TYPE,
} from '@weave/product-protocol';
import { parsePortalPairingToken } from './portal-pairing';

const encode = (value: Record<string, unknown>) =>
  btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

const token = (claims: Record<string, unknown>, header: Record<string, unknown> = {
  alg: PORTAL_PAIRING_TOKEN_ALGORITHM,
  typ: PORTAL_PAIRING_TOKEN_TYPE,
}) => `${encode(header)}.${encode(claims)}.signature`;

const claims = (overrides: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1_000);
  return {
    iss: 'host-1',
    aud: PORTAL_PAIRING_TOKEN_AUDIENCE,
    jti: 'offer-1',
    iat: now,
    exp: now + 60,
    ...overrides,
  };
};

describe('Portal Pairing Tokens', () => {
  it('parses the strict minimal JWT profile emitted by Portal', () => {
    const pairingToken = token(claims());
    expect(parsePortalPairingToken(pairingToken)).toEqual({
      token: pairingToken,
      hostId: 'host-1',
      issuedAt: expect.any(Number),
      expiresAt: expect.any(Number),
    });
  });

  it('rejects malformed, expired, and metadata-bearing tokens', () => {
    expect(() => parsePortalPairingToken('not-a-jwt')).toThrow('compact JWT');
    expect(() => parsePortalPairingToken(token(claims(), { alg: 'none', typ: PORTAL_PAIRING_TOKEN_TYPE })))
      .toThrow('header');
    const now = Math.floor(Date.now() / 1_000);
    expect(() => parsePortalPairingToken(token(claims({ iat: now - 60, exp: now - 1 }))))
      .toThrow('expired');
    expect(() => parsePortalPairingToken(token(claims({ grants: ['portal.inspect'] })))).toThrow('claims');
  });
});
