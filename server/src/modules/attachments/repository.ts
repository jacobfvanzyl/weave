import { getWeaveDb, type WeaveDbClient } from '../../storage/postgres';
import type { StoredAttachmentMetadata } from './storage';

export type AttachmentMetadataRecord = StoredAttachmentMetadata & {
  objectBucket: string;
  objectKey: string;
  storedName: string;
  updatedAt: string;
};

export interface AttachmentMetadataRepository {
  save(metadata: AttachmentMetadataRecord): Promise<void>;
  get(id: string): Promise<AttachmentMetadataRecord | null>;
  findByThread(threadId: string): Promise<AttachmentMetadataRecord[]>;
  findByOriginalName(originalName: string, mimeType?: string): Promise<AttachmentMetadataRecord[]>;
  delete(id: string): Promise<void>;
}

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const rowToAttachmentMetadata = (row: Record<string, unknown>): AttachmentMetadataRecord => ({
  id: String(row.id),
  urlPath: `/attachments/${encodeURIComponent(String(row.id))}`,
  mimeType: String(row.mime_type),
  sizeBytes: Number(row.size_bytes),
  originalName: String(row.original_name),
  storedName: String(row.stored_name),
  objectBucket: String(row.object_bucket),
  objectKey: String(row.object_key),
  ownerId: optionalString(row.owner_id),
  threadId: optionalString(row.thread_id),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

export class PostgresAttachmentMetadataRepository implements AttachmentMetadataRepository {
  constructor(private readonly getDb: () => Promise<WeaveDbClient> = getWeaveDb) {}

  async save(metadata: AttachmentMetadataRecord) {
    const db = await this.getDb();
    await db.execute({
      sql: `INSERT INTO attachments (
          id, owner_id, thread_id, original_name, mime_type, size_bytes,
          object_bucket, object_key, stored_name, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          owner_id = excluded.owner_id,
          thread_id = excluded.thread_id,
          original_name = excluded.original_name,
          mime_type = excluded.mime_type,
          size_bytes = excluded.size_bytes,
          object_bucket = excluded.object_bucket,
          object_key = excluded.object_key,
          stored_name = excluded.stored_name,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at`,
      args: [
        metadata.id,
        metadata.ownerId,
        metadata.threadId,
        metadata.originalName,
        metadata.mimeType,
        metadata.sizeBytes,
        metadata.objectBucket,
        metadata.objectKey,
        metadata.storedName,
        metadata.createdAt,
        metadata.updatedAt,
      ],
    });
  }

  async get(id: string) {
    const db = await this.getDb();
    const result = await db.execute({
      sql: `SELECT id, owner_id, thread_id, original_name, mime_type, size_bytes,
          object_bucket, object_key, stored_name, created_at, updated_at
        FROM attachments
        WHERE id = ?`,
      args: [id],
    });
    const row = result.rows[0];
    return row ? rowToAttachmentMetadata(row) : null;
  }

  async findByThread(threadId: string) {
    const db = await this.getDb();
    const result = await db.execute({
      sql: `SELECT id, owner_id, thread_id, original_name, mime_type, size_bytes,
          object_bucket, object_key, stored_name, created_at, updated_at
        FROM attachments
        WHERE thread_id = ?
        ORDER BY created_at ASC, id ASC`,
      args: [threadId],
    });
    return result.rows.map(rowToAttachmentMetadata);
  }

  async findByOriginalName(originalName: string, mimeType?: string) {
    const db = await this.getDb();
    const result = await db.execute({
      sql: `SELECT id, owner_id, thread_id, original_name, mime_type, size_bytes,
          object_bucket, object_key, stored_name, created_at, updated_at
        FROM attachments
        WHERE original_name = ? ${mimeType ? 'AND mime_type = ?' : ''}
        ORDER BY created_at ASC, id ASC`,
      args: mimeType ? [originalName, mimeType] : [originalName],
    });
    return result.rows.map(rowToAttachmentMetadata);
  }

  async delete(id: string) {
    const db = await this.getDb();
    await db.execute({ sql: `DELETE FROM attachments WHERE id = ?`, args: [id] });
  }
}

export const attachmentMetadataRepository = new PostgresAttachmentMetadataRepository();
