import { UserArtifactRepository } from './repository.ts';
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
import type { WeaveDbClient, WeaveDbStatement } from '../../storage/postgres.ts';

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
    this.objects.set(`${bucket}/${input.key}`, {
      key: input.key,
      body,
      contentType: input.contentType,
      contentLength: body.byteLength,
      etag: `"${body.byteLength}-${this.objects.size}"`,
      lastModified: new Date('2026-07-09T00:00:00.000Z'),
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

class MemoryUserArtifactDb implements WeaveDbClient {
  readonly records = new Map<string, Record<string, unknown>>();

  async execute(statement: WeaveDbStatement) {
    if (typeof statement === 'string') throw new Error(`Unexpected SQL: ${statement}`);
    const sql = statement.sql;
    const args = statement.args ?? [];

    if (sql.includes('INSERT INTO user_artifacts')) {
      const [
        ownerId,
        kind,
        name,
        objectBucket,
        objectKey,
        objectPrefix,
        contentHash,
        sizeBytes,
        metadata,
        createdAt,
        updatedAt,
      ] = args;
      const key = `${ownerId}:${kind}:${name}`;
      const existing = this.records.get(key);
      this.records.set(key, {
        owner_id: ownerId,
        artifact_kind: kind,
        name,
        object_bucket: objectBucket,
        object_key: objectKey,
        object_prefix: objectPrefix,
        content_hash: contentHash,
        size_bytes: sizeBytes,
        metadata,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
      });
      return { rows: [], rowsAffected: 1 };
    }

    if (sql.includes('DELETE FROM user_artifacts')) {
      const deleted = this.records.delete(`${args[0]}:${args[1]}:${args[2]}`);
      return { rows: [], rowsAffected: deleted ? 1 : 0 };
    }

    if (sql.includes('FROM user_artifacts') && sql.includes('name = ?')) {
      const row = this.records.get(`${args[0]}:${args[1]}:${args[2]}`);
      return { rows: row ? [row] : [], rowsAffected: 0 };
    }

    if (sql.includes('FROM user_artifacts') && sql.includes('ORDER BY name ASC')) {
      return {
        rows: [...this.records.values()]
          .filter((row) => row.owner_id === args[0] && row.artifact_kind === args[1])
          .sort((left, right) => String(left.name).localeCompare(String(right.name))),
        rowsAffected: 0,
      };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  }

  async batch(statements: WeaveDbStatement[]) {
    return await Promise.all(statements.map((statement) => this.execute(statement)));
  }
}

const createRepository = () => {
  const db = new MemoryUserArtifactDb();
  const objects = new MemoryObjectStore();
  return {
    db,
    objects,
    repository: new UserArtifactRepository(() => Promise.resolve(db), objects),
  };
};

Deno.test('UserArtifactRepository stores prompt Markdown under users/{ownerId}/prompts', async () => {
  const { objects, repository } = createRepository();
  const stored = await repository.putPrompt({
    ownerId: 'owner-1',
    name: 'ship',
    content: '---\ndescription: Ship prompt\n---\nShip $ARGUMENTS\n',
  });

  assertEquals(stored.objectBucket, 'weave');
  assertEquals(stored.objectKey, 'users/owner-1/prompts/ship.md');
  assertEquals(stored.metadata, { description: 'Ship prompt' });
  assert(objects.objects.has('weave/users/owner-1/prompts/ship.md'), 'expected prompt object');

  const prompt = await repository.getPrompt('owner-1', 'ship');
  assertEquals(prompt?.content, '---\ndescription: Ship prompt\n---\nShip $ARGUMENTS\n');
  assertEquals((await repository.listPrompts('owner-1')).map((item) => item.name), ['ship']);
  assertEquals((await repository.readUserContextFiles('owner-1')).map((file) => `${file.kind}:${file.path}`), [
    'prompt:users/owner-1/prompts/ship.md',
  ]);

  assertEquals(await repository.deletePrompt('owner-1', 'ship'), true);
  assertEquals(await repository.getPrompt('owner-1', 'ship'), undefined);
  assertEquals(objects.objects.has('weave/users/owner-1/prompts/ship.md'), false);
});

Deno.test('UserArtifactRepository preserves skill directories with auxiliary files', async () => {
  const { objects, repository } = createRepository();

  const stored = await repository.putSkill({
    ownerId: 'owner-1',
    name: 'release',
    content: '---\nname: release\ndescription: Release skill\n---\nRelease body\n',
  });
  await repository.putSkillFile({
    ownerId: 'owner-1',
    name: 'release',
    path: 'references/notes.md',
    content: '# Notes\n',
  });
  await repository.putSkillFile({
    ownerId: 'owner-1',
    name: 'release',
    path: 'scripts/release.ts',
    content: 'export const run = () => true;\n',
  });

  assertEquals(stored.objectKey, 'users/owner-1/skills/release/SKILL.md');
  assertEquals(stored.objectPrefix, 'users/owner-1/skills/release');
  assertEquals(stored.metadata, { name: 'release', description: 'Release skill' });

  const skill = await repository.getSkill('owner-1', 'release');
  assertEquals(skill?.entrypoint, '---\nname: release\ndescription: Release skill\n---\nRelease body\n');
  assertEquals(skill?.files.map((file) => file.path).sort(), [
    'SKILL.md',
    'references/notes.md',
    'scripts/release.ts',
  ]);
  assertEquals((await repository.getSkillFile('owner-1', 'release', 'references/notes.md'))?.content, '# Notes\n');
  assertEquals((await repository.readUserContextFiles('owner-1')).map((file) => `${file.kind}:${file.path}`).sort(), [
    'skill:users/owner-1/skills/release/SKILL.md',
    'skill:users/owner-1/skills/release/references/notes.md',
    'skill:users/owner-1/skills/release/scripts/release.ts',
  ]);

  assertEquals(await repository.deleteSkillFile('owner-1', 'release', 'references/notes.md'), true);
  assertEquals(await repository.getSkillFile('owner-1', 'release', 'references/notes.md'), undefined);

  assertEquals(await repository.deleteSkill('owner-1', 'release'), true);
  assertEquals(await repository.getSkill('owner-1', 'release'), undefined);
  assertEquals([...objects.objects.keys()].filter((key) => key.includes('/skills/release/')), []);
});

Deno.test('UserArtifactRepository requires SKILL.md before supporting skill files', async () => {
  const { repository } = createRepository();

  let message = '';
  try {
    await repository.putSkillFile({
      ownerId: 'owner-1',
      name: 'release',
      path: 'references/notes.md',
      content: '# Notes\n',
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assertEquals(message, 'Create SKILL.md before adding supporting files to a skill.');
});
