import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { attachmentMetadataRepository } from './repository';
import { attachmentObjectKey, attachmentUrlPath, isSafeAttachmentId } from './storage';
import { objectStore } from '../../storage/object-store';

type LocalAttachmentMetadata = {
  id?: unknown;
  mimeType?: unknown;
  sizeBytes?: unknown;
  originalName?: unknown;
  storedName?: unknown;
  ownerId?: unknown;
  threadId?: unknown;
  createdAt?: unknown;
};

type ImportOptions = {
  baseDir: string;
  dryRun?: boolean;
};

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const metadataPath = (baseDir: string, id: string) => join(baseDir, id, 'metadata.json');
const contentPath = (baseDir: string, id: string, storedName: string) => join(baseDir, id, storedName);

const parseArgs = () => {
  const dryRun = Deno.args.includes('--dry-run');
  const dirArgIndex = Deno.args.findIndex((arg) => arg === '--dir');
  const dirArg = dirArgIndex >= 0 ? optionalString(Deno.args[dirArgIndex + 1]) : undefined;
  return {
    dryRun,
    baseDir: dirArg ?? process.env.WEAVE_ATTACHMENTS_DIR ?? join(process.cwd(), '.data', 'attachments'),
  };
};

const readLocalMetadata = async (baseDir: string, id: string) =>
  JSON.parse(await readFile(metadataPath(baseDir, id), 'utf8')) as LocalAttachmentMetadata;

const validateMetadata = (entryName: string, metadata: LocalAttachmentMetadata) => {
  const id = optionalString(metadata.id) ?? entryName;
  const storedName = optionalString(metadata.storedName);
  const mimeType = optionalString(metadata.mimeType)?.toLowerCase();
  const originalName = optionalString(metadata.originalName);
  const createdAt = optionalString(metadata.createdAt) ?? new Date().toISOString();
  if (!isSafeAttachmentId(id)) throw new Error(`Invalid attachment id: ${id}`);
  if (id !== entryName) throw new Error(`Attachment id mismatch: ${entryName} metadata contains ${id}`);
  if (!storedName || storedName.includes('/') || storedName.includes('\\')) {
    throw new Error(`Invalid storedName for ${id}`);
  }
  if (!mimeType) throw new Error(`Missing mimeType for ${id}`);
  if (!originalName) throw new Error(`Missing originalName for ${id}`);
  return {
    id,
    storedName,
    mimeType,
    originalName,
    ownerId: optionalString(metadata.ownerId),
    threadId: optionalString(metadata.threadId),
    createdAt,
  };
};

export const importLocalAttachments = async ({ baseDir, dryRun = false }: ImportOptions) => {
  const entries = await readdir(baseDir, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  let imported = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const metadata = validateMetadata(entry.name, await readLocalMetadata(baseDir, entry.name));
      const path = contentPath(baseDir, metadata.id, metadata.storedName);
      const fileInfo = await stat(path);
      if (!fileInfo.isFile()) throw new Error('content is not a file');
      const sizeBytes = fileInfo.size;
      const objectBucket = objectStore.defaultBucket;
      const objectKey = attachmentObjectKey(metadata.id, metadata.storedName);

      if (!dryRun) {
        const bytes = await readFile(path);
        await objectStore.putObject({
          bucket: objectBucket,
          key: objectKey,
          body: bytes,
          contentType: metadata.mimeType,
          metadata: {
            attachmentId: metadata.id,
            originalName: metadata.originalName,
          },
        });
        await attachmentMetadataRepository.save({
          id: metadata.id,
          urlPath: attachmentUrlPath(metadata.id),
          mimeType: metadata.mimeType,
          sizeBytes,
          originalName: metadata.originalName,
          storedName: metadata.storedName,
          objectBucket,
          objectKey,
          ownerId: metadata.ownerId,
          threadId: metadata.threadId,
          createdAt: metadata.createdAt,
          updatedAt: new Date().toISOString(),
        });
      }

      imported += 1;
      console.info(`${dryRun ? '[dry-run] ' : ''}imported ${metadata.id} -> s3://${objectBucket}/${objectKey}`);
    } catch (error) {
      skipped += 1;
      console.warn(`skipped ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { imported, skipped };
};

if (import.meta.main) {
  const options = parseArgs();
  const result = await importLocalAttachments(options);
  console.info(
    `${
      options.dryRun ? '[dry-run] ' : ''
    }local attachment import complete: ${result.imported} imported, ${result.skipped} skipped`,
  );
}
