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

export type PortalEditorWatchInput = {
  target?: PortalEditorTarget;
  paths?: string[];
} & PortalEditorTarget;

export type PortalEditorOperationResult = {
  ok: true;
  path?: string;
};

export type PortalEditorWatchEvent = {
  kind: Deno.FsEvent['kind'] | 'any';
  paths: string[];
  affectedDirectories: string[];
  rescan?: boolean;
};

export type PortalEditorWatchReadyEvent = {
  type: 'editor.watch.ready';
  requestId?: string;
  paths: string[];
};

export type PortalEditorWatchChangeEvent = {
  type: 'editor.watch.change';
  event: PortalEditorWatchEvent;
};

export type PortalEditorWatchErrorEvent = {
  type: 'editor.watch.error';
  requestId?: string;
  error: string;
};

export type PortalEditorWatchHostEvent =
  | PortalEditorWatchReadyEvent
  | PortalEditorWatchChangeEvent
  | PortalEditorWatchErrorEvent;

export type PortalEditorWatchClientMessage =
  | { type: 'watch.start'; requestId?: string; target?: PortalEditorTarget; paths?: string[] }
  | { type: 'watch.update'; requestId?: string; paths?: string[] }
  | { type: 'watch.stop'; requestId?: string };

export type PortalEditorWatchClientEnvelope = {
  type: 'editor.watch.client';
  clientId: string;
  message: PortalEditorWatchClientMessage;
};

export type PortalEditorWatchEventHandler = (event: PortalEditorWatchEvent) => void | Promise<void>;
export type PortalEditorWatchErrorHandler = (error: Error) => void | Promise<void>;

export type PortalEditorFsWatcher = AsyncIterable<Deno.FsEvent> & {
  close: () => void;
};

export type PortalEditorWatchFactory = (
  paths: string | string[],
  options: { recursive: boolean },
) => PortalEditorFsWatcher;

export type PortalEditorHostOptions = {
  config: PortalEditorConfig;
  maxReadBytes?: number;
  watchFs?: PortalEditorWatchFactory;
  watchDebounceMs?: number;
};

const defaultMaxReadBytes = 2 * 1024 * 1024;
const defaultWatchDebounceMs = 80;

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

const toErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const requestIdValue = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const parseEditorWatchPaths = (value: unknown) => {
  const input = Array.isArray(value) ? value : [''];
  const paths = input.map((item) => parseEditorPath(item)).filter((item, index, all) => all.indexOf(item) === index);
  return paths.length ? paths : [''];
};

const relativePathFromAbsolute = (root: string, path: string) => {
  const normalizedRoot = trimTrailingSlash(normalizePath(root.replace(/\\/g, '/')));
  const normalizedPath = trimTrailingSlash(normalizePath(path.replace(/\\/g, '/')));
  if (normalizedPath === normalizedRoot) return '';
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return undefined;
  return normalizedPath.slice(normalizedRoot.length + 1);
};

export const joinPortalEditorPath = joinPath;

export const assertPortalPathWithinRoot = (
  root: string,
  candidate: string,
  message = 'Editor path cannot escape the Workspace workspace.',
) => {
  const normalizedRoot = trimTrailingSlash(normalizePath(root));
  const normalizedCandidate = trimTrailingSlash(normalizePath(candidate));
  if (normalizedCandidate === normalizedRoot) return;
  if (!normalizedCandidate.startsWith(`${normalizedRoot}/`)) throw new Error(message);
};

export const resolvePortalEditorWorkspaceRoot = async (
  config: PortalEditorConfig,
  input: Record<string, unknown>,
) => {
  const workspacePath = optionalString(input.workspacePath);
  if (workspacePath) return await Deno.realPath(workspacePath);

  const projectId = optionalString(input.projectId);
  const mount = projectId ? (config.mounts ?? []).find((item) => item.projectId === projectId) : undefined;
  if (mount) return await Deno.realPath(mount.localPath);

  const rootId = optionalString(input.rootId);
  const repoPath = optionalString(input.repoPath);
  if (rootId && repoPath) {
    const root = getRoots(config).find((item) => item.id === rootId);
    if (!root) throw new Error(`Unknown root: ${rootId}`);
    const rootPath = await Deno.realPath(root.path);
    const target = await Deno.realPath(joinPath(rootPath, parseEditorPath(repoPath, 'repoPath')));
    assertPortalPathWithinRoot(rootPath, target, 'Path escapes Portal root');
    return target;
  }

  throw new Error(`Project is not mounted: ${String(input.projectId)}`);
};

