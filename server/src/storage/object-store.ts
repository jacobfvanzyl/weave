import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export type ObjectStorePutInput = {
  bucket?: string;
  key: string;
  body: Uint8Array | string;
  contentType?: string;
  metadata?: Record<string, string>;
};

export type ObjectStoreGetInput = {
  bucket?: string;
  key: string;
};

export type ObjectStoreDeleteInput = {
  bucket?: string;
  key: string;
};

export type ObjectStoreDeleteManyInput = {
  bucket?: string;
  keys: string[];
};

export type ObjectStoreCopyInput = {
  bucket?: string;
  key: string;
  toBucket?: string;
  toKey: string;
};

export type ObjectStoreListInput = {
  bucket?: string;
  prefix?: string;
  delimiter?: string;
};

export type ObjectStoreObject = {
  key: string;
  body: Uint8Array;
  contentType?: string;
  contentLength?: number;
  etag?: string;
  lastModified?: Date;
  metadata?: Record<string, string>;
};

export type ObjectStoreListItem = {
  key: string;
  size?: number;
  etag?: string;
  lastModified?: Date;
};

export type ObjectStoreListResult = {
  objects: ObjectStoreListItem[];
  prefixes: string[];
};

export interface ObjectStore {
  readonly defaultBucket: string;
  putObject(input: ObjectStorePutInput): Promise<void>;
  getObject(input: ObjectStoreGetInput): Promise<ObjectStoreObject | null>;
  deleteObject(input: ObjectStoreDeleteInput): Promise<void>;
  deleteObjects(input: ObjectStoreDeleteManyInput): Promise<void>;
  copyObject(input: ObjectStoreCopyInput): Promise<void>;
  listObjects(input: ObjectStoreListInput): Promise<ObjectStoreListResult>;
}

export type ObjectStoreConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const booleanFromEnv = (value: string | undefined, defaultValue: boolean) => {
  if (value === undefined) return defaultValue;
  return /^(1|true|yes|on)$/i.test(value.trim());
};

export const getObjectStoreConfig = (env: NodeJS.ProcessEnv = process.env): ObjectStoreConfig | undefined => {
  const endpoint = optionalString(env.WEAVE_OBJECT_STORAGE_ENDPOINT);
  const bucket = optionalString(env.WEAVE_OBJECT_STORAGE_BUCKET);
  const accessKeyId = optionalString(env.WEAVE_OBJECT_STORAGE_ACCESS_KEY);
  const secretAccessKey = optionalString(env.WEAVE_OBJECT_STORAGE_SECRET_KEY);
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;

  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: optionalString(env.WEAVE_OBJECT_STORAGE_REGION) ?? 'garage',
    forcePathStyle: booleanFromEnv(env.WEAVE_OBJECT_STORAGE_FORCE_PATH_STYLE, true),
  };
};

export const requireObjectStoreConfig = (env: NodeJS.ProcessEnv = process.env) => {
  const config = getObjectStoreConfig(env);
  if (!config) {
    throw new Error(
      'Object storage is not configured. Set WEAVE_OBJECT_STORAGE_ENDPOINT, WEAVE_OBJECT_STORAGE_BUCKET, WEAVE_OBJECT_STORAGE_ACCESS_KEY, and WEAVE_OBJECT_STORAGE_SECRET_KEY.',
    );
  }
  return config;
};

const readSdkBody = async (body: unknown): Promise<Uint8Array> => {
  if (!body) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return new TextEncoder().encode(body);

  const transformable = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof transformable.transformToByteArray === 'function') {
    return await transformable.transformToByteArray();
  }

  const blobLike = body as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof blobLike.arrayBuffer === 'function') {
    return new Uint8Array(await blobLike.arrayBuffer());
  }

  const streamLike = body as ReadableStream<Uint8Array>;
  if (typeof streamLike.getReader === 'function') {
    const reader = streamLike.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
    }
    return concatChunks(chunks, total);
  }

  const iterable = body as AsyncIterable<Uint8Array | string>;
  if (typeof iterable[Symbol.asyncIterator] === 'function') {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of iterable) {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      chunks.push(bytes);
      total += bytes.byteLength;
    }
    return concatChunks(chunks, total);
  }

  throw new Error('Unsupported object storage response body.');
};

