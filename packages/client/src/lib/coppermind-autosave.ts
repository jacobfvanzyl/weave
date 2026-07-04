import { isCoppermindDocumentPath } from './coppermind-document';

export const coppermindAutosaveDebounceMs = 1200;

export type CoppermindAutosaveBufferLike = {
  path: string;
  content: string;
  value: string;
  version: string;
  size?: number;
  mtimeMs?: number;
  dirty: boolean;
};

export type CoppermindAutosaveSnapshot = {
  path: string;
  value: string;
  version: string;
};

export type CoppermindAutosaveWriteResult = {
  path: string;
  version: string;
  size?: number;
  mtimeMs?: number;
};

export type CoppermindAutosaveWatchEventLike = {
  paths: string[];
  affectedDirectories: string[];
  rescan?: boolean;
};

const normalizeAutosavePath = (path: string) => path.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

const getParentPath = (path: string) => normalizeAutosavePath(path).split('/').filter(Boolean).slice(0, -1).join('/');

export const createCoppermindAutosaveSnapshot = (buffer: {
  path: string;
  value: string;
  version: string;
}): CoppermindAutosaveSnapshot => ({
  path: buffer.path,
  value: buffer.value,
  version: buffer.version,
});

export const shouldAutosaveCoppermindBuffer = (
  buffer: { path: string; value: string; content: string } | undefined,
  paused = false,
) => Boolean(buffer && !paused && isCoppermindDocumentPath(buffer.path) && buffer.value !== buffer.content);

export const applyCoppermindAutosaveResult = <Buffer extends CoppermindAutosaveBufferLike>(
  buffer: Buffer,
  snapshot: CoppermindAutosaveSnapshot,
  result: CoppermindAutosaveWriteResult,
): Buffer => {
  const content = snapshot.value;
  return {
    ...buffer,
    path: result.path,
    content,
    value: buffer.value,
    version: result.version,
    size: result.size,
    mtimeMs: result.mtimeMs,
    dirty: buffer.value !== content,
  };
};

export const isCoppermindAutosaveStaleVersionError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /reload before saving|changed on disk|stale/i.test(message);
};

export const getCoppermindAutosaveWatchDirectories = (paths: string[]) => {
  const directories = new Set<string>();
  for (const path of paths) {
    if (!isCoppermindDocumentPath(path)) continue;
    directories.add(getParentPath(path));
  }
  return Array.from(directories).sort((left, right) => left.localeCompare(right));
};

export const doesCoppermindWatchEventTouchPath = (
  event: CoppermindAutosaveWatchEventLike,
  path: string,
) => {
  const normalizedPath = normalizeAutosavePath(path);
  if (!normalizedPath || !isCoppermindDocumentPath(normalizedPath)) return false;
  const parentPath = getParentPath(normalizedPath);
  if (event.paths.some(eventPath => normalizeAutosavePath(eventPath) === normalizedPath)) return true;
  if (!event.rescan) return false;
  if (event.affectedDirectories.length === 0) return true;
  return event.affectedDirectories.some(directoryPath => {
    const normalizedDirectoryPath = normalizeAutosavePath(directoryPath);
    if (normalizedDirectoryPath === parentPath) return true;
    return normalizedDirectoryPath && normalizedPath.startsWith(`${normalizedDirectoryPath}/`);
  });
};
