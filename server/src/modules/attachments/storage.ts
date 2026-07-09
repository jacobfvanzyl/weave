import { randomUUID } from 'node:crypto';
import { type AttachmentMetadataRepository, attachmentMetadataRepository } from './repository';
import { type ObjectStore, objectStore } from '../../storage/object-store';

export type StoredAttachment = {
  id: string;
  urlPath: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
};

export type StoredAttachmentMetadata = StoredAttachment & {
  ownerId?: string;
  threadId?: string;
  createdAt: string;
};

export type AttachmentPayload = {
  bytes: Uint8Array;
  mimeType: string;
  originalName: string;
  ownerId?: string;
  threadId?: string;
};

export type AttachmentReadResult = {
  bytes: Uint8Array;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  ownerId?: string;
  threadId?: string;
};

export interface AttachmentStorage {
  put(input: AttachmentPayload): Promise<StoredAttachment>;
  get(id: string): Promise<AttachmentReadResult | null>;
  findByThread(threadId: string): Promise<StoredAttachmentMetadata[]>;
  findByOriginalName(originalName: string, mimeType?: string): Promise<StoredAttachmentMetadata[]>;
  delete(id: string): Promise<void>;
}

type AttachmentMetadata = {
  id: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  storedName: string;
  ownerId?: string;
  threadId?: string;
  createdAt: string;
};

const safeName = (value: string, fallback: string) => {
  const normalized = value
    .trim()
    .replace(/[/\\]/g, '-')
    .replace(/[^\w.\- ]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 160)
    .replace(/^[.\- ]+|[.\- ]+$/g, '');

  return normalized || fallback;
};

const imageExtensionByMimeType: Record<string, string> = {
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/tiff': '.tiff',
  'image/webp': '.webp',
};

const extensionFromName = (name: string) => {
  const match = /\.([a-z0-9]{1,8})$/i.exec(name);
  return match ? `.${match[1].toLowerCase()}` : '';
};

const inferExtension = (mimeType: string, name: string) =>
  imageExtensionByMimeType[mimeType.toLowerCase()] ?? (extensionFromName(name) || '.bin');

export const isSafeAttachmentId = (id: string) => /^[a-z0-9_-]+$/i.test(id) && id.length <= 128;
const modelAttachmentHost = 'weave.local';

export const attachmentUrlPath = (id: string) => `/attachments/${encodeURIComponent(id)}`;
export const attachmentModelUrl = (id: string) => `https://${modelAttachmentHost}${attachmentUrlPath(id)}`;
export const attachmentObjectKey = (id: string, storedName: string) => `attachments/${id}/${storedName}`;

export const attachmentIdFromReference = (value: string) => {
  const matchPath = /^\/attachments\/([^/?#]+)$/.exec(value);
  if (matchPath?.[1]) return decodeURIComponent(matchPath[1]);

  try {
    const url = new URL(value);
    if (url.hostname !== modelAttachmentHost || url.pathname.split('/')[1] !== 'attachments') return undefined;
    const id = url.pathname.split('/')[2];
    return id ? decodeURIComponent(id) : undefined;
  } catch {
    return undefined;
  }
};

export class ObjectAttachmentStorage implements AttachmentStorage {
  constructor(
    private readonly objects: ObjectStore = objectStore,
    private readonly metadata: AttachmentMetadataRepository = attachmentMetadataRepository,
    private readonly bucket?: string,
  ) {}

  async put(input: AttachmentPayload): Promise<StoredAttachment> {
    const mimeType = input.mimeType.toLowerCase();
    if (!mimeType.startsWith('image/')) throw new Error(`Unsupported attachment type: ${input.mimeType}`);
    if (input.bytes.byteLength === 0) throw new Error('Attachment is empty');

    const id = `att_${randomUUID().replace(/-/g, '')}`;
    const originalName = safeName(input.originalName, 'image');
    const storedName = `content${inferExtension(mimeType, originalName)}`;
    const objectBucket = this.bucket ?? this.objects.defaultBucket;
    const objectKey = attachmentObjectKey(id, storedName);
    const createdAt = new Date().toISOString();

    await this.objects.putObject({
      bucket: objectBucket,
      key: objectKey,
      body: input.bytes,
      contentType: mimeType,
      metadata: {
        attachmentId: id,
        originalName,
      },
    });
    const metadata: AttachmentMetadata = {
      id,
      mimeType,
      sizeBytes: input.bytes.byteLength,
      originalName,
      storedName,
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      createdAt,
    };
    try {
      await this.metadata.save({
        ...metadata,
        objectBucket,
        objectKey,
        updatedAt: createdAt,
        urlPath: attachmentUrlPath(id),
      });
    } catch (error) {
      await this.objects.deleteObject({ bucket: objectBucket, key: objectKey }).catch(() => undefined);
      throw error;
    }

    return {
      id,
      urlPath: attachmentUrlPath(id),
      mimeType,
      sizeBytes: input.bytes.byteLength,
      originalName,
    };
  }

  async get(id: string): Promise<AttachmentReadResult | null> {
    if (!isSafeAttachmentId(id)) return null;

    const metadata = await this.metadata.get(id);
    if (!metadata) return null;
    const object = await this.objects.getObject({ bucket: metadata.objectBucket, key: metadata.objectKey });
    if (!object) return null;

    return {
      bytes: object.body,
      mimeType: metadata.mimeType,
      sizeBytes: metadata.sizeBytes,
      originalName: metadata.originalName,
      ownerId: metadata.ownerId,
      threadId: metadata.threadId,
    };
  }

  async findByThread(threadId: string): Promise<StoredAttachmentMetadata[]> {
    return this.metadata.findByThread(threadId);
  }

  async findByOriginalName(originalName: string, mimeType?: string): Promise<StoredAttachmentMetadata[]> {
    const normalizedName = safeName(originalName, 'image');
    const normalizedMimeType = mimeType?.toLowerCase();
    return this.metadata.findByOriginalName(normalizedName, normalizedMimeType);
  }

  async delete(id: string): Promise<void> {
    if (!isSafeAttachmentId(id)) return;
    const metadata = await this.metadata.get(id);
    if (!metadata) return;
    await this.objects.deleteObject({ bucket: metadata.objectBucket, key: metadata.objectKey }).catch(() => undefined);
    await this.metadata.delete(id);
  }
}

export const parseBase64DataUrl = (value: string): { mimeType: string; base64: string; bytes: Uint8Array } | null => {
  const match = /^data:([^,]+),([a-z0-9+/=\r\n ]+)$/i.exec(value.trim());
  if (!match) return null;

  const headerParts = (match[1] ?? '').split(';').map((part) => part.trim()).filter(Boolean);
  if (headerParts.at(-1)?.toLowerCase() !== 'base64') return null;

  const mimeType = headerParts[0]?.toLowerCase();
  const base64 = match[2]?.replace(/\s+/g, '');
  if (!mimeType || !base64) return null;

  return { mimeType, base64, bytes: Buffer.from(base64, 'base64') };
};

export const attachmentStorage = new ObjectAttachmentStorage();
