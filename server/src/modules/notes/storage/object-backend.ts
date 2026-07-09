import { Buffer } from 'node:buffer';
import { type ObjectStore, objectStore, type ObjectStoreObject } from '../../../storage/object-store';
import type {
  NotesVaultAttachment,
  NotesVaultBackend,
  NotesVaultEntry,
  NotesVaultFile,
  NotesVaultIndexResult,
  NotesVaultNote,
  ResolvedNotesVaultBinding,
} from './types';

const directoryMarkerName = '.weave-dir';
const defaultMaxReadBytes = 2 * 1024 * 1024;
const defaultMaxIndexBytes = 2 * 1024 * 1024;
const maxIndexedFiles = 5_000;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');
const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const removeExtension = (name: string) => name.replace(/\.[^.]+$/, '');
const getBasename = (path: string) => path.split('/').filter(Boolean).pop() ?? path;
const getParentPath = (path: string) => path.split('/').filter(Boolean).slice(0, -1).join('/');
const isMarkdownPath = (path: string) => /\.(md|markdown)$/i.test(path);
const isExcalidrawPath = (path: string) => /\.excalidraw$/i.test(path);
const isCoppermindPath = (path: string) => /\.cpr$/i.test(path);

const normalizeRelativePath = (value: unknown, name = 'path') => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  if (value.includes('\0')) throw new Error(`${name} cannot contain null bytes.`);
  const normalizedInput = value.trim().replace(/\\/g, '/');
  if (!normalizedInput || normalizedInput === '.') return '';
  if (normalizedInput.startsWith('/') || /^[a-zA-Z]:\//.test(normalizedInput)) {
    throw new Error(`${name} must be relative to the workspace root.`);
  }
  const parts: string[] = [];
  for (const part of normalizedInput.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error(`${name} cannot escape the workspace root.`);
    parts.push(part);
  }
  return parts.join('/');
};

const normalizePrefix = (value: unknown) => normalizeRelativePath(optionalString(value) ?? '', 'prefix');

const joinKey = (prefix: string, path: string) => path ? `${prefix}/${path}` : prefix;
const directoryPrefix = (prefix: string, path: string) => `${joinKey(prefix, path).replace(/\/+$/, '')}/`;
const markerKey = (prefix: string, path: string) => `${directoryPrefix(prefix, path)}${directoryMarkerName}`;
const storageBucket = (binding: ResolvedNotesVaultBinding, objects: ObjectStore) =>
  optionalString(binding.storage.bucket) ?? objects.defaultBucket;
const storagePrefix = (binding: ResolvedNotesVaultBinding) =>
  normalizePrefix(binding.storage.prefix) || `notes/${binding.projectId}/${binding.workspaceId}`;

const objectPath = (
  binding: ResolvedNotesVaultBinding,
  inputPath: unknown,
  name = 'path',
) => normalizeRelativePath(inputPath, name);

const versionForObject = (object: Pick<ObjectStoreObject, 'etag' | 'contentLength' | 'body' | 'lastModified'>) =>
  object.etag ?? `${object.lastModified?.getTime() ?? 0}:${object.contentLength ?? object.body.byteLength}`;

const hasBinaryBytes = (bytes: Uint8Array) => {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8_000));
  return sample.includes(0);
};

const decodeUtf8 = (bytes: Uint8Array) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Only UTF-8 text files can be opened in the workspace.');
  }
};

const countTextLines = (content: string) => {
  if (!content) return 0;
  return content.endsWith('\n') ? content.slice(0, -1).split('\n').length : content.split('\n').length;
};

const attachmentMediaType = (path: string): NotesVaultAttachment['mediaType'] => {
  const lowerPath = path.toLowerCase();
  if (isExcalidrawPath(lowerPath)) return 'excalidraw';
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/.test(lowerPath)) return 'image';
  if (/\.(mp3|wav|m4a|aac|ogg|flac)$/.test(lowerPath)) return 'audio';
  if (/\.(mp4|mov|webm|mkv|avi)$/.test(lowerPath)) return 'video';
  if (/\.pdf$/.test(lowerPath)) return 'pdf';
  return 'other';
};

