import { Buffer } from 'node:buffer';
import {
  assertCredentialEncryptionConfigured,
  chatGPTCredentialObjectKey,
  ChatGPTCredentialRepository,
} from './chatgpt-credential-repository.ts';
import type {
  ObjectStore,
  ObjectStoreCopyInput,
  ObjectStoreDeleteInput,
  ObjectStoreDeleteManyInput,
  ObjectStoreGetInput,
  ObjectStoreListInput,
  ObjectStorePutInput,
} from '../../storage/object-store.ts';

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

class MemoryObjectStore implements ObjectStore {
  readonly defaultBucket = 'weave';
  readonly objects = new Map<string, { body: Uint8Array; contentType?: string }>();
  puts = 0;

  async putObject(input: ObjectStorePutInput) {
    this.puts += 1;
    this.objects.set(input.key, {
      body: typeof input.body === 'string' ? new TextEncoder().encode(input.body) : input.body,
      contentType: input.contentType,
    });
  }

  async getObject(input: ObjectStoreGetInput) {
    const value = this.objects.get(input.key);
    return value ? { key: input.key, ...value } : null;
  }

  async deleteObject(input: ObjectStoreDeleteInput) {
    this.objects.delete(input.key);
  }

  async deleteObjects(input: ObjectStoreDeleteManyInput) {
    for (const key of input.keys) this.objects.delete(key);
  }

  async copyObject(input: ObjectStoreCopyInput) {
    const value = this.objects.get(input.key);
    if (value) this.objects.set(input.toKey, value);
  }

  async listObjects(input: ObjectStoreListInput) {
    return {
      objects: [...this.objects.entries()]
        .filter(([key]) => key.startsWith(input.prefix ?? ''))
        .map(([key, value]) => ({ key, size: value.body.byteLength })),
      prefixes: [],
    };
  }
}

const keyA = new Uint8Array(32).fill(7);
const keyB = new Uint8Array(32).fill(8);
const credentials = {
  access: 'access-secret-value',
  refresh: 'refresh-secret-value',
  expires: 123456,
  accountId: 'account-1',
};

Deno.test('ChatGPTCredentialRepository stores an encrypted owner-scoped envelope', async () => {
  const objects = new MemoryObjectStore();
  const repository = new ChatGPTCredentialRepository(objects, () => keyA);

  await repository.put('owner/with spaces', credentials);
  const objectKey = chatGPTCredentialObjectKey('owner/with spaces');
  assertEquals(objectKey, 'users/owner%2Fwith%20spaces/credentials/chatgpt-codex.v1.json');
  const stored = objects.objects.get(objectKey);
  assert(stored, 'expected encrypted object');
  const text = new TextDecoder().decode(stored.body);
  assert(!text.includes(credentials.access), 'access token must not be plaintext');
  assert(!text.includes(credentials.refresh), 'refresh token must not be plaintext');
  assertEquals(Object.keys(JSON.parse(text)).sort(), ['algorithm', 'ciphertext', 'iv', 'version']);
  assertEquals(stored.contentType, 'application/vnd.weave.encrypted-credential+json');
  assertEquals(await repository.get('owner/with spaces'), credentials);
});

Deno.test('ChatGPTCredentialRepository uses a fresh IV and atomically replaces the object', async () => {
  const objects = new MemoryObjectStore();
  const repository = new ChatGPTCredentialRepository(objects, () => keyA);
  await repository.put('owner-1', credentials);
  const first = JSON.parse(new TextDecoder().decode(objects.objects.get(chatGPTCredentialObjectKey('owner-1'))!.body));
  await repository.put('owner-1', { ...credentials, access: 'replacement-access' });
  const second = JSON.parse(new TextDecoder().decode(objects.objects.get(chatGPTCredentialObjectKey('owner-1'))!.body));

  assert(first.iv !== second.iv, 'each write must use a fresh IV');
  assertEquals(objects.puts, 2);
  assertEquals((await repository.get('owner-1'))?.access, 'replacement-access');
});

Deno.test('ChatGPTCredentialRepository rejects wrong keys, wrong owner AAD, and malformed envelopes', async () => {
  const objects = new MemoryObjectStore();
  const repository = new ChatGPTCredentialRepository(objects, () => keyA);
  await repository.put('owner-1', credentials);

  const wrongKey = new ChatGPTCredentialRepository(objects, () => keyB);
  await wrongKey.get('owner-1').then(
    () => {
      throw new Error('expected wrong key failure');
    },
    (error) => assert(String(error).includes('could not be decrypted'), 'expected sanitized decrypt error'),
  );

  objects.objects.set(
    chatGPTCredentialObjectKey('owner-2'),
    objects.objects.get(chatGPTCredentialObjectKey('owner-1'))!,
  );
  await repository.get('owner-2').then(
    () => {
      throw new Error('expected owner AAD failure');
    },
    (error) => assert(String(error).includes('could not be decrypted'), 'expected owner-bound decrypt error'),
  );

  objects.objects.set(chatGPTCredentialObjectKey('owner-3'), { body: new TextEncoder().encode('{"access":"plain"}') });
  await repository.get('owner-3').then(
    () => {
      throw new Error('expected malformed envelope failure');
    },
    (error) => assert(String(error).includes('envelope is invalid'), 'expected envelope error'),
  );
});

Deno.test('credential encryption configuration requires exactly 32 decoded bytes', () => {
  assertCredentialEncryptionConfigured({ WEAVE_CREDENTIAL_ENCRYPTION_KEY: Buffer.from(keyA).toString('base64') });
  for (const value of [undefined, 'not base64!', Buffer.from(new Uint8Array(31)).toString('base64')]) {
    try {
      assertCredentialEncryptionConfigured({ WEAVE_CREDENTIAL_ENCRYPTION_KEY: value });
      throw new Error('expected invalid encryption key failure');
    } catch (error) {
      assert(String(error).includes('WEAVE_CREDENTIAL_ENCRYPTION_KEY'), 'expected actionable configuration error');
    }
  }
});
