export type PortalEditorRoot = {
  id: string;
  name?: string;
  path: string;
};

export type PortalEditorMount = {
  projectId: string;
  localPath: string;
};

export type PortalEditorConfig = {
  mounts?: PortalEditorMount[];
  roots?: PortalEditorRoot[];
};

export type PortalEditorTarget = {
  projectId?: string;
  workspaceId?: string;
  portalId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
};

export type PortalEditorEntry = {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'other';
  hidden?: boolean;
  size?: number;
  mtimeMs?: number;
};

export type PortalEditorListInput = {
  target?: PortalEditorTarget;
  path?: string;
} & PortalEditorTarget;

export type PortalEditorListResult = {
  path: string;
  entries: PortalEditorEntry[];
};

export type PortalEditorReadInput = {
  target?: PortalEditorTarget;
  path: string;
} & PortalEditorTarget;

export type PortalEditorFile = {
  path: string;
  content: string;
  version: string;
  size?: number;
  mtimeMs?: number;
};

export type PortalEditorWriteInput = {
  target?: PortalEditorTarget;
  path: string;
  content: string;
  version?: string;
} & PortalEditorTarget;

export type PortalEditorWriteResult = {
  path: string;
  version: string;
  size?: number;
  mtimeMs?: number;
};

export type PortalEditorMkdirInput = {
  target?: PortalEditorTarget;
  path: string;
} & PortalEditorTarget;

export type PortalEditorMoveInput = {
  target?: PortalEditorTarget;
  fromPath: string;
  toPath: string;
  overwrite?: boolean;
} & PortalEditorTarget;

export type PortalEditorDeleteInput = {
  target?: PortalEditorTarget;
  path: string;
  recursive?: boolean;
} & PortalEditorTarget;

export type PortalEditorOperationResult = {
  ok: true;
  path?: string;
};

export type PortalEditorHostOptions = {
  config: PortalEditorConfig;
  maxReadBytes?: number;
};

const defaultMaxReadBytes = 2 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const normalizePath = (value: string) => {
  const absolute = value.startsWith('/');
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!absolute) parts.push(part);
    } else {
      parts.push(part);
    }
  }
  return `${absolute ? '/' : ''}${parts.join('/')}` || (absolute ? '/' : '.');
};

const trimTrailingSlash = (value: string) => value === '/' ? value : value.replace(/\/+$/, '');

const joinPath = (base: string, path: string) => path ? normalizePath(`${trimTrailingSlash(base)}/${path}`) : base;

const getParentPath = (path: string) => {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex <= 0 ? '' : path.slice(0, slashIndex);
};

const getBasename = (path: string) => {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex === -1 ? path : path.slice(slashIndex + 1);
};

