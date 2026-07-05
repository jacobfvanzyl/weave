import { DefaultResourceService } from './resource-service.ts';
import type {
  AttachmentPayload,
  AttachmentReadResult,
  AttachmentStorage,
  StoredAttachment,
  StoredAttachmentMetadata,
} from '../modules/attachments/storage.ts';
import { callerForOwner } from './types.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

class MemoryAttachmentStorage implements AttachmentStorage {
  writes: AttachmentPayload[] = [];
  attachments = new Map<string, AttachmentReadResult & StoredAttachmentMetadata>();

  async put(input: AttachmentPayload): Promise<StoredAttachment> {
    this.writes.push(input);
    const id = `att_${this.writes.length}`;
    const metadata = {
      id,
      urlPath: `/attachments/${id}`,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      originalName: input.originalName,
      ownerId: input.ownerId,
      threadId: input.threadId,
      createdAt: '2026-07-05T00:00:00.000Z',
      bytes: input.bytes,
    };
    this.attachments.set(id, metadata);
    return {
      id,
      urlPath: metadata.urlPath,
      mimeType: metadata.mimeType,
      sizeBytes: metadata.sizeBytes,
      originalName: metadata.originalName,
    };
  }

  async get(id: string): Promise<AttachmentReadResult | null> {
    return this.attachments.get(id) ?? null;
  }

  async findByThread(threadId: string): Promise<StoredAttachmentMetadata[]> {
    return [...this.attachments.values()].filter((attachment) => attachment.threadId === threadId);
  }

  async findByOriginalName(originalName: string, mimeType?: string): Promise<StoredAttachmentMetadata[]> {
    return [...this.attachments.values()].filter((attachment) =>
      attachment.originalName === originalName && (!mimeType || attachment.mimeType === mimeType)
    );
  }

  async delete(id: string): Promise<void> {
    this.attachments.delete(id);
  }
}

Deno.test('ResourceService stores attachment owner from the caller', async () => {
  const storage = new MemoryAttachmentStorage();
  const resources = new DefaultResourceService(storage);
  const stored = await resources.putAttachment(callerForOwner('owner-1', 'ui'), {
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/png',
    originalName: 'image.png',
    threadId: 'thread-1',
  });

  assertEquals(stored.id, 'att_1');
  assertEquals(storage.writes[0].ownerId, 'owner-1');
});

Deno.test('ResourceService filters owner-scoped attachments for non-system callers', async () => {
  const storage = new MemoryAttachmentStorage();
  const resources = new DefaultResourceService(storage);
  const owner = callerForOwner('owner-1', 'ui');
  const otherOwner = callerForOwner('owner-2', 'ui');

  await resources.putAttachment(owner, {
    bytes: new Uint8Array([1]),
    mimeType: 'image/png',
    originalName: 'owned.png',
    threadId: 'thread-1',
  });

  assertEquals((await resources.getAttachment(owner, 'att_1'))?.originalName, 'owned.png');
  assertEquals(await resources.getAttachment(otherOwner, 'att_1'), null);
  assertEquals(await resources.findAttachmentsByThread(otherOwner, 'thread-1'), []);
  assertEquals((await resources.getAttachment(callerForOwner('system', 'system'), 'att_1'))?.originalName, 'owned.png');
});