type PortalEditorWatchOptions = {
  root: string;
  paths: string[];
  watchFs: PortalEditorWatchFactory;
  debounceMs: number;
  onEvent: PortalEditorWatchEventHandler;
  onError?: PortalEditorWatchErrorHandler;
};

type PendingWatchEvent = {
  kind?: PortalEditorWatchEvent['kind'];
  paths: Set<string>;
  affectedDirectories: Set<string>;
  rescan: boolean;
};

export class PortalEditorWatchSubscription {
  private readonly root: string;
  private readonly watchFs: PortalEditorWatchFactory;
  private readonly debounceMs: number;
  private readonly onEvent: PortalEditorWatchEventHandler;
  private readonly onError?: PortalEditorWatchErrorHandler;
  private watcher?: PortalEditorFsWatcher;
  private closed = false;
  private generation = 0;
  private paths: string[] = [];
  private pending?: PendingWatchEvent;
  private debounceTimer?: ReturnType<typeof setTimeout>;

  constructor(options: PortalEditorWatchOptions) {
    this.root = options.root;
    this.watchFs = options.watchFs;
    this.debounceMs = options.debounceMs;
    this.onEvent = options.onEvent;
    this.onError = options.onError;
    this.paths = options.paths;
  }

  getPaths() {
    return [...this.paths];
  }

  async start() {
    await this.update(this.paths);
    return this.getPaths();
  }

  async update(paths: string[]) {
    if (this.closed) throw new Error('Editor watch subscription is closed.');
    const next = await this.resolveWatchPaths(paths);
    this.generation += 1;
    const generation = this.generation;
    this.closeWatcher();
    this.paths = next.map(path => path.relativePath);
    if (next.length === 0) return this.getPaths();

    const watcher = this.watchFs(next.map(path => path.absolutePath), { recursive: false });
    this.watcher = watcher;
    void this.runWatcher(watcher, generation);
    return this.getPaths();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.closeWatcher();
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this.pending = undefined;
  }

  private async resolveWatchPaths(paths: string[]) {
    const resolved = [];
    for (const relativePath of paths) {
      const candidate = joinPath(this.root, parseEditorPath(relativePath));
      assertPortalPathWithinRoot(this.root, candidate);
      const details = await Deno.stat(candidate).catch((error) => {
        if (error instanceof Deno.errors.NotFound) return undefined;
        throw error;
      });
      if (!details) {
        if (!relativePath) throw new Error('Editor workspace root was not found.');
        continue;
      }
      if (!details.isDirectory) {
        if (!relativePath) throw new Error('Editor workspace root is not a directory.');
        continue;
      }
      const realPath = await Deno.realPath(candidate);
      assertPortalPathWithinRoot(this.root, realPath);
      resolved.push({ relativePath, absolutePath: realPath });
    }
    return resolved;
  }

  private async runWatcher(watcher: PortalEditorFsWatcher, generation: number) {
    try {
      for await (const event of watcher) {
        if (this.closed || generation !== this.generation) break;
        this.queueEvent(event);
      }
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      await this.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private queueEvent(event: Deno.FsEvent) {
    const normalizedPaths = event.paths
      .map(path => relativePathFromAbsolute(this.root, path))
      .filter((path): path is string => path !== undefined);
    const rescan = event.flag === 'rescan';
    const affectedDirectories = rescan
      ? this.paths
      : normalizedPaths.map(path => getParentPath(path));

    if (!this.pending) {
      this.pending = { paths: new Set(), affectedDirectories: new Set(), rescan: false };
    }

    this.pending.kind = this.pending.kind && this.pending.kind !== event.kind ? 'any' : event.kind;
    normalizedPaths.forEach(path => this.pending?.paths.add(path));
    affectedDirectories.forEach(path => this.pending?.affectedDirectories.add(path));
    this.pending.rescan = this.pending.rescan || rescan;

    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushPending(), this.debounceMs);
  }

  private flushPending() {
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    const event: PortalEditorWatchEvent = {
      kind: pending.kind ?? 'any',
      paths: [...pending.paths].sort(),
      affectedDirectories: [...pending.affectedDirectories].sort(),
      ...(pending.rescan ? { rescan: true } : {}),
    };
    void Promise.resolve(this.onEvent(event)).catch(error => void this.onError?.(
      error instanceof Error ? error : new Error(String(error)),
    ));
  }

  private closeWatcher() {
    const watcher = this.watcher;
    this.watcher = undefined;
    watcher?.close();
  }
}

export const isEditorWatchClientEnvelope = (message: Record<string, unknown>): message is PortalEditorWatchClientEnvelope =>
  message.type === 'editor.watch.client' &&
  typeof message.clientId === 'string' &&
  Boolean(message.message && typeof message.message === 'object');

export class PortalEditorHost {
  private readonly config: PortalEditorConfig;
  private readonly maxReadBytes: number;
  private readonly watchFs: PortalEditorWatchFactory;
  private readonly watchDebounceMs: number;
  private readonly watchClients = new Map<string, PortalEditorWatchSubscription>();

