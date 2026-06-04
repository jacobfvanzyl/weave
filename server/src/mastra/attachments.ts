import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type StoredAttachment = {
  id: string;
  urlPath: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
};

export type StoredAttachmentMetadata = StoredAttachment & {
  threadId?: string;
  createdAt: string;
};

export type AttachmentPayload = {
  bytes: Uint8Array;
  mimeType: string;
  originalName: string;
  threadId?: string;
};

export type AttachmentReadResult = {
  bytes: Uint8Array;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
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

const isSafeAttachmentId = (id: string) => /^[a-z0-9_-]+$/i.test(id) && id.length <= 128;
const modelAttachmentHost = 'weave.local';

const dataPath = (baseDir: string, id: string, storedName: string) => join(baseDir, id, storedName);
const metadataPath = (baseDir: string, id: string) => join(baseDir, id, 'metadata.json');

export const attachmentUrlPath = (id: string) => `/attachments/${encodeURIComponent(id)}`;
export const attachmentModelUrl = (id: string) => `https://${modelAttachmentHost}${attachmentUrlPath(id)}`;

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

export class LocalAttachmentStorage implements AttachmentStorage {
  constructor(private readonly baseDir: string) {}

  async put(input: AttachmentPayload): Promise<StoredAttachment> {
    const mimeType = input.mimeType.toLowerCase();
    if (!mimeType.startsWith('image/')) throw new Error(`Unsupported attachment type: ${input.mimeType}`);
    if (input.bytes.byteLength === 0) throw new Error('Attachment is empty');

    const id = `att_${randomUUID().replace(/-/g, '')}`;
    const originalName = safeName(input.originalName, 'image');
    const storedName = `content${inferExtension(mimeType, originalName)}`;
    const dir = join(this.baseDir, id);
    await mkdir(dir, { recursive: true });

    await writeFile(dataPath(this.baseDir, id, storedName), input.bytes);
    const metadata: AttachmentMetadata = {
      id,
      mimeType,
      sizeBytes: input.bytes.byteLength,
      originalName,
      storedName,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      createdAt: new Date().toISOString(),
    };
    await writeFile(metadataPath(this.baseDir, id), JSON.stringify(metadata, null, 2));

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

    try {
      const metadata = JSON.parse(await readFile(metadataPath(this.baseDir, id), 'utf8')) as AttachmentMetadata;
      if (metadata.id !== id || !metadata.storedName) return null;

      const path = dataPath(this.baseDir, id, metadata.storedName);
      const fileInfo = await stat(path);
      if (!fileInfo.isFile()) return null;

      return {
        bytes: await readFile(path),
        mimeType: metadata.mimeType,
        sizeBytes: metadata.sizeBytes,
        originalName: metadata.originalName,
      };
    } catch {
      return null;
    }
  }

  async findByThread(threadId: string): Promise<StoredAttachmentMetadata[]> {
    return this.findWhere(metadata => metadata.threadId === threadId);
  }

  async findByOriginalName(originalName: string, mimeType?: string): Promise<StoredAttachmentMetadata[]> {
    const normalizedName = safeName(originalName, 'image');
    const normalizedMimeType = mimeType?.toLowerCase();
    return this.findWhere(metadata =>
      metadata.originalName === normalizedName &&
      (!normalizedMimeType || metadata.mimeType === normalizedMimeType)
    );
  }

  private async findWhere(predicate: (metadata: AttachmentMetadata) => boolean): Promise<StoredAttachmentMetadata[]> {
    const { readdir } = await import('node:fs/promises');

    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      const attachments: StoredAttachmentMetadata[] = [];

      await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
        try {
          const metadata = JSON.parse(await readFile(metadataPath(this.baseDir, entry.name), 'utf8')) as AttachmentMetadata;
          if (!predicate(metadata)) return;
          attachments.push({
            id: metadata.id,
            urlPath: attachmentUrlPath(metadata.id),
            mimeType: metadata.mimeType,
            sizeBytes: metadata.sizeBytes,
            originalName: metadata.originalName,
            threadId: metadata.threadId,
            createdAt: metadata.createdAt,
          });
        } catch {
        }
      }));

      return attachments;
    } catch {
      return [];
    }
  }

  async delete(id: string): Promise<void> {
    if (!isSafeAttachmentId(id)) return;
    await rm(join(this.baseDir, id), { recursive: true, force: true });
  }
}

export const parseBase64DataUrl = (value: string): { mimeType: string; base64: string; bytes: Uint8Array } | null => {
  const match = /^data:([^,]+),([a-z0-9+/=\r\n ]+)$/i.exec(value.trim());
  if (!match) return null;

  const headerParts = (match[1] ?? '').split(';').map(part => part.trim()).filter(Boolean);
  if (headerParts.at(-1)?.toLowerCase() !== 'base64') return null;

  const mimeType = headerParts[0]?.toLowerCase();
  const base64 = match[2]?.replace(/\s+/g, '');
  if (!mimeType || !base64) return null;

  return { mimeType, base64, bytes: Buffer.from(base64, 'base64') };
};

export const attachmentStorage = new LocalAttachmentStorage(
  process.env.WEAVE_ATTACHMENTS_DIR ?? join(process.cwd(), '.data', 'attachments'),
);
