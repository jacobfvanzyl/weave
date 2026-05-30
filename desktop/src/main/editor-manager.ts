import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type {
  EditorFile,
  EditorListInput,
  EditorListResult,
  EditorReadInput,
  EditorTarget,
  EditorWriteInput,
  EditorWriteResult,
} from '../shared/editor';

type EditorResolvedTarget = {
  cwd: string;
};

type EditorManagerOptions = {
  resolveDemiplane: (target: EditorTarget) => Promise<EditorResolvedTarget>;
  maxReadBytes?: number;
};

const defaultMaxReadBytes = 2 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

const parseIdentifier = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
};

const parseEditorPath = (value: unknown, name = 'path') => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  if (value.includes('\0')) throw new Error(`${name} cannot contain null bytes.`);

  const normalizedInput = value.trim().replace(/\\/g, '/');
  if (!normalizedInput || normalizedInput === '.') return '';
  if (path.posix.isAbsolute(normalizedInput) || /^[a-zA-Z]:\//.test(normalizedInput)) {
    throw new Error(`${name} must be relative to the Demiplane workspace.`);
  }

  const normalized = path.posix.normalize(normalizedInput);
  if (normalized === '.' || normalized === '') return '';
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${name} cannot escape the Demiplane workspace.`);
  }

  return normalized.replace(/^\.\//, '');
};

const parseEditorTarget = (value: unknown): EditorTarget => {
  if (!isRecord(value)) throw new Error('target is required.');
  return {
    planeId: parseIdentifier(value.planeId, 'planeId'),
    demiplaneId: parseIdentifier(value.demiplaneId, 'demiplaneId'),
  };
};

export const parseEditorListInput = (input: unknown): EditorListInput => {
  if (!isRecord(input)) throw new Error('editor list input is required.');
  return {
    target: parseEditorTarget(input.target),
    path: parseEditorPath(input.path),
  };
};

export const parseEditorReadInput = (input: unknown): EditorReadInput => {
  if (!isRecord(input)) throw new Error('editor read input is required.');
  return {
    target: parseEditorTarget(input.target),
    path: parseEditorPath(input.path),
  };
};

export const parseEditorWriteInput = (input: unknown): EditorWriteInput => {
  if (!isRecord(input)) throw new Error('editor write input is required.');
  if (typeof input.content !== 'string') throw new Error('content must be a string.');
  if (input.version !== undefined && typeof input.version !== 'string') throw new Error('version must be a string.');

  return {
    target: parseEditorTarget(input.target),
    path: parseEditorPath(input.path),
    content: input.content,
    version: input.version,
  };
};

const getFileVersion = (details: { mtimeMs: number; size: number }) => `${details.mtimeMs}:${details.size}`;

const hasBinaryBytes = (buffer: Buffer) => {
  const sample = buffer.subarray(0, Math.min(buffer.byteLength, 8_000));
  return sample.includes(0);
};

const decodeUtf8 = (buffer: Buffer) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('Only UTF-8 text files can be opened in the editor.');
  }
};

export class EditorManager {
  private readonly resolveDemiplane: (target: EditorTarget) => Promise<EditorResolvedTarget>;
  private readonly maxReadBytes: number;

  constructor(options: EditorManagerOptions) {
    this.resolveDemiplane = options.resolveDemiplane;
    this.maxReadBytes = options.maxReadBytes ?? defaultMaxReadBytes;
  }

  async list(input: EditorListInput): Promise<EditorListResult> {
    const target = await this.resolveTarget(input.target);
    const relativePath = parseEditorPath(input.path);
    const directoryPath = await this.resolveExistingPath(target.cwd, relativePath);
    const details = await stat(directoryPath);
    if (!details.isDirectory()) throw new Error('Editor path is not a directory.');

    const entries = await readdir(directoryPath, { withFileTypes: true });
    return {
      path: relativePath,
      entries: entries
        .map(entry => {
          const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
          return {
            name: entry.name,
            path: entryPath,
            type: entry.isDirectory() ? 'directory' as const : entry.isFile() ? 'file' as const : 'other' as const,
            hidden: entry.name.startsWith('.'),
          };
        })
        .sort((left, right) => {
          if (left.type !== right.type) {
            if (left.type === 'directory') return -1;
            if (right.type === 'directory') return 1;
            if (left.type === 'file') return -1;
            if (right.type === 'file') return 1;
          }

          return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
        }),
    };
  }

  async read(input: EditorReadInput): Promise<EditorFile> {
    const target = await this.resolveTarget(input.target);
    const relativePath = parseEditorPath(input.path);
    if (!relativePath) throw new Error('path is required.');

    const filePath = await this.resolveExistingPath(target.cwd, relativePath);
    const details = await stat(filePath);
    if (!details.isFile()) throw new Error('Editor path is not a file.');
    if (details.size > this.maxReadBytes) throw new Error('File is too large to open in the editor.');

    const buffer = await readFile(filePath);
    if (hasBinaryBytes(buffer)) throw new Error('Binary files cannot be opened in the editor.');

    return {
      path: relativePath,
      content: decodeUtf8(buffer),
      version: getFileVersion(details),
    };
  }

  async write(input: EditorWriteInput): Promise<EditorWriteResult> {
    const target = await this.resolveTarget(input.target);
    const relativePath = parseEditorPath(input.path);
    if (!relativePath) throw new Error('path is required.');

    const parentPath = await this.resolveExistingPath(target.cwd, path.posix.dirname(relativePath));
    const parentDetails = await stat(parentPath);
    if (!parentDetails.isDirectory()) throw new Error('Editor parent path is not a directory.');

    const filePath = path.resolve(parentPath, path.posix.basename(relativePath));
    await this.assertWithinRoot(target.cwd, filePath);

    const currentDetails = await this.statMaybe(filePath);
    if (currentDetails) {
      if (!currentDetails.isFile()) throw new Error('Editor path is not a file.');
      const realFilePath = await realpath(filePath);
      await this.assertWithinRoot(target.cwd, realFilePath);

      if (input.version && input.version !== getFileVersion(currentDetails)) {
        throw new Error('File changed on disk. Reload before saving.');
      }
    } else if (input.version) {
      throw new Error('File changed on disk. Reload before saving.');
    }

    await mkdir(parentPath, { recursive: true });
    await writeFile(filePath, input.content, 'utf8');
    const nextDetails = await stat(filePath);
    return { path: relativePath, version: getFileVersion(nextDetails) };
  }

  private async resolveTarget(target: EditorTarget) {
    const resolved = await this.resolveDemiplane({
      planeId: parseIdentifier(target.planeId, 'planeId'),
      demiplaneId: parseIdentifier(target.demiplaneId, 'demiplaneId'),
    });
    const cwd = await realpath(resolved.cwd);
    const details = await stat(cwd);
    if (!details.isDirectory()) throw new Error('Demiplane path is not a directory.');
    return { cwd };
  }

  private async resolveExistingPath(root: string, relativePath: string) {
    const normalizedPath = parseEditorPath(relativePath);
    const candidate = normalizedPath ? path.resolve(root, normalizedPath) : root;
    const resolved = await realpath(candidate);
    await this.assertWithinRoot(root, resolved);
    return resolved;
  }

  private async assertWithinRoot(root: string, candidate: string) {
    const relative = path.relative(root, candidate);
    if (relative === '') return;
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Editor path cannot escape the Demiplane workspace.');
    }
  }

  private async statMaybe(filePath: string) {
    try {
      return await stat(filePath);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
}
