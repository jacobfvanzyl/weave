import { describe, expect, it } from 'vitest';
import { createPortalCredentialKey, deletePortalCredentialKey, portalCredentialSigner } from './portal-credential';

const decode = (value: string) => {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

describe('Portal browser credentials', () => {
  it('signs P-256 challenges without placing private material in connection metadata', async () => {
    const keyId = `test-${crypto.randomUUID()}`;
    const generated = await createPortalCredentialKey(keyId);
    const signer = portalCredentialSigner({ hostId: 'host-1', credentialId: 'credential-1', keyId });
    const payload = 'weave challenge';
    const signature = await signer.sign(payload);
    const publicKey = await crypto.subtle.importKey(
      'raw',
      decode(generated.publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    await expect(crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      decode(signature),
      new TextEncoder().encode(payload),
    )).resolves.toBe(true);

    await deletePortalCredentialKey(keyId);
    await expect(signer.sign(payload)).rejects.toThrow('no longer has');
  });
});
