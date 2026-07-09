import { type AttachmentPayload, ObjectAttachmentStorage } from './storage.ts';
import type { AttachmentMetadataRecord, AttachmentMetadataRepository } from './repository.ts';
import type {
  ObjectStore,
  ObjectStoreCopyInput,
  ObjectStoreDeleteInput,
  ObjectStoreDeleteManyInput,
  ObjectStoreGetInput,
  ObjectStoreListInput,
  ObjectStoreListResult,
  ObjectStoreObject,
  ObjectStorePutInput,
} from '../../storage/object-store.ts';

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

class MemoryObjectStore implements ObjectStore {
  readonly defaultBucket = 'weave';
  readonly objects = new Map<string, ObjectStoreObject>();

  async putObject(input: ObjectStorePutInput) {
    const bucket = input.bucket ?? this.defaultBucket;
    const body = typeof input.body === 'string' ? new TextEncoder().encode(input.body) : input.body;
    const key = `${bucket}/${input.key}`;
    this.objects.set(key, {
      key: input.key,
      body,
      contentType: input.contentType,
      contentLength: body.byteLength,
      etag: `"${body.byteLength}-${this.objects.size}"`,
      lastModified: new Date('2026-07-08T00:00:00.000Z'),
      metadata: input.metadata,
    });
  }

  async getObject(input: ObjectStoreGetInput) {
    return this.objects.get(`${input.bucket ?? this.defaultBucket}/${input.key}`) ?? null;
  }

  async deleteObject(input: ObjectStoreDeleteInput) {
    this.objects.delete(`${input.bucket ?? this.defaultBucket}/${input.key}`);
  }

  async deleteObjects(input: ObjectStoreDeleteManyInput) {
    for (const key of input.keys) this.objects.delete(`${input.bucket ?? this.defaultBucket}/${key}`);
  }

  async copyObject(input: ObjectStoreCopyInput) {
    const source = this.objects.get(`${input.bucket ?? this.defaultBucket}/${input.key}`);
    if (!source) return;
    this.objects.set(`${input.toBucket ?? input.bucket ?? this.defaultBucket}/${input.toKey}`, {
      ...source,
      key: input.toKey,
    });
  }

  async listObjects(input: ObjectStoreListInput): Promise<ObjectStoreListResult> {
    const bucket = input.bucket ?? this.defaultBucket;
    const prefix = input.prefix ?? '';
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(`${bucket}/${prefix}`))
      .map(([, object]) => ({
        key: object.key,
        size: object.contentLength,
        etag: object.etag,
        lastModified: object.lastModified,
      }));
    return { objects, prefixes: [] };
  }
}

class MemoryAttachmentMetadataRepository implements AttachmentMetadataRepository {
  readonly records = new Map<string, AttachmentMetadataRecord>();

  async save(metadata: AttachmentMetadataRecord) {
    this.records.set(metadata.id, metadata);
  }

  async get(id: string) {
    return this.records.get(id) ?? null;
  }

  async findByThread(threadId: string): Promise<AttachmentMetadataRecord[]> {
    return [...this.records.values()].filter((record) => record.threadId === threadId);
  }

  async findByOriginalName(originalName: string, mimeType?: string): Promise<AttachmentMetadataRecord[]> {
    return [...this.records.values()].filter((record) =>
      record.originalName === originalName && (!mimeType || record.mimeType === mimeType)
    );
  }

  async delete(id: string) {
    this.records.delete(id);
  }
}

Deno.test('ObjectAttachmentStorage persists bytes in object storage and metadata in the repository', async () => {
  const objects = new MemoryObjectStore();
  const metadata = new MemoryAttachmentMetadataRepository();
  const storage = new ObjectAttachmentStorage(objects, metadata);
  const input: AttachmentPayload = {
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'IMAGE/PNG',
    originalName: 'Screenshot One.png',
    ownerId: 'owner-1',
    threadId: 'thread-1',
  };

  const stored = await storage.put(input);
  assert(stored.id.startsWith('att_'), 'expected generated attachment id');
  assertEquals(stored.mimeType, 'image/png');
  assertEquals(stored.originalName, 'Screenshot One.png');

  const record = await metadata.get(stored.id);
  assert(record, 'expected metadata record');
  assertEquals(record.objectBucket, 'weave');
  assertEquals(record.objectKey, `attachments/${stored.id}/content.png`);
  assertEquals(record.threadId, 'thread-1');
  assertEquals(objects.objects.has(`weave/${record.objectKey}`), true);

  const read = await storage.get(stored.id);
  assertEquals(Array.from(read?.bytes ?? []), [1, 2, 3]);
  assertEquals(read?.ownerId, 'owner-1');
  assertEquals((await storage.findByThread('thread-1')).map((item) => item.id), [stored.id]);
  assertEquals((await storage.findByOriginalName('Screenshot One.png', 'image/png')).map((item) => item.id), [
    stored.id,
  ]);

  await storage.delete(stored.id);
  assertEquals(await storage.get(stored.id), null);
  assertEquals(metadata.records.has(stored.id), false);
  assertEquals(objects.objects.has(`weave/${record.objectKey}`), false);
});