const concatChunks = (chunks: Uint8Array[], total: number) => {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const isNotFoundError = (error: unknown) => {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  return record.name === 'NoSuchKey' ||
    record.name === 'NotFound' ||
    (record.$metadata && typeof record.$metadata === 'object' &&
      (record.$metadata as Record<string, unknown>).httpStatusCode === 404);
};

const encodeCopySource = (bucket: string, key: string) =>
  `${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;

export class S3ObjectStore implements ObjectStore {
  readonly defaultBucket: string;
  private readonly client: S3Client;

  constructor(config: ObjectStoreConfig) {
    this.defaultBucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async putObject(input: ObjectStorePutInput) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: input.bucket ?? this.defaultBucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        Metadata: input.metadata,
      }),
    );
  }

  async getObject(input: ObjectStoreGetInput): Promise<ObjectStoreObject | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: input.bucket ?? this.defaultBucket,
          Key: input.key,
        }),
      );
      return {
        key: input.key,
        body: await readSdkBody(result.Body),
        contentType: result.ContentType,
        contentLength: result.ContentLength,
        etag: result.ETag,
        lastModified: result.LastModified,
        metadata: result.Metadata,
      };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async deleteObject(input: ObjectStoreDeleteInput) {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: input.bucket ?? this.defaultBucket,
        Key: input.key,
      }),
    );
  }

  async deleteObjects(input: ObjectStoreDeleteManyInput) {
    const bucket = input.bucket ?? this.defaultBucket;
    for (let index = 0; index < input.keys.length; index += 1000) {
      const keys = input.keys.slice(index, index + 1000);
      if (keys.length === 0) continue;
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: keys.map((key) => ({ Key: key })),
            Quiet: true,
          },
        }),
      );
    }
  }

  async copyObject(input: ObjectStoreCopyInput) {
    const sourceBucket = input.bucket ?? this.defaultBucket;
    const destinationBucket = input.toBucket ?? sourceBucket;
    await this.client.send(
      new CopyObjectCommand({
        Bucket: destinationBucket,
        Key: input.toKey,
        CopySource: encodeCopySource(sourceBucket, input.key),
        MetadataDirective: 'COPY',
      }),
    );
  }

  async listObjects(input: ObjectStoreListInput): Promise<ObjectStoreListResult> {
    const bucket = input.bucket ?? this.defaultBucket;
    const objects: ObjectStoreListItem[] = [];
    const prefixes = new Set<string>();
    let continuationToken: string | undefined;

    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: input.prefix,
          Delimiter: input.delimiter,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of result.Contents ?? []) {
        if (!object.Key) continue;
        objects.push({
          key: object.Key,
          size: object.Size,
          etag: object.ETag,
          lastModified: object.LastModified,
        });
      }
      for (const prefix of result.CommonPrefixes ?? []) {
        if (prefix.Prefix) prefixes.add(prefix.Prefix);
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    return { objects, prefixes: [...prefixes].sort() };
  }
}

export const createS3ObjectStoreFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  new S3ObjectStore(requireObjectStoreConfig(env));

class LazyObjectStore implements ObjectStore {
  private instance: ObjectStore | undefined;

  constructor(private readonly create: () => ObjectStore) {}

  get defaultBucket() {
    return this.get().defaultBucket;
  }

  putObject(input: ObjectStorePutInput) {
    return this.get().putObject(input);
  }

  getObject(input: ObjectStoreGetInput) {
    return this.get().getObject(input);
  }

  deleteObject(input: ObjectStoreDeleteInput) {
    return this.get().deleteObject(input);
  }

  deleteObjects(input: ObjectStoreDeleteManyInput) {
    return this.get().deleteObjects(input);
  }

  copyObject(input: ObjectStoreCopyInput) {
    return this.get().copyObject(input);
  }

  listObjects(input: ObjectStoreListInput) {
    return this.get().listObjects(input);
  }

  private get() {
    this.instance ??= this.create();
    return this.instance;
  }
}

export const objectStore: ObjectStore = new LazyObjectStore(() => createS3ObjectStoreFromEnv());
