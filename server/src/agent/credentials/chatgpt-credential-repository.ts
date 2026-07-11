import { Buffer } from 'node:buffer';
import { type ObjectStore, objectStore as defaultObjectStore } from '../../storage/object-store';

export type ChatGPTCredentials = {
  access: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
};

type CredentialEnvelope = {
  version: 1;
  algorithm: 'A256GCM';
  iv: string;
  ciphertext: string;
};

const credentialProviderId = 'chatgpt-codex';
const credentialContentType = 'application/vnd.weave.encrypted-credential+json';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const arrayBuffer = (bytes: Uint8Array) => new Uint8Array(bytes).buffer;

const requireOwnerId = (ownerId: string) => {
  const value = ownerId.trim();
  if (!value) throw new Error('Credential owner id is required.');
  return value;
};

export const chatGPTCredentialObjectKey = (ownerId: string) =>
  `users/${encodeURIComponent(requireOwnerId(ownerId))}/credentials/chatgpt-codex.v1.json`;

const credentialAad = (ownerId: string) =>
  encoder.encode(`weave:credential:v1:${requireOwnerId(ownerId)}:${credentialProviderId}`);

const decodeEncryptionKey = (value: string | undefined) => {
  const raw = value?.trim();
  if (!raw || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) {
    throw new Error('WEAVE_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }

  const bytes = Buffer.from(raw, raw.includes('-') || raw.includes('_') ? 'base64url' : 'base64');
  if (bytes.byteLength !== 32) {
    throw new Error('WEAVE_CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }
  return new Uint8Array(bytes);
};

export const getCredentialEncryptionKey = (env: NodeJS.ProcessEnv = process.env) =>
  decodeEncryptionKey(env.WEAVE_CREDENTIAL_ENCRYPTION_KEY);

export const assertCredentialEncryptionConfigured = (env: NodeJS.ProcessEnv = process.env) => {
  getCredentialEncryptionKey(env);
};

const importEncryptionKey = (bytes: Uint8Array) =>
  crypto.subtle.importKey('raw', arrayBuffer(bytes), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

const parseCredentials = (value: unknown): ChatGPTCredentials => {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (!record || typeof record.access !== 'string' || !record.access) {
    throw new Error('Stored ChatGPT credentials are invalid.');
  }
  if (record.refresh !== undefined && typeof record.refresh !== 'string') {
    throw new Error('Stored ChatGPT credentials are invalid.');
  }
  if (record.expires !== undefined && (typeof record.expires !== 'number' || !Number.isFinite(record.expires))) {
    throw new Error('Stored ChatGPT credentials are invalid.');
  }
  if (record.accountId !== undefined && typeof record.accountId !== 'string') {
    throw new Error('Stored ChatGPT credentials are invalid.');
  }
  return {
    access: record.access,
    ...(record.refresh ? { refresh: record.refresh } : {}),
    ...(typeof record.expires === 'number' ? { expires: record.expires } : {}),
    ...(record.accountId ? { accountId: record.accountId } : {}),
  };
};

const parseEnvelope = (body: Uint8Array): CredentialEnvelope => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(body));
  } catch {
    throw new Error('Stored ChatGPT credential envelope is invalid.');
  }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
  const keys = record ? Object.keys(record).sort() : [];
  if (
    !record ||
    keys.join(',') !== 'algorithm,ciphertext,iv,version' ||
    record.version !== 1 ||
    record.algorithm !== 'A256GCM' ||
    typeof record.iv !== 'string' ||
    typeof record.ciphertext !== 'string'
  ) {
    throw new Error('Stored ChatGPT credential envelope is invalid.');
  }
  return record as CredentialEnvelope;
};

export class ChatGPTCredentialRepository {
  constructor(
    private readonly objects: ObjectStore = defaultObjectStore,
    private readonly encryptionKey: () => Uint8Array = getCredentialEncryptionKey,
  ) {}

  async get(ownerId: string): Promise<ChatGPTCredentials | undefined> {
    const normalizedOwnerId = requireOwnerId(ownerId);
    const object = await this.objects.getObject({ key: chatGPTCredentialObjectKey(normalizedOwnerId) });
    if (!object) return undefined;

    const envelope = parseEnvelope(object.body);
    try {
      const key = await importEncryptionKey(this.encryptionKey());
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: arrayBuffer(Buffer.from(envelope.iv, 'base64url')),
          additionalData: arrayBuffer(credentialAad(normalizedOwnerId)),
          tagLength: 128,
        },
        key,
        arrayBuffer(Buffer.from(envelope.ciphertext, 'base64url')),
      );
      return parseCredentials(JSON.parse(decoder.decode(plaintext)));
    } catch (error) {
      if (error instanceof Error && error.message === 'Stored ChatGPT credentials are invalid.') throw error;
      throw new Error('Stored ChatGPT credentials could not be decrypted.');
    }
  }

  async put(ownerId: string, credentials: ChatGPTCredentials): Promise<void> {
    const normalizedOwnerId = requireOwnerId(ownerId);
    const normalizedCredentials = parseCredentials(credentials);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await importEncryptionKey(this.encryptionKey());
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: arrayBuffer(iv),
        additionalData: arrayBuffer(credentialAad(normalizedOwnerId)),
        tagLength: 128,
      },
      key,
      arrayBuffer(encoder.encode(JSON.stringify(normalizedCredentials))),
    );
    const envelope: CredentialEnvelope = {
      version: 1,
      algorithm: 'A256GCM',
      iv: Buffer.from(iv).toString('base64url'),
      ciphertext: Buffer.from(ciphertext).toString('base64url'),
    };
    await this.objects.putObject({
      key: chatGPTCredentialObjectKey(normalizedOwnerId),
      body: JSON.stringify(envelope),
      contentType: credentialContentType,
    });
  }
}

export const chatGPTCredentialRepository = new ChatGPTCredentialRepository();
