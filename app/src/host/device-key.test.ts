import { describe, expect, it } from 'vitest';
import { fromBase64Url } from './base64url';
import { authMessage, rawSignatureToDer, webCryptoDeviceKey } from './device-key';

/** DER back to r || s, to check a signature with WebCrypto. */
function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> {
  expect(der[0]).toBe(0x30);
  expect(der[1]).toBe(der.length - 2);
  let offset = 2;
  const integer = () => {
    expect(der[offset]).toBe(0x02);
    const length = der[offset + 1];
    const value = der.subarray(offset + 2, offset + 2 + length);
    offset += 2 + length;
    const out = new Uint8Array(32);
    out.set(value.subarray(Math.max(0, value.length - 32)), 32 - Math.min(32, value.length));
    return out;
  };
  return Uint8Array.of(...integer(), ...integer());
}

describe('rawSignatureToDer', () => {
  it('pads a high bit and drops leading zeros', () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80; // r: high bit set, so DER needs a zero byte first
    raw[63] = 0x01; // s: 31 leading zero bytes, so DER keeps one byte
    const der = rawSignatureToDer(raw);
    expect([...der.subarray(0, 4)]).toEqual([0x30, 2 + 33 + 2 + 1, 0x02, 33]);
    expect(der[4]).toBe(0x00);
    expect([...der.subarray(-3)]).toEqual([0x02, 0x01, 0x01]);
    expect(derToRaw(der)).toEqual(raw);
  });

  it('refuses anything but 64 bytes', () => {
    expect(() => rawSignatureToDer(new Uint8Array(63))).toThrow('64 bytes');
  });
});

describe('webCryptoDeviceKey', () => {
  it('gives a P-256 JWK and DER signatures its public key verifies', async () => {
    const key = await webCryptoDeviceKey();
    const jwk = await key.publicKey();
    expect(jwk.kty).toBe('EC');
    expect(jwk.crv).toBe('P-256');
    expect(fromBase64Url(jwk.x)).toHaveLength(32);
    expect(fromBase64Url(jwk.y)).toHaveLength(32);

    const message = authMessage('host-1', 'device-1', 'nonce');
    const signature = fromBase64Url(await key.sign(message));
    const publicKey = await crypto.subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      derToRaw(signature),
      new TextEncoder().encode(message),
    );
    expect(valid).toBe(true);
  });
});

it('spells the message a device signs as the Host checks it', () => {
  expect(authMessage('h', 'd', 'n')).toBe('weave-host-auth/1 h d n');
});