export const parseEditorPath = (value: unknown, name = 'path') => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  if (value.includes('\0')) throw new Error(`${name} cannot contain null bytes.`);

  const normalizedInput = value.trim().replace(/\\/g, '/');
  if (!normalizedInput || normalizedInput === '.') return '';
  if (normalizedInput.startsWith('/') || /^[a-zA-Z]:\//.test(normalizedInput)) {
    throw new Error(`${name} must be relative to the Workspace workspace.`);
  }

  const normalized = normalizePath(normalizedInput);
  if (normalized === '.' || normalized === '') return '';
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${name} cannot escape the Workspace workspace.`);
  }

  return normalized.replace(/^\.\//, '');
};

const getFileVersion = (details: Deno.FileInfo) => `${details.mtime?.getTime() ?? 0}:${details.size}`;

const hasBinaryBytes = (bytes: Uint8Array) => {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8_000));
  return sample.includes(0);
};

const decodeUtf8 = (bytes: Uint8Array) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Only UTF-8 text files can be opened in the editor.');
  }
};

const getRoots = (config: PortalEditorConfig) =>
  config.roots?.length ? config.roots : [{ id: 'default', name: 'Default', path: Deno.env.get('HOME') ?? '.' }];

const flattenInput = <T extends Record<string, unknown>>(input: T) => {
  const target = isRecord(input.target) ? input.target : {};
  const { target: _target, ...rest } = input;
  return { ...rest, ...target };
};

export class PortalEditorHost {
  private readonly config: PortalEditorConfig;
  private readonly maxReadBytes: number;

  constructor(options: PortalEditorHostOptions) {
    this.config = options.config;
    this.maxReadBytes = options.maxReadBytes ?? defaultMaxReadBytes;
  }

  async list(input: PortalEditorListInput): Promise<PortalEditorListResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseEditorPath(record.path);
    const directoryPath = await this.resolveExistingPath(root, relativePath);
    const details = await Deno.stat(directoryPath);
    if (!details.isDirectory) throw new Error('Editor path is not a directory.');

    const entries: PortalEditorEntry[] = [];
    for await (const entry of Deno.readDir(directoryPath)) {
      const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const type = entry.isDirectory ? 'directory' : entry.isFile ? 'file' : 'other';
      const statPath = joinPath(directoryPath, entry.name);
      const stat = await Deno.stat(statPath).catch(() => undefined);
      entries.push({
        name: entry.name,
        path: entryPath,
        type,
        hidden: entry.name.startsWith('.'),
        size: stat?.size,
        mtimeMs: stat?.mtime?.getTime(),
      });
    }

    return {
      path: relativePath,
      entries: entries.sort((left, right) => {
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

  async read(input: PortalEditorReadInput): Promise<PortalEditorFile> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseEditorPath(record.path);
    if (!relativePath) throw new Error('path is required.');

    const filePath = await this.resolveExistingPath(root, relativePath);
    const details = await Deno.stat(filePath);
    if (!details.isFile) throw new Error('Editor path is not a file.');
    if (details.size > this.maxReadBytes) throw new Error('File is too large to open in the editor.');

    const bytes = await Deno.readFile(filePath);
    if (hasBinaryBytes(bytes)) throw new Error('Binary files cannot be opened in the editor.');

    return {
      path: relativePath,
      content: decodeUtf8(bytes),
      version: getFileVersion(details),
      size: details.size,
      mtimeMs: details.mtime?.getTime(),
    };
  }

  async write(input: PortalEditorWriteInput): Promise<PortalEditorWriteResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseEditorPath(record.path);
    if (!relativePath) throw new Error('path is required.');
    if (typeof record.content !== 'string') throw new Error('content must be a string.');
    if (record.version !== undefined && typeof record.version !== 'string') throw new Error('version must be a string.');

    const parentPath = await this.resolveExistingPath(root, getParentPath(relativePath));
    const parentDetails = await Deno.stat(parentPath);
    if (!parentDetails.isDirectory) throw new Error('Editor parent path is not a directory.');

    const filePath = joinPath(parentPath, getBasename(relativePath));
    this.assertWithinRoot(root, filePath);

    const currentDetails = await this.statMaybe(filePath);
    if (currentDetails) {
      if (!currentDetails.isFile) throw new Error('Editor path is not a file.');
      const realFilePath = await Deno.realPath(filePath);
      this.assertWithinRoot(root, realFilePath);

      if (record.version && record.version !== getFileVersion(currentDetails)) {
        throw new Error('File changed on disk. Reload before saving.');
      }
    } else if (record.version) {
      throw new Error('File changed on disk. Reload before saving.');
    }

    await Deno.writeTextFile(filePath, record.content);
    const nextDetails = await Deno.stat(filePath);
    return { path: relativePath, version: getFileVersion(nextDetails), size: nextDetails.size, mtimeMs: nextDetails.mtime?.getTime() };
  }

  async mkdir(input: PortalEditorMkdirInput): Promise<PortalEditorOperationResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseEditorPath(record.path);
    if (!relativePath) throw new Error('path is required.');

    let currentPath = root;
    for (const segment of relativePath.split('/').filter(Boolean)) {
      const nextPath = joinPath(currentPath, segment);
      this.assertWithinRoot(root, nextPath);

      const details = await this.statMaybe(nextPath);
      if (details) {
        const realPath = await Deno.realPath(nextPath);
        this.assertWithinRoot(root, realPath);
        if (!details.isDirectory) throw new Error('Editor path is not a directory.');
        currentPath = realPath;
        continue;
      }

      await Deno.mkdir(nextPath);
      currentPath = nextPath;
    }
    return { ok: true, path: relativePath };
  }

  async move(input: PortalEditorMoveInput): Promise<PortalEditorOperationResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const fromPath = parseEditorPath(record.fromPath, 'fromPath');
    const toPath = parseEditorPath(record.toPath, 'toPath');
    if (!fromPath || !toPath) throw new Error('fromPath and toPath are required.');
    if (record.overwrite !== undefined && typeof record.overwrite !== 'boolean') throw new Error('overwrite must be a boolean.');
    if (fromPath === toPath) return { ok: true, path: toPath };

    const sourcePath = await this.resolveExistingPath(root, fromPath);
    const targetParentPath = await this.resolveExistingPath(root, getParentPath(toPath));
    const targetPath = joinPath(targetParentPath, getBasename(toPath));
    this.assertWithinRoot(root, targetPath);
    await Deno.rename(sourcePath, targetPath).catch(async (error) => {
      if (!record.overwrite) throw error;
      await Deno.remove(targetPath, { recursive: true }).catch((removeError) => {
        if (removeError instanceof Deno.errors.NotFound) return;
        throw removeError;
      });
      await Deno.rename(sourcePath, targetPath);
    });
    return { ok: true, path: toPath };
  }

  async delete(input: PortalEditorDeleteInput): Promise<PortalEditorOperationResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseEditorPath(record.path);
    if (!relativePath) throw new Error('path is required.');
    if (record.recursive !== undefined && typeof record.recursive !== 'boolean') throw new Error('recursive must be a boolean.');

    const targetPath = await this.resolveExistingPath(root, relativePath);
    await Deno.remove(targetPath, { recursive: record.recursive === true });
    return { ok: true, path: relativePath };
  }

  private async resolveWorkspaceRoot(input: Record<string, unknown>) {
    const workspacePath = optionalString(input.workspacePath);
    if (workspacePath) return await Deno.realPath(workspacePath);

    const projectId = optionalString(input.projectId);
    const mount = projectId ? (this.config.mounts ?? []).find((item) => item.projectId === projectId) : undefined;
    if (mount) return await Deno.realPath(mount.localPath);

    const rootId = optionalString(input.rootId);
    const repoPath = optionalString(input.repoPath);
    if (rootId && repoPath) {
      const root = getRoots(this.config).find((item) => item.id === rootId);
      if (!root) throw new Error(`Unknown root: ${rootId}`);
      const rootPath = await Deno.realPath(root.path);
      const target = await Deno.realPath(joinPath(rootPath, parseEditorPath(repoPath, 'repoPath')));
      this.assertWithinRoot(rootPath, target, 'Path escapes Portal root');
      return target;
    }

    throw new Error(`Project is not mounted: ${String(input.projectId)}`);
  }

  private async resolveExistingPath(root: string, relativePath: string) {
    const normalizedPath = parseEditorPath(relativePath);
    const candidate = joinPath(root, normalizedPath);
    const resolved = await Deno.realPath(candidate);
    this.assertWithinRoot(root, resolved);
    return resolved;
  }

  private assertWithinRoot(root: string, candidate: string, message = 'Editor path cannot escape the Workspace workspace.') {
    const normalizedRoot = trimTrailingSlash(normalizePath(root));
    const normalizedCandidate = trimTrailingSlash(normalizePath(candidate));
    if (normalizedCandidate === normalizedRoot) return;
    if (!normalizedCandidate.startsWith(`${normalizedRoot}/`)) throw new Error(message);
  }

  private async statMaybe(path: string) {
    try {
      return await Deno.stat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
  }
}