  constructor(options: PortalEditorHostOptions) {
    this.config = options.config;
    this.maxReadBytes = options.maxReadBytes ?? defaultMaxReadBytes;
    this.watchFs = options.watchFs ?? Deno.watchFs;
    this.watchDebounceMs = options.watchDebounceMs ?? defaultWatchDebounceMs;
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

  async watch(
    input: PortalEditorWatchInput,
    handlers: { onEvent: PortalEditorWatchEventHandler; onError?: PortalEditorWatchErrorHandler },
  ) {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const paths = parseEditorWatchPaths(record.paths);
    const subscription = new PortalEditorWatchSubscription({
      root,
      paths,
      watchFs: this.watchFs,
      debounceMs: this.watchDebounceMs,
      onEvent: handlers.onEvent,
      onError: handlers.onError,
    });
    await subscription.start();
    return subscription;
  }

  async handleClientMessage(
    clientId: string,
    message: PortalEditorWatchClientMessage,
    send: (event: PortalEditorWatchHostEvent) => void,
  ) {
    const requestId = requestIdValue(message.requestId);
    try {
      if (message.type === 'watch.start') {
        this.detachClient(clientId);
        const subscription = await this.watch({ target: message.target, paths: message.paths }, {
          onEvent: event => send({ type: 'editor.watch.change', event }),
          onError: error => send({ type: 'editor.watch.error', error: error.message }),
        });
        this.watchClients.set(clientId, subscription);
        send({ type: 'editor.watch.ready', requestId, paths: subscription.getPaths() });
        return;
      }

      if (message.type === 'watch.update') {
        const subscription = this.watchClients.get(clientId);
        if (!subscription) throw new Error('Editor watch subscription was not started.');
        const paths = await subscription.update(parseEditorWatchPaths(message.paths));
        send({ type: 'editor.watch.ready', requestId, paths });
        return;
      }

      if (message.type === 'watch.stop') {
        this.detachClient(clientId);
        send({ type: 'editor.watch.ready', requestId, paths: [] });
        return;
      }

      throw new Error('Unsupported editor watch message.');
    } catch (error) {
      send({ type: 'editor.watch.error', requestId, error: toErrorMessage(error) });
    }
  }

  detachClient(clientId: string) {
    const subscription = this.watchClients.get(clientId);
    subscription?.close();
    this.watchClients.delete(clientId);
  }

  detachClientsByPrefix(prefix: string) {
    for (const clientId of this.watchClients.keys()) {
      if (clientId.startsWith(prefix)) this.detachClient(clientId);
    }
  }

  dispose() {
    for (const clientId of [...this.watchClients.keys()]) this.detachClient(clientId);
  }

  private async resolveWorkspaceRoot(input: Record<string, unknown>) {
    return await resolvePortalEditorWorkspaceRoot(this.config, input);
  }

  private async resolveExistingPath(root: string, relativePath: string) {
    const normalizedPath = parseEditorPath(relativePath);
    const candidate = joinPath(root, normalizedPath);
    const resolved = await Deno.realPath(candidate);
    this.assertWithinRoot(root, resolved);
    return resolved;
  }

  private assertWithinRoot(root: string, candidate: string, message = 'Editor path cannot escape the Workspace workspace.') {
    assertPortalPathWithinRoot(root, candidate, message);
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
