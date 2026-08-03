import {
  type _Object as S3Object,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export type ObjectManifestEntry = {
  key: string;
  size: number;
  etag?: string;
};

type StoreConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

const value = (name: string, fallback?: string) => {
  const resolved = Deno.env.get(name)?.trim() || fallback;
  if (!resolved) throw new Error(`${name} is required for Garage cutover.`);
  return resolved;
};

const sourceConfig = (): StoreConfig => ({
  endpoint: value('WEAVE_OBJECT_STORAGE_ENDPOINT', 'http://127.0.0.1:3900'),
  region: value('WEAVE_OBJECT_STORAGE_REGION', 'garage'),
  bucket: value('WEAVE_OBJECT_STORAGE_BUCKET', 'weave'),
  accessKeyId: value('WEAVE_OBJECT_STORAGE_ACCESS_KEY'),
  secretAccessKey: value('WEAVE_OBJECT_STORAGE_SECRET_KEY'),
});

const destinationConfig = (source: StoreConfig): StoreConfig => ({
  endpoint: value('WEAVE_REMOTE_OBJECT_STORAGE_ENDPOINT', 'http://bazzite:3900'),
  region: value('WEAVE_REMOTE_OBJECT_STORAGE_REGION', source.region),
  bucket: value('WEAVE_REMOTE_OBJECT_STORAGE_BUCKET', source.bucket),
  accessKeyId: value('WEAVE_REMOTE_OBJECT_STORAGE_ACCESS_KEY', source.accessKeyId),
  secretAccessKey: value('WEAVE_REMOTE_OBJECT_STORAGE_SECRET_KEY', source.secretAccessKey),
});

const clientFor = (config: StoreConfig) =>
  new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

const normalizeEtag = (etag?: string) => etag?.replaceAll('"', '');

const manifestEntry = (object: S3Object): ObjectManifestEntry | undefined =>
  object.Key
    ? { key: object.Key, size: object.Size ?? 0, ...(object.ETag ? { etag: normalizeEtag(object.ETag) } : {}) }
    : undefined;

export const objectManifest = (objects: S3Object[]) =>
  objects.map(manifestEntry).filter((entry): entry is ObjectManifestEntry => Boolean(entry)).sort((a, b) =>
    a.key.localeCompare(b.key)
  );

const listObjects = async (client: S3Client, bucket: string) => {
  const objects: S3Object[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
    objects.push(...(page.Contents ?? []));
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
};

export const assertMatchingObjectManifests = (
  source: ObjectManifestEntry[],
  destination: ObjectManifestEntry[],
) => {
  if (source.length !== destination.length) {
    throw new Error(`Garage object count mismatch: source=${source.length}, destination=${destination.length}.`);
  }
  for (let index = 0; index < source.length; index += 1) {
    const left = source[index];
    const right = destination[index];
    if (left.key !== right.key || left.size !== right.size) {
      throw new Error(
        `Garage object mismatch at index ${index}: source=${left.key}:${left.size}, destination=${right.key}:${right.size}.`,
      );
    }
  }
};

const main = async () => {
  const sourceStore = sourceConfig();
  const destinationStore = destinationConfig(sourceStore);
  const source = clientFor(sourceStore);
  const destination = clientFor(destinationStore);
  try {
    const sourceObjects = await listObjects(source, sourceStore.bucket);
    const existing = new Map(
      (await listObjects(destination, destinationStore.bucket))
        .map(manifestEntry)
        .filter((entry): entry is ObjectManifestEntry => Boolean(entry))
        .map((entry) => [entry.key, entry]),
    );
    let copied = 0;
    let copiedBytes = 0;

    for (const object of sourceObjects) {
      const entry = manifestEntry(object);
      if (!entry) continue;
      const remote = existing.get(entry.key);
      if (remote?.size === entry.size && (!entry.etag || remote.etag === entry.etag)) continue;

      const fetched = await source.send(new GetObjectCommand({ Bucket: sourceStore.bucket, Key: entry.key }));
      if (!fetched.Body) throw new Error(`Source Garage object ${entry.key} had no body.`);
      const body = await fetched.Body.transformToByteArray();
      await destination.send(
        new PutObjectCommand({
          Bucket: destinationStore.bucket,
          Key: entry.key,
          Body: body,
          ContentType: fetched.ContentType,
          ContentDisposition: fetched.ContentDisposition,
          CacheControl: fetched.CacheControl,
          Metadata: fetched.Metadata,
        }),
      );
      copied += 1;
      copiedBytes += body.byteLength;
      console.info(`[garage:copy] ${entry.key} (${body.byteLength} bytes)`);
    }

    const sourceManifest = objectManifest(sourceObjects);
    const destinationManifest = objectManifest(await listObjects(destination, destinationStore.bucket));
    assertMatchingObjectManifests(sourceManifest, destinationManifest);
    const totalBytes = sourceManifest.reduce((sum, object) => sum + object.size, 0);
    console.info(
      `[garage:copy] verified ${sourceManifest.length} object(s), ${totalBytes} bytes; ` +
        `copied ${copied} object(s), ${copiedBytes} bytes.`,
    );
  } finally {
    source.destroy();
    destination.destroy();
  }
};

if (import.meta.main) await main();
