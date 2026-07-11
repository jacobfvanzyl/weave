import { createHash } from 'node:crypto';
import {
  type ObjectStore,
  objectStore as defaultObjectStore,
  type ObjectStoreListItem,
} from '../../storage/object-store';
import { getWeaveDb, type WeaveDbClient } from '../../storage/postgres';
import { parseFrontmatter } from '../../instructions/frontmatter';

export type UserArtifactKind = 'prompt' | 'skill';

export type UserArtifactRecord = {
  ownerId: string;
  kind: UserArtifactKind;
  name: string;
  objectBucket: string;
  objectKey: string;
  objectPrefix?: string;
  contentHash: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type UserPromptDocument = UserArtifactRecord & {
  content: string;
};

export type UserSkillFile = {
  path: string;
  objectKey: string;
  sizeBytes?: number;
  updatedAt?: string;
  content?: string;
};

export type UserSkillDocument = UserArtifactRecord & {
  files: UserSkillFile[];
  entrypoint?: string;
};

export type PutPromptInput = {
  ownerId: string;
  name: string;
  content: string;
};

export type PutSkillInput = {
  ownerId: string;
  name: string;
  content: string;
};

export type PutSkillFileInput = {
  ownerId: string;
  name: string;
  path: string;
  content: string;
};

const artifactNamePattern = /^[A-Za-z0-9_-]+$/;
const skillEntrypoint = 'SKILL.md';
const textContentType = 'text/plain; charset=utf-8';
const markdownContentType = 'text/markdown; charset=utf-8';

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const requireOwnerId = (ownerId: string) => {
  const normalized = optionalString(ownerId);
  if (!normalized) throw new Error('ownerId is required.');
  return normalized;
};

const normalizeArtifactName = (name: string, label: string) => {
  const normalized = optionalString(name);
  if (!normalized || !artifactNamePattern.test(normalized)) {
    throw new Error(`${label} must contain only letters, numbers, underscores, and hyphens.`);
  }
  return normalized;
};

const normalizeSkillFilePath = (path: string) => {
  const normalizedInput = optionalString(path)?.replace(/\\/g, '/');
  if (!normalizedInput) throw new Error('Skill file path is required.');
  if (normalizedInput.startsWith('/') || /^[A-Za-z]:\//.test(normalizedInput)) {
    throw new Error('Skill file path must be relative.');
  }
  const parts: string[] = [];
  for (const part of normalizedInput.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error('Skill file path cannot escape the skill directory.');
    parts.push(part);
  }
  if (parts.length === 0) throw new Error('Skill file path is required.');
  return parts.join('/');
};

const ownerPrefix = (ownerId: string) => `users/${encodeURIComponent(ownerId)}`;
const promptKey = (ownerId: string, name: string) => `${ownerPrefix(ownerId)}/prompts/${name}.md`;
const skillPrefix = (ownerId: string, name: string) => `${ownerPrefix(ownerId)}/skills/${name}`;
const skillFileKey = (ownerId: string, name: string, path = skillEntrypoint) =>
  `${skillPrefix(ownerId, name)}/${normalizeSkillFilePath(path)}`;

const hashContent = (content: string) => createHash('sha256').update(content).digest('hex');
const byteLength = (content: string) => new TextEncoder().encode(content).byteLength;

const parseMetadata = (content: string) => {
  const { data } = parseFrontmatter(content);
  return data;
};

const parseMetadataColumn = (value: unknown): Record<string, unknown> => {
  if (!value) return {};
  if (typeof value === 'string') {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
};

const rowToRecord = (row: Record<string, unknown>): UserArtifactRecord => ({
  ownerId: String(row.owner_id),
  kind: String(row.artifact_kind) as UserArtifactKind,
  name: String(row.name),
  objectBucket: String(row.object_bucket),
  objectKey: String(row.object_key),
  objectPrefix: optionalString(row.object_prefix),
  contentHash: String(row.content_hash),
  sizeBytes: Number(row.size_bytes),
  metadata: parseMetadataColumn(row.metadata),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

const decodeObjectText = (body: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(body);

const relativeSkillObjectPath = (prefix: string, item: ObjectStoreListItem) => {
  const path = item.key.startsWith(`${prefix}/`) ? item.key.slice(prefix.length + 1) : item.key;
  return normalizeSkillFilePath(path);
};

export class UserArtifactRepository {
  constructor(
    private readonly getDb: () => Promise<WeaveDbClient> = getWeaveDb,
    private readonly objects: ObjectStore = defaultObjectStore,
  ) {}

  async listPrompts(ownerId: string) {
    return await this.listRecords(requireOwnerId(ownerId), 'prompt');
  }

  async getPrompt(ownerId: string, name: string): Promise<UserPromptDocument | undefined> {
    const record = await this.getRecord(requireOwnerId(ownerId), 'prompt', normalizeArtifactName(name, 'Prompt name'));
    if (!record) return undefined;
    const object = await this.objects.getObject({ bucket: record.objectBucket, key: record.objectKey });
    if (!object) return undefined;
    return { ...record, content: decodeObjectText(object.body) };
  }

  async putPrompt(input: PutPromptInput) {
    const ownerId = requireOwnerId(input.ownerId);
    const name = normalizeArtifactName(input.name, 'Prompt name');
    const key = promptKey(ownerId, name);
    await this.objects.putObject({
      key,
      body: input.content,
      contentType: markdownContentType,
    });
    return await this.saveRecord({
      ownerId,
      kind: 'prompt',
      name,
      objectBucket: this.objects.defaultBucket,
      objectKey: key,
      contentHash: hashContent(input.content),
      sizeBytes: byteLength(input.content),
      metadata: parseMetadata(input.content),
    });
  }

  async deletePrompt(ownerId: string, name: string) {
    const normalizedOwnerId = requireOwnerId(ownerId);
    const normalizedName = normalizeArtifactName(name, 'Prompt name');
    const record = await this.getRecord(normalizedOwnerId, 'prompt', normalizedName);
    if (record) await this.objects.deleteObject({ bucket: record.objectBucket, key: record.objectKey });
    return await this.deleteRecord(normalizedOwnerId, 'prompt', normalizedName);
  }

  async listSkills(ownerId: string) {
    return await this.listRecords(requireOwnerId(ownerId), 'skill');
  }

  async getSkill(ownerId: string, name: string): Promise<UserSkillDocument | undefined> {
    const record = await this.getRecord(requireOwnerId(ownerId), 'skill', normalizeArtifactName(name, 'Skill name'));
    if (!record?.objectPrefix) return undefined;
    const [entrypoint, files] = await Promise.all([
      this.objects.getObject({ bucket: record.objectBucket, key: record.objectKey }),
      this.listSkillFilesByRecord(record),
    ]);
    return {
      ...record,
      files,
      ...(entrypoint ? { entrypoint: decodeObjectText(entrypoint.body) } : {}),
    };
  }

  async putSkill(input: PutSkillInput) {
    return await this.putSkillFile({
      ownerId: input.ownerId,
      name: input.name,
      path: skillEntrypoint,
      content: input.content,
    });
  }

  async putSkillFile(input: PutSkillFileInput) {
    const ownerId = requireOwnerId(input.ownerId);
    const name = normalizeArtifactName(input.name, 'Skill name');
    const path = normalizeSkillFilePath(input.path);
    const key = skillFileKey(ownerId, name, path);
    const current = await this.getRecord(ownerId, 'skill', name);
    if (path !== skillEntrypoint && !current) {
      throw new Error('Create SKILL.md before adding supporting files to a skill.');
    }
    const contentType = path.endsWith('.md') ? markdownContentType : textContentType;
    await this.objects.putObject({ key, body: input.content, contentType });

    if (path !== skillEntrypoint) {
      return current!;
    }

    return await this.saveRecord({
      ownerId,
      kind: 'skill',
      name,
      objectBucket: this.objects.defaultBucket,
      objectKey: key,
      objectPrefix: skillPrefix(ownerId, name),
      contentHash: hashContent(input.content),
      sizeBytes: byteLength(input.content),
      metadata: parseMetadata(input.content),
    });
  }

  async getSkillFile(ownerId: string, name: string, path: string): Promise<UserSkillFile | undefined> {
    const record = await this.getRecord(
      requireOwnerId(ownerId),
      'skill',
      normalizeArtifactName(name, 'Skill name'),
    );
    if (!record?.objectPrefix) return undefined;
    const relativePath = normalizeSkillFilePath(path);
    const objectKey = `${record.objectPrefix}/${relativePath}`;
    const object = await this.objects.getObject({ bucket: record.objectBucket, key: objectKey });
    if (!object) return undefined;
    return {
      path: relativePath,
      objectKey,
      sizeBytes: object.contentLength ?? object.body.byteLength,
      updatedAt: object.lastModified?.toISOString(),
      content: decodeObjectText(object.body),
    };
  }

  async deleteSkillFile(ownerId: string, name: string, path: string) {
    const record = await this.getRecord(
      requireOwnerId(ownerId),
      'skill',
      normalizeArtifactName(name, 'Skill name'),
    );
    if (!record?.objectPrefix) return false;
    const relativePath = normalizeSkillFilePath(path);
    const objectKey = `${record.objectPrefix}/${relativePath}`;
    await this.objects.deleteObject({ bucket: record.objectBucket, key: objectKey });
    if (relativePath === skillEntrypoint) await this.deleteRecord(record.ownerId, 'skill', record.name);
    return true;
  }

  async deleteSkill(ownerId: string, name: string) {
    const normalizedOwnerId = requireOwnerId(ownerId);
    const normalizedName = normalizeArtifactName(name, 'Skill name');
    const record = await this.getRecord(normalizedOwnerId, 'skill', normalizedName);
    if (record?.objectPrefix) {
      const listed = await this.objects.listObjects({ bucket: record.objectBucket, prefix: `${record.objectPrefix}/` });
      await this.objects.deleteObjects({ bucket: record.objectBucket, keys: listed.objects.map((item) => item.key) });
    }
    return await this.deleteRecord(normalizedOwnerId, 'skill', normalizedName);
  }

  async readUserContextFiles(ownerId: string) {
    const [prompts, skills] = await Promise.all([
      this.listPrompts(ownerId),
      this.listSkills(ownerId),
    ]);
    const files = [];

    for (const prompt of prompts) {
      const object = await this.objects.getObject({ bucket: prompt.objectBucket, key: prompt.objectKey });
      if (!object) continue;
      files.push({
        kind: 'prompt' as const,
        path: prompt.objectKey,
        content: decodeObjectText(object.body),
        size: object.contentLength ?? object.body.byteLength,
        updatedAt: object.lastModified?.toISOString() ?? prompt.updatedAt,
      });
    }

    for (const skill of skills) {
      if (!skill.objectPrefix) continue;
      for (const file of await this.listSkillFilesByRecord(skill, { includeContent: true })) {
        if (typeof file.content !== 'string') continue;
        files.push({
          kind: 'skill' as const,
          path: file.objectKey,
          content: file.content,
          size: file.sizeBytes,
          updatedAt: file.updatedAt ?? skill.updatedAt,
        });
      }
    }

    return files;
  }

  private async listSkillFilesByRecord(
    record: UserArtifactRecord,
    options: { includeContent?: boolean } = {},
  ): Promise<UserSkillFile[]> {
    if (!record.objectPrefix) return [];
    const listed = await this.objects.listObjects({
      bucket: record.objectBucket,
      prefix: `${record.objectPrefix}/`,
    });
    const files = listed.objects.sort((a, b) => a.key.localeCompare(b.key));
    return await Promise.all(files.map(async (item) => {
      const path = relativeSkillObjectPath(record.objectPrefix ?? '', item);
      const base = {
        path,
        objectKey: item.key,
        sizeBytes: item.size,
        updatedAt: item.lastModified?.toISOString(),
      };
      if (!options.includeContent) return base;
      const object = await this.objects.getObject({ bucket: record.objectBucket, key: item.key });
      return {
        ...base,
        ...(object ? { content: decodeObjectText(object.body) } : {}),
      };
    }));
  }

  private async listRecords(ownerId: string, kind: UserArtifactKind) {
    const db = await this.getDb();
    const result = await db.execute({
      sql: `SELECT owner_id, artifact_kind, name, object_bucket, object_key, object_prefix,
          content_hash, size_bytes, metadata, created_at, updated_at
        FROM user_artifacts
        WHERE owner_id = ? AND artifact_kind = ?
        ORDER BY name ASC`,
      args: [ownerId, kind],
    });
    return result.rows.map(rowToRecord);
  }

  private async getRecord(ownerId: string, kind: UserArtifactKind, name: string) {
    const db = await this.getDb();
    const result = await db.execute({
      sql: `SELECT owner_id, artifact_kind, name, object_bucket, object_key, object_prefix,
          content_hash, size_bytes, metadata, created_at, updated_at
        FROM user_artifacts
        WHERE owner_id = ? AND artifact_kind = ? AND name = ?
        LIMIT 1`,
      args: [ownerId, kind, name],
    });
    const row = result.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  private async saveRecord(input: Omit<UserArtifactRecord, 'createdAt' | 'updatedAt'>) {
    const db = await this.getDb();
    const at = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO user_artifacts (
          owner_id, artifact_kind, name, object_bucket, object_key, object_prefix,
          content_hash, size_bytes, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, artifact_kind, name) DO UPDATE SET
          object_bucket = excluded.object_bucket,
          object_key = excluded.object_key,
          object_prefix = excluded.object_prefix,
          content_hash = excluded.content_hash,
          size_bytes = excluded.size_bytes,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at`,
      args: [
        input.ownerId,
        input.kind,
        input.name,
        input.objectBucket,
        input.objectKey,
        input.objectPrefix ?? null,
        input.contentHash,
        input.sizeBytes,
        JSON.stringify(input.metadata),
        at,
        at,
      ],
    });
    const saved = await this.getRecord(input.ownerId, input.kind, input.name);
    if (!saved) throw new Error('User artifact was not saved.');
    return saved;
  }

  private async deleteRecord(ownerId: string, kind: UserArtifactKind, name: string) {
    const db = await this.getDb();
    const result = await db.execute({
      sql: `DELETE FROM user_artifacts WHERE owner_id = ? AND artifact_kind = ? AND name = ?`,
      args: [ownerId, kind, name],
    });
    return Number(result.rowsAffected ?? 0) > 0;
  }
}

export const userArtifactRepository = new UserArtifactRepository();

export const __userArtifactRepositoryTest = {
  normalizeSkillFilePath,
  promptKey,
  skillFileKey,
  skillPrefix,
};
