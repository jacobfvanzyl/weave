import { Capacitor, registerPlugin } from '@capacitor/core';

export type PortalCredentialSigner = {
  hostId: string;
  credentialId: string;
  sign(payload: string): Promise<string>;
};

type PortalCredentialPlugin = {
  generate(options: { keyId: string }): Promise<{ publicKey: string }>;
  sign(options: { keyId: string; payload: string }): Promise<{ signature: string }>;
  delete(options: { keyId: string }): Promise<void>;
};

const NativeCredential = registerPlugin<PortalCredentialPlugin>('PortalCredential');
const webKeys = new Map<string, CryptoKey>();
const WEB_KEY_DATABASE = 'weave-portal-credentials';
const WEB_KEY_STORE = 'keys';

const encodeBase64Url = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

const webDatabase = async () => {
  if (!globalThis.indexedDB) return;
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(WEB_KEY_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(WEB_KEY_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const storeWebKey = async (keyId: string, key: CryptoKey) => {
  webKeys.set(keyId, key);
  const database = await webDatabase();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(WEB_KEY_STORE, 'readwrite');
    transaction.objectStore(WEB_KEY_STORE).put(key, keyId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }).finally(() => database.close());
};

const webKey = async (keyId: string) => {
  const cached = webKeys.get(keyId);
  if (cached) return cached;
  const database = await webDatabase();
  const key = database && await new Promise<CryptoKey | undefined>((resolve, reject) => {
    const request = database.transaction(WEB_KEY_STORE).objectStore(WEB_KEY_STORE).get(keyId);
    request.onsuccess = () => resolve(request.result as CryptoKey | undefined);
    request.onerror = () => reject(request.error);
  }).finally(() => database.close());
  if (!key) throw new Error('This browser no longer has the Host credential. Pair the Host again.');
  webKeys.set(keyId, key);
  return key;
};

export async function createPortalCredentialKey(keyId: string) {
  if (Capacitor.getPlatform() === 'ios') return await NativeCredential.generate({ keyId });
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  await storeWebKey(keyId, pair.privateKey);
  return { publicKey: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))) };
}

export function portalCredentialSigner(input: {
  hostId: string;
  credentialId: string;
  keyId: string;
}): PortalCredentialSigner {
  return {
    hostId: input.hostId,
    credentialId: input.credentialId,
    sign: async (payload) => {
      if (Capacitor.getPlatform() === 'ios') {
        return (await NativeCredential.sign({ keyId: input.keyId, payload })).signature;
      }
      return encodeBase64Url(new Uint8Array(await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        await webKey(input.keyId),
        new TextEncoder().encode(payload),
      )));
    },
  };
}

export async function deletePortalCredentialKey(keyId: string) {
  if (Capacitor.getPlatform() === 'ios') {
    await NativeCredential.delete({ keyId });
    return;
  }
  webKeys.delete(keyId);
  const database = await webDatabase();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(WEB_KEY_STORE, 'readwrite');
    transaction.objectStore(WEB_KEY_STORE).delete(keyId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }).finally(() => database.close());
}