const parseFrontmatter = (content: string) => {
  if (!content.startsWith('---\n')) return { properties: {}, body: content };
  const end = content.indexOf('\n---', 4);
  if (end === -1) return { properties: {}, body: content };

  const raw = content.slice(4, end).split(/\r?\n/);
  const properties: Record<string, string> = {};
  for (const line of raw) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) properties[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim();
  }

  return { properties, body: content.slice(end + 4).replace(/^\r?\n/, '') };
};

const parseMarkdownNote = (
  path: string,
  content: string,
  details: { size?: number; mtimeMs?: number },
): NotesVaultNote => {
  const { properties, body } = parseFrontmatter(content);
  const headings = Array.from(body.matchAll(/^#{1,6}\s+(.+)$/gm)).map((match) => match[1].trim());
  const wikiMatches = Array.from(content.matchAll(/(!?)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g));
  const markdownMatches = Array.from(content.matchAll(/(!?)\[[^\]]*]\(([^)#][^)]*)\)/g));
  const tags = Array.from(
    new Set(Array.from(content.matchAll(/(?:^|\s)#([A-Za-z0-9_/-]+)/g)).map((match) => match[1])),
  );
  const links = new Set<string>();
  const embeds = new Set<string>();

  for (const match of wikiMatches) {
    const target = match[2].trim();
    if (!target) continue;
    if (match[1] === '!') embeds.add(target);
    else links.add(target);
  }

  for (const match of markdownMatches) {
    const target = match[2].trim();
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    if (match[1] === '!') embeds.add(target);
    else links.add(target);
  }

  const title = properties.title || headings[0] || removeExtension(getBasename(path));
  const preview = body.replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim().slice(0, 240);

  return {
    path,
    documentType: 'markdown',
    title,
    headings,
    tags,
    links: [...links].sort(),
    embeds: [...embeds].sort(),
    properties,
    mtimeMs: details.mtimeMs,
    size: details.size,
    preview,
  };
};

const getBlockSuiteText = (value: unknown) => {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value) || !Array.isArray(value.delta)) return '';
  return value.delta
    .map((operation) => isRecord(operation) && typeof operation.insert === 'string' ? operation.insert : '')
    .join('')
    .trim();
};

const collectBlockSuiteSnapshotText = (block: unknown, texts: string[]) => {
  if (!isRecord(block)) return;
  const props = isRecord(block.props) ? block.props : {};
  const blockText = getBlockSuiteText(props.text);
  if (blockText) texts.push(blockText);

  const children = Array.isArray(block.children) ? block.children : [];
  for (const child of children) collectBlockSuiteSnapshotText(child, texts);
};

const getCoppermindV2Preview = (parsed: Record<string, unknown>) => {
  const blocksuite = isRecord(parsed.blocksuite) ? parsed.blocksuite : {};
  const snapshot = isRecord(blocksuite.snapshot) ? blocksuite.snapshot : {};
  const texts: string[] = [];
  collectBlockSuiteSnapshotText(snapshot.blocks, texts);
  return texts.join(' ');
};

const getCoppermindV1Preview = (parsed: Record<string, unknown>) => {
  const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
  return blocks
    .map((block) => isRecord(block) && typeof block.text === 'string' ? block.text.trim() : '')
    .filter(Boolean)
    .join(' ');
};

const parseCoppermindNote = (
  path: string,
  content: string,
  details: { size?: number; mtimeMs?: number },
): NotesVaultNote => {
  let title = removeExtension(getBasename(path));
  let preview = '';
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};
    if (typeof metadata.title === 'string' && metadata.title.trim()) title = metadata.title.trim();
    preview = (parsed.version === 2 ? getCoppermindV2Preview(parsed) : getCoppermindV1Preview(parsed))
      .replace(/\s+/g, ' ')
      .slice(0, 240);
  } catch {
    preview = 'Invalid Coppermind document';
  }

  return {
    path,
    documentType: 'coppermind',
    title,
    headings: [],
    tags: [],
    links: [],
    embeds: [],
    properties: {},
    mtimeMs: details.mtimeMs,
    size: details.size,
    preview,
  };
};

const targetCandidates = (target: string) => {
  const clean = target.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  if (!clean) return [];
  const basename = removeExtension(getBasename(clean)).toLowerCase();
  const normalized = clean.toLowerCase();
  return [
    normalized,
    normalized.endsWith('.md') ? normalized : `${normalized}.md`,
    normalized.endsWith('.cpr') ? normalized : `${normalized}.cpr`,
    basename,
    `${basename}.md`,
    `${basename}.cpr`,
  ];
};

const sortEntries = (entries: NotesVaultEntry[]) =>
  entries.sort((left, right) => {
    if (left.type !== right.type) {
      if (left.type === 'directory') return -1;
      if (right.type === 'directory') return 1;
      if (left.type === 'file') return -1;
      if (right.type === 'file') return 1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });

const contentTypeForPath = (path: string) => {
  if (isMarkdownPath(path)) return 'text/markdown; charset=utf-8';
  if (isCoppermindPath(path) || /\.json$/i.test(path)) return 'application/json; charset=utf-8';
  if (/\.ya?ml$/i.test(path)) return 'application/yaml; charset=utf-8';
  return 'text/plain; charset=utf-8';
};

export type ObjectNotesVaultBackendOptions = {
  maxReadBytes?: number;
  maxIndexBytes?: number;
};

export const createObjectNotesVaultBackend = (
  objects: ObjectStore = objectStore,
  options: ObjectNotesVaultBackendOptions = {},
): NotesVaultBackend => {
  const maxReadBytes = options.maxReadBytes ?? defaultMaxReadBytes;
  const maxIndexBytes = options.maxIndexBytes ?? defaultMaxIndexBytes;

  const location = (binding: ResolvedNotesVaultBinding) => ({
    bucket: storageBucket(binding, objects),
    prefix: storagePrefix(binding),
  });

  const getFileObject = async (binding: ResolvedNotesVaultBinding, path: string) => {
    const { bucket, prefix } = location(binding);
    return objects.getObject({ bucket, key: joinKey(prefix, path) });
  };

  const directoryExists = async (binding: ResolvedNotesVaultBinding, path: string) => {
    if (!path) return true;
    const { bucket, prefix } = location(binding);
    const listing = await objects.listObjects({ bucket, prefix: directoryPrefix(prefix, path) });
    return listing.objects.length > 0 || Boolean(await objects.getObject({ bucket, key: markerKey(prefix, path) }));
  };

  const assertDirectory = async (binding: ResolvedNotesVaultBinding, path: string) => {
    if (await directoryExists(binding, path)) return;
    throw new Error('workspace file path is not a directory.');
  };

  const listEntries = async (binding: ResolvedNotesVaultBinding, path: string) => {
    await assertDirectory(binding, path);
    const { bucket, prefix } = location(binding);
    const listing = await objects.listObjects({
      bucket,
      prefix: directoryPrefix(prefix, path),
      delimiter: '/',
    });
    const entries = new Map<string, NotesVaultEntry>();
    const base = directoryPrefix(prefix, path);

    for (const directory of listing.prefixes) {
      const relativeName = directory.slice(base.length).replace(/\/+$/, '');
      if (!relativeName || relativeName.includes('/')) continue;
      const entryPath = path ? `${path}/${relativeName}` : relativeName;
      entries.set(relativeName, {
        name: relativeName,
        path: entryPath,
        type: 'directory',
        hidden: relativeName.startsWith('.'),
      });
    }

    for (const object of listing.objects) {
      const relativeName = object.key.slice(base.length);
      if (!relativeName || relativeName === directoryMarkerName || relativeName.includes('/')) continue;
      const entryPath = path ? `${path}/${relativeName}` : relativeName;
      entries.set(relativeName, {
        name: relativeName,
        path: entryPath,
        type: 'file',
        hidden: relativeName.startsWith('.'),
        size: object.size,
        mtimeMs: object.lastModified?.getTime(),
      });
    }

    return sortEntries([...entries.values()]);
  };

  const pathExists = async (binding: ResolvedNotesVaultBinding, path: string) => {
    if (!path) return true;
    if (await getFileObject(binding, path)) return true;
    return directoryExists(binding, path);
  };

  const deletePath = async (binding: ResolvedNotesVaultBinding, path: string, recursive: boolean) => {
    const { bucket, prefix } = location(binding);
    if (!path && !recursive) throw new Error('recursive is required to delete a directory.');

    const fileKey = joinKey(prefix, path);
    const fileObject = path ? await objects.getObject({ bucket, key: fileKey }) : null;
    const directoryListing = await objects.listObjects({ bucket, prefix: directoryPrefix(prefix, path) });
    const directoryKeys = directoryListing.objects.map((object) => object.key);
    const hasDirectory = directoryKeys.length > 0;

    if (!fileObject && !hasDirectory) throw new Error('workspace file path was not found.');
    if (hasDirectory) {
      const nonMarkerKeys = directoryKeys.filter((key) => key !== markerKey(prefix, path));
      if (!recursive && nonMarkerKeys.length > 0) {
        throw new Error('recursive is required to delete a non-empty directory.');
      }
      await objects.deleteObjects({ bucket, keys: [...new Set([...directoryKeys, ...(fileObject ? [fileKey] : [])])] });
      return;
    }

    await objects.deleteObject({ bucket, key: fileKey });
  };

  return {
    kind: 'object',
    index: async (binding, input): Promise<NotesVaultIndexResult> => {
      const path = objectPath(binding, input.path);
      const entries = await listEntries(binding, path);
      const { bucket, prefix } = location(binding);
      const listing = await objects.listObjects({ bucket, prefix: directoryPrefix(prefix, path) });
      const notes: NotesVaultNote[] = [];
      const attachments: NotesVaultAttachment[] = [];
      let visited = 0;

      for (const item of listing.objects) {
        const relativePath = item.key.slice(directoryPrefix(prefix, path).length);
        if (!relativePath || relativePath.endsWith(`/${directoryMarkerName}`) || relativePath === directoryMarkerName) {
          continue;
        }
        if (visited >= maxIndexedFiles) continue;
        visited += 1;
        const absolutePath = path ? `${path}/${relativePath}` : relativePath;
        const details = { size: item.size, mtimeMs: item.lastModified?.getTime() };

        if ((isMarkdownPath(absolutePath) || isCoppermindPath(absolutePath)) && (item.size ?? 0) <= maxIndexBytes) {
          const object = await objects.getObject({ bucket, key: item.key });
          if (!object) continue;
          const content = decodeUtf8(object.body);
          notes.push(
            isCoppermindPath(absolutePath)
              ? parseCoppermindNote(absolutePath, content, details)
              : parseMarkdownNote(absolutePath, content, details),
          );
          continue;
        }

        attachments.push({
          path: absolutePath,
          name: getBasename(absolutePath),
          mediaType: attachmentMediaType(absolutePath),
          mtimeMs: details.mtimeMs,
          size: details.size,
        });
      }

      const noteLookup = new Map<string, string>();
      for (const note of notes) {
        noteLookup.set(note.path.toLowerCase(), note.path);
        noteLookup.set(removeExtension(getBasename(note.path)).toLowerCase(), note.path);
        noteLookup.set(getBasename(note.path).toLowerCase(), note.path);
      }

      const backlinks: Record<string, string[]> = {};
      for (const note of notes) {
        for (const link of note.links) {
          const resolved = targetCandidates(link).map((candidate) => noteLookup.get(candidate)).find(Boolean);
          if (!resolved) continue;
          backlinks[resolved] = backlinks[resolved] ?? [];
          backlinks[resolved].push(note.path);
        }
      }

      for (const backlinkPath of Object.keys(backlinks)) {
        backlinks[backlinkPath] = [...new Set(backlinks[backlinkPath])].sort();
      }

      return {
        path,
        entries,
        notes: notes.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' })),
        attachments: attachments.sort((left, right) =>
          left.path.localeCompare(right.path, undefined, { sensitivity: 'base' })
        ),
        backlinks,
        checkedAt: new Date().toISOString(),
      };
    },
    read: async (binding, input): Promise<NotesVaultFile> => {
      const path = objectPath(binding, input.path);
      if (!path) throw new Error('path is required.');
      const object = await getFileObject(binding, path);
      if (!object) throw new Error('workspace file path was not found.');
      const size = object.contentLength ?? object.body.byteLength;
      if (size > maxReadBytes) throw new Error('File is too large to open in the workspace.');
      if (hasBinaryBytes(object.body)) throw new Error('Binary files cannot be opened in the workspace.');
      return {
        path,
        content: decodeUtf8(object.body),
        version: versionForObject(object),
        size,
        mtimeMs: object.lastModified?.getTime(),
      };
    },
    write: async (binding, input) => {
      const path = objectPath(binding, input.path);
      if (!path) throw new Error('path is required.');
      if (typeof input.content !== 'string') throw new Error('content must be a string.');
      if (input.version !== undefined && typeof input.version !== 'string') {
        throw new Error('version must be a string.');
      }
      const { bucket, prefix } = location(binding);
      const key = joinKey(prefix, path);
      const existing = await objects.getObject({ bucket, key });
      if (input.version) {
        if (!existing || versionForObject(existing) !== input.version) {
          throw new Error('File changed on object storage. Reload before saving.');
        }
      }
      await objects.putObject({
        bucket,
        key,
        body: input.content,
        contentType: contentTypeForPath(path),
      });
      const next = await objects.getObject({ bucket, key });
      return {
        path,
        version: next ? versionForObject(next) : `${Date.now()}:${new TextEncoder().encode(input.content).byteLength}`,
        size: next?.contentLength ?? new TextEncoder().encode(input.content).byteLength,
        mtimeMs: next?.lastModified?.getTime(),
      };
    },
    mkdir: async (binding, input) => {
      const path = objectPath(binding, input.path);
      if (!path) throw new Error('path is required.');
      const { bucket, prefix } = location(binding);
      await objects.putObject({
        bucket,
        key: markerKey(prefix, path),
        body: '',
        contentType: 'application/x.weave-directory',
      });
      return { ok: true, path };
    },
    move: async (binding, input) => {
      const fromPath = objectPath(binding, input.fromPath, 'fromPath');
      const toPath = objectPath(binding, input.toPath, 'toPath');
      if (!fromPath || !toPath) throw new Error('fromPath and toPath are required.');
      if (toPath === fromPath || toPath.startsWith(`${fromPath}/`)) {
        throw new Error('Cannot move a folder into itself.');
      }
      const { bucket, prefix } = location(binding);
      if (await pathExists(binding, toPath)) {
        if (!input.overwrite) throw new Error('Destination already exists.');
        await deletePath(binding, toPath, true);
      }

      const fromKey = joinKey(prefix, fromPath);
      const sourceObject = await objects.getObject({ bucket, key: fromKey });
      if (sourceObject) {
        await objects.putObject({
          bucket,
          key: joinKey(prefix, toPath),
          body: sourceObject.body,
          contentType: sourceObject.contentType,
          metadata: sourceObject.metadata,
        });
        await objects.deleteObject({ bucket, key: fromKey });
        return { ok: true, path: toPath };
      }

      const sourcePrefix = directoryPrefix(prefix, fromPath);
      const listing = await objects.listObjects({ bucket, prefix: sourcePrefix });
      const sourceKeys = listing.objects.map((object) => object.key);
      if (sourceKeys.length === 0) throw new Error('workspace file path was not found.');
      const targetPrefix = directoryPrefix(prefix, toPath);
      for (const key of sourceKeys) {
        await objects.copyObject({
          bucket,
          key,
          toKey: `${targetPrefix}${key.slice(sourcePrefix.length)}`,
        });
      }
      await objects.deleteObjects({ bucket, keys: sourceKeys });
      return { ok: true, path: toPath };
    },
    delete: async (binding, input) => {
      const path = objectPath(binding, input.path);
      if (!path) throw new Error('path is required.');
      await deletePath(binding, path, input.recursive === true);
      return { ok: true, path };
    },
    upload: async (binding, input) => {
      const path = objectPath(binding, input.path);
      if (!path) throw new Error('path is required.');
      if (typeof input.base64Content !== 'string') throw new Error('base64Content must be a string.');
      const { bucket, prefix } = location(binding);
      await objects.putObject({
        bucket,
        key: joinKey(prefix, path),
        body: new Uint8Array(Buffer.from(input.base64Content, 'base64')),
        contentType: optionalString(input.contentType) ?? 'application/octet-stream',
      });
      return { ok: true, path };
    },
  };
};

export const objectNotesVaultBackend = createObjectNotesVaultBackend();
