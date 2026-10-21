import { registerPlugin } from '@capacitor/core';
import { toBase64Url } from './base64url';
import type { Jwk } from './protocol';

/**
 * This device's key for one Host: it introduces the device at pairing and signs each
 * connection's challenge. On a device it lives in the Secure Enclave and never leaves it.
 */
export type DeviceKey = {
  publicKey(): Promise<Jwk>;
  /** The DER ECDSA P-256 SHA-256 signature of `message`'s UTF-8 bytes, in unpadded base64url. */
  sign(message: string): Promise<string>;
  /** Deletes the key; the device has to pair again. */
  forget(): Promise<void>;
};

/** What a paired device signs at `host/hello`. */
export const authMessage = (hostId: string, deviceId: string, nonce: string) =>
  `weave-host-auth/1 ${hostId} ${deviceId} ${nonce}`;

type DeviceKeyPlugin = {
  generate(options: { keyId: string }): Promise<{ publicKey: Jwk }>;
  sign(options: { keyId: string; payload: string }): Promise<{ signature: string }>;
  delete(options: { keyId: string }): Promise<void>;
};

const NativeDeviceKey = registerPlugin<DeviceKeyPlugin>('DeviceKey');

/** The key `keyId` in the native shell's Keychain, made on first use (`DeviceKeyPlugin.swift`). */
export const nativeDeviceKey = (keyId: string): DeviceKey => ({
  publicKey: async () => (await NativeDeviceKey.generate({ keyId })).publicKey,
  sign: async (message) => (await NativeDeviceKey.sign({ keyId, payload: message })).signature,
  forget: () => NativeDeviceKey.delete({ keyId }),
});

/** A big-endian integer as DER wants it: no leading zeros, and a zero byte before a high bit. */
const derInteger = (value: Uint8Array) => {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const trimmed = value.subarray(start);
  const body = trimmed[0] >= 0x80 ? Uint8Array.of(0, ...trimmed) : trimmed;
  return Uint8Array.of(0x02, body.length, ...body);
};

/** WebCrypto's ECDSA signature, r || s, as DER: SEQUENCE { INTEGER r, INTEGER s }. */
export function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  if (raw.length !== 64) throw new Error(`A P-256 signature has 64 bytes, not ${raw.length}.`);
  const r = derInteger(raw.subarray(0, 32));
  const s = derInteger(raw.subarray(32));
  return Uint8Array.of(0x30, r.length + s.length, ...r, ...s);
}

/**
 * A key WebCrypto holds in memory, for tests and for a browser during development. Its private
 * half can't be exported, but it isn't hardware-backed: devices use `nativeDeviceKey`.
 */
export async function webCryptoDeviceKey(): Promise<DeviceKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  if (!exported.x || !exported.y) throw new Error('WebCrypto gave no public key coordinates.');
  const jwk: Jwk = { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y };
  return {
    publicKey: async () => jwk,
    async sign(message) {
      const raw = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(message));
      return toBase64Url(rawSignatureToDer(new Uint8Array(raw)));
    },
    async forget() {},
  };
}
