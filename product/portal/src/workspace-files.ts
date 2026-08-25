import type {
  PortalRpcParams,
  PortalRpcResult,
  WorkspaceFileEntry,
  WorkspaceFileErrorCode,
  WorkspaceFileErrorData,
  WorkspaceFileMetadata,
  WorkspaceFileWatchEvent,
  WorkspaceFileWatchNotification,
} from '@weave/product-protocol';

type WorkspaceRoot = { workspaceId: string; path: string };

export type WorkspaceFileLimits = {
  maxReadBytes: number;
  maxWriteBytes: number;
  maxDirectoryEntries: number;
  maxSearchFiles: number;
  maxSearchBytesPerFile: number;
  maxSearchResults: number;
  maxWatchPaths: number;
  watchDebounceMs: number;
};

export type WorkspaceFileSystemWatcher = AsyncIterable<Deno.FsEvent> & { close(): void };
export type WorkspaceFileDependencies = {
  watchFs(paths: string | string[], options: { recursive: boolean }): WorkspaceFileSystemWatcher;
  createId(): string;
};

export const DEFAULT_WORKSPACE_FILE_LIMITS: WorkspaceFileLimits = {
  maxReadBytes: 2 * 1_024 * 1_024,
  maxWriteBytes: 2 * 1_024 * 1_024,
  maxDirectoryEntries: 5_000,
  maxSearchFiles: 5_000,
  maxSearchBytesPerFile: 256 * 1_024,
  maxSearchResults: 200,
  maxWatchPaths: 64,
  watchDebounceMs: 80,
};

const errorMessages: Record<WorkspaceFileErrorCode, string> = {
  INVALID_PATH: 'Workspace file path is invalid.',
  WORKSPACE_UNAVAILABLE: 'Workspace is unavailable.',
  NOT_FOUND: 'Workspace file was not found.',
  NOT_FILE: 'Workspace file path is not a file.',
  NOT_DIRECTORY: 'Workspace file path is not a directory.',
  DIRECTORY_NOT_EMPTY: 'Workspace directory is not empty.',
  ALREADY_EXISTS: 'Workspace file already exists.',
  PAYLOAD_TOO_LARGE: 'Workspace file payload is too large.',
  UNSUPPORTED_CONTENT: 'Only UTF-8 text files are supported.',
  STALE_CONTENT: 'File changed on disk. Reload before saving.',
  SYMLINK_NOT_ALLOWED: 'Symbolic links are not allowed in Workspace file paths.',
  WATCH_NOT_FOUND: 'Workspace file watch subscription was not found.',
};

export class WorkspaceFileError extends Error {
  readonly data: WorkspaceFileErrorData;

  constructor(code: WorkspaceFileErrorCode, details: Omit<WorkspaceFileErrorData, 'domain' | 'code'> = {}) {
    super(errorMessages[code]);
    this.name = 'WorkspaceFileError';
    this.data = { domain: 'workspace-filesystem', code, ...details };
  }
}

const fail = (code: WorkspaceFileErrorCode, details?: Omit<WorkspaceFileErrorData, 'domain' | 'code'>): never => {
  throw new WorkspaceFileError(code, details);
};

const sha256 = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const lineCount = (content: string) => {
  if (!content) return 0;
  return content.endsWith('\n') ? content.slice(0, -1).split('\n').length : content.split('\n').length;
};

const parentPath = (path: string) => {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
};

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const relativeToRoot = (root: string, path: string) => {
  if (path === root) return '';
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
};

const isWithinRoot = (root: string, path: string) => path === root || path.startsWith(`${root}/`);

const compareEntries = (left: WorkspaceFileEntry, right: WorkspaceFileEntry) => {
  const order = { directory: 0, file: 1, other: 2 } as const;
  return order[left.type] - order[right.type] ||
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) || left.name.localeCompare(right.name);
};

const compareDirectoryEntries = (left: Deno.DirEntry, right: Deno.DirEntry) =>
  left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) || left.name.localeCompare(right.name);

const canonicalPath = (value: string, allowRoot = false) => {
  if (allowRoot && value === '') return '';
  if (
    !value || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value) ||
    value.endsWith('/') || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return fail('INVALID_PATH', { path: value });
  }
  return value;
};

const metadata = async (path: string, absolutePath: string, bytes: Uint8Array): Promise<WorkspaceFileMetadata> => {
  const details = await Deno.stat(absolutePath);
  return {
    path,
    contentHash: await sha256(bytes),
    size: bytes.byteLength,
    ...(details.mtime ? { mtimeMs: details.mtime.getTime() } : {}),
  };
};

const decodeText = (bytes: Uint8Array, path: string) => {
  if (bytes.includes(0)) return fail('UNSUPPORTED_CONTENT', { path });
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('UNSUPPORTED_CONTENT', { path });
  }
};

export class WorkspaceFileService {
  readonly #roots: Map<string, string>;
  readonly #limits: WorkspaceFileLimits;
  readonly #dependencies: WorkspaceFileDependencies;
  readonly #watchSessions = new Set<WorkspaceFileWatchSession>();
  readonly #mutationLocks = new Map<string, Promise<void>>();

  private constructor(
    roots: Map<string, string>,
    limits: WorkspaceFileLimits,
    dependencies: WorkspaceFileDependencies,
  ) {
    this.#roots = roots;
    this.#limits = limits;
    this.#dependencies = dependencies;
  }

  static async open(
    roots: WorkspaceRoot[],
    limits: Partial<WorkspaceFileLimits> = {},
    dependencies: Partial<WorkspaceFileDependencies> = {},
  ) {
    const resolved = new Map<string, string>();
    for (const root of roots) {
      try {
        const path = await Deno.realPath(root.path);
        if (!(await Deno.stat(path)).isDirectory) return fail('WORKSPACE_UNAVAILABLE');
        resolved.set(root.workspaceId, path.replace(/\/$/, ''));
      } catch (cause) {
        if (cause instanceof WorkspaceFileError) throw cause;
        return fail('WORKSPACE_UNAVAILABLE');
      }
    }
    return new WorkspaceFileService(
      resolved,
      { ...DEFAULT_WORKSPACE_FILE_LIMITS, ...limits },
      {
        watchFs: dependencies.watchFs ?? ((paths, options) => Deno.watchFs(paths, options)),
        createId: dependencies.createId ?? (() => crypto.randomUUID()),
      },
    );
  }

  async list(params: PortalRpcParams<'workspace.file.list'>): Promise<PortalRpcResult<'workspace.file.list'>> {
    const path = canonicalPath(params.path, true);
    const absolutePath = await this.#existingPath(params.workspaceId, path);
    if (!(await Deno.stat(absolutePath)).isDirectory) return fail('NOT_DIRECTORY', { path });

    const entries: WorkspaceFileEntry[] = [];
    let truncated = false;
    for await (const entry of Deno.readDir(absolutePath)) {
      const entryPath = path ? `${path}/${entry.name}` : entry.name;
      const details = await Deno.lstat(`${absolutePath}/${entry.name}`).catch(() => undefined);
      entries.push({
        name: entry.name,
        path: entryPath,
        type: entry.isDirectory ? 'directory' : entry.isFile ? 'file' : 'other',
        hidden: entry.name.startsWith('.'),
        ...(details ? { size: details.size } : {}),
        ...(details?.mtime ? { mtimeMs: details.mtime.getTime() } : {}),
      });
      entries.sort(compareEntries);
      if (entries.length > this.#limits.maxDirectoryEntries) {
        entries.pop();
        truncated = true;
      }
    }
    return { path, entries, truncated };
  }

  async read(params: PortalRpcParams<'workspace.file.read'>): Promise<PortalRpcResult<'workspace.file.read'>> {
    const path = canonicalPath(params.path);
    const absolutePath = await this.#regularFile(params.workspaceId, path);
    const bytes = await this.#readBounded(absolutePath, path, this.#limits.maxReadBytes);
    return { ...await metadata(path, absolutePath, bytes), content: decodeText(bytes, path) };
  }

  async hash(params: PortalRpcParams<'workspace.file.hash'>): Promise<PortalRpcResult<'workspace.file.hash'>> {
    const path = canonicalPath(params.path);
    const absolutePath = await this.#regularFile(params.workspaceId, path);
    const bytes = await this.#readBounded(absolutePath, path, this.#limits.maxReadBytes);
    let text: string | undefined;
    try {
      text = decodeText(bytes, path);
    } catch (cause) {
      if (!(cause instanceof WorkspaceFileError) || cause.data.code !== 'UNSUPPORTED_CONTENT') throw cause;
    }
    return {
      ...await metadata(path, absolutePath, bytes),
      ...(text === undefined ? {} : { lineCount: lineCount(text) }),
    };
  }

  async write(params: PortalRpcParams<'workspace.file.write'>): Promise<PortalRpcResult<'workspace.file.write'>> {
    return await this.#withMutationLock(
      params.workspaceId,
      () => this.#writeUnlocked(params),
    );
  }

  async #writeUnlocked(
    params: PortalRpcParams<'workspace.file.write'>,
  ): Promise<PortalRpcResult<'workspace.file.write'>> {
    const path = canonicalPath(params.path);
    const bytes = new TextEncoder().encode(params.content);
    if (bytes.byteLength > this.#limits.maxWriteBytes) return fail('PAYLOAD_TOO_LARGE', { path });
    const { absolutePath, parent } = await this.#writablePath(params.workspaceId, path);
    const current = await this.#statMaybe(absolutePath);
    if (current?.isSymlink) return fail('SYMLINK_NOT_ALLOWED', { path });
    if (current && !current.isFile) return fail('NOT_FILE', { path });
    if (params.expectedContentHash === null && current) return fail('ALREADY_EXISTS', { path });
    if (params.expectedContentHash !== null && !current) {
      return fail('STALE_CONTENT', { path, expectedContentHash: params.expectedContentHash });
    }

    let currentHash: string | undefined;
    if (current) {
      currentHash = await sha256(await this.#readBounded(absolutePath, path, this.#limits.maxReadBytes));
      if (currentHash !== params.expectedContentHash) {
        return fail('STALE_CONTENT', {
          path,
          expectedContentHash: params.expectedContentHash ?? undefined,
          actualContentHash: currentHash,
        });
      }
    }

    const temporaryPath = `${parent}/.${basename(path)}.weave-${crypto.randomUUID()}.tmp`;
    try {
      await Deno.writeFile(temporaryPath, bytes, { createNew: true, ...(current?.mode ? { mode: current.mode } : {}) });
      if (params.expectedContentHash === null) {
        try {
          await Deno.link(temporaryPath, absolutePath);
        } catch (cause) {
          if (cause instanceof Deno.errors.AlreadyExists) return fail('ALREADY_EXISTS', { path });
          throw cause;
        }
      } else {
        const latest = await this.#statMaybe(absolutePath);
        if (!latest?.isFile || latest.isSymlink) {
          return fail('STALE_CONTENT', { path, expectedContentHash: params.expectedContentHash });
        }
        const latestHash = await sha256(await this.#readBounded(absolutePath, path, this.#limits.maxReadBytes));
        if (latestHash !== params.expectedContentHash) {
          return fail('STALE_CONTENT', {
            path,
            expectedContentHash: params.expectedContentHash,
            actualContentHash: latestHash,
          });
        }
        await Deno.rename(temporaryPath, absolutePath);
      }
    } finally {
      await Deno.remove(temporaryPath).catch((cause) => {
        if (!(cause instanceof Deno.errors.NotFound)) throw cause;
      });
    }
    return await metadata(path, absolutePath, bytes);
  }

  async createDirectory(
    params: PortalRpcParams<'workspace.directory.create'>,
  ): Promise<PortalRpcResult<'workspace.directory.create'>> {
    return await this.#withMutationLock(params.workspaceId, () => this.#createDirectoryUnlocked(params));
  }

  async #createDirectoryUnlocked(
    params: PortalRpcParams<'workspace.directory.create'>,
  ): Promise<PortalRpcResult<'workspace.directory.create'>> {
    const path = canonicalPath(params.path);
    const root = this.#root(params.workspaceId);
    let current = root;
    for (const segment of path.split('/')) {
      current = `${current}/${segment}`;
      const details = await this.#statMaybe(current);
      if (details?.isSymlink) return fail('SYMLINK_NOT_ALLOWED', { path });
      if (details && !details.isDirectory) return fail('NOT_DIRECTORY', { path });
      if (!details) await Deno.mkdir(current);
    }
    return { ok: true, path };
  }

  async move(params: PortalRpcParams<'workspace.file.move'>): Promise<PortalRpcResult<'workspace.file.move'>> {
    return await this.#withMutationLock(params.workspaceId, () => this.#moveUnlocked(params));
  }

  async #moveUnlocked(
    params: PortalRpcParams<'workspace.file.move'>,
  ): Promise<PortalRpcResult<'workspace.file.move'>> {
    const fromPath = canonicalPath(params.fromPath);
    const toPath = canonicalPath(params.toPath);
    if (fromPath === toPath) return { ok: true, path: toPath };
    const source = await this.#existingPath(params.workspaceId, fromPath);
    const { absolutePath: target } = await this.#writablePath(params.workspaceId, toPath);
    const existingTarget = await this.#statMaybe(target);
    if (existingTarget?.isSymlink) return fail('SYMLINK_NOT_ALLOWED', { path: toPath });
    if (existingTarget && !params.overwrite) return fail('ALREADY_EXISTS', { path: toPath });
    if (existingTarget) await Deno.remove(target, { recursive: true });
    await Deno.rename(source, target);
    return { ok: true, path: toPath };
  }

  async delete(params: PortalRpcParams<'workspace.file.delete'>): Promise<PortalRpcResult<'workspace.file.delete'>> {
    return await this.#withMutationLock(params.workspaceId, () => this.#deleteUnlocked(params));
  }

  async #deleteUnlocked(
    params: PortalRpcParams<'workspace.file.delete'>,
  ): Promise<PortalRpcResult<'workspace.file.delete'>> {
    const path = canonicalPath(params.path);
    const absolutePath = await this.#existingPath(params.workspaceId, path);
    const details = await Deno.lstat(absolutePath);
    if (details.isDirectory && !params.recursive) {
      try {
        await Deno.remove(absolutePath);
      } catch (cause) {
        if ((cause as { code?: unknown }).code === 'ENOTEMPTY') return fail('DIRECTORY_NOT_EMPTY', { path });
        throw cause;
      }
    } else {
      await Deno.remove(absolutePath, { recursive: params.recursive === true });
    }
    return { ok: true, path };
  }

  async search(params: PortalRpcParams<'workspace.file.search'>): Promise<PortalRpcResult<'workspace.file.search'>> {
    const path = canonicalPath(params.path, true);
    const directory = await this.#existingPath(params.workspaceId, path);
    if (!(await Deno.stat(directory)).isDirectory) return fail('NOT_DIRECTORY', { path });
    const query = params.query.toLocaleLowerCase();
    const limit = Math.min(params.limit ?? this.#limits.maxSearchResults, this.#limits.maxSearchResults);
    const matches: PortalRpcResult<'workspace.file.search'>['matches'] = [];
    let visitedFiles = 0;
    let truncated = false;

    const add = (match: PortalRpcResult<'workspace.file.search'>['matches'][number]) => {
      if (matches.length >= limit) {
        truncated = true;
        return false;
      }
      matches.push(match);
      return true;
    };

    const walk = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
      const directoryEntries: Deno.DirEntry[] = [];
      let directoryWasTruncated = false;
      for await (const entry of Deno.readDir(absoluteDirectory)) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        directoryEntries.push(entry);
        directoryEntries.sort(compareDirectoryEntries);
        if (directoryEntries.length > this.#limits.maxDirectoryEntries) {
          directoryEntries.pop();
          directoryWasTruncated = true;
        }
      }
      for (const entry of directoryEntries) {
        if (truncated) return;
        const entryPath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        const absolutePath = `${absoluteDirectory}/${entry.name}`;
        const details = await Deno.lstat(absolutePath).catch(() => undefined);
        if (!details || details.isSymlink) continue;
        if ((params.scope === 'path' || params.scope === 'both') && entryPath.toLocaleLowerCase().includes(query)) {
          if (!add({ path: entryPath, kind: 'path' })) return;
        }
        if (details.isDirectory) {
          await walk(absolutePath, entryPath);
          continue;
        }
        if (!details.isFile) continue;
        visitedFiles += 1;
        if (visitedFiles > this.#limits.maxSearchFiles) {
          truncated = true;
          return;
        }
        if (params.scope === 'path' || details.size > this.#limits.maxSearchBytesPerFile) continue;
        let content: string;
        try {
          content = decodeText(
            await this.#readBounded(absolutePath, entryPath, this.#limits.maxSearchBytesPerFile),
            entryPath,
          );
        } catch (cause) {
          if (
            cause instanceof WorkspaceFileError &&
            (cause.data.code === 'UNSUPPORTED_CONTENT' || cause.data.code === 'PAYLOAD_TOO_LARGE')
          ) continue;
          throw cause;
        }
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index].toLocaleLowerCase().includes(query)) continue;
          if (!add({ path: entryPath, kind: 'content', line: index + 1, preview: lines[index].trim().slice(0, 240) })) {
            return;
          }
        }
      }
      if (directoryWasTruncated) truncated = true;
    };

    await walk(directory, path);
    return { path, matches, truncated };
  }

  openWatchSession(send: (notification: WorkspaceFileWatchNotification) => void) {
    const session = new WorkspaceFileWatchSession(
      this.#limits,
      this.#dependencies,
      (workspaceId, paths) => this.#resolveWatchPaths(workspaceId, paths),
      send,
      () => this.#watchSessions.delete(session),
    );
    this.#watchSessions.add(session);
    return session;
  }

  close() {
    for (const session of [...this.#watchSessions]) session.close();
  }

  #root(workspaceId: string) {
    const root = this.#roots.get(workspaceId);
    if (!root) return fail('WORKSPACE_UNAVAILABLE');
    return root;
  }

  async #existingPath(workspaceId: string, path: string) {
    const root = this.#root(workspaceId);
    let current = root;
    for (const segment of path.split('/').filter(Boolean)) {
      current = `${current}/${segment}`;
      let details: Deno.FileInfo;
      try {
        details = await Deno.lstat(current);
      } catch (cause) {
        if (cause instanceof Deno.errors.NotFound) return fail('NOT_FOUND', { path });
        throw cause;
      }
      if (details.isSymlink) return fail('SYMLINK_NOT_ALLOWED', { path });
    }
    const resolved = await Deno.realPath(current).catch((cause) => {
      if (cause instanceof Deno.errors.NotFound) return fail('NOT_FOUND', { path });
      throw cause;
    });
    if (!isWithinRoot(root, resolved)) return fail('SYMLINK_NOT_ALLOWED', { path });
    return resolved;
  }

  async #regularFile(workspaceId: string, path: string) {
    const absolutePath = await this.#existingPath(workspaceId, path);
    if (!(await Deno.stat(absolutePath)).isFile) return fail('NOT_FILE', { path });
    return absolutePath;
  }

  async #writablePath(workspaceId: string, path: string) {
    const parent = await this.#existingPath(workspaceId, parentPath(path));
    if (!(await Deno.stat(parent)).isDirectory) return fail('NOT_DIRECTORY', { path });
    return { absolutePath: `${parent}/${basename(path)}`, parent };
  }

  async #statMaybe(path: string) {
    try {
      return await Deno.lstat(path);
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) return undefined;
      throw cause;
    }
  }

  async #readBounded(absolutePath: string, path: string, limit: number) {
    const details = await Deno.stat(absolutePath);
    if (details.size > limit) return fail('PAYLOAD_TOO_LARGE', { path });
    const bytes = await Deno.readFile(absolutePath);
    if (bytes.byteLength > limit) return fail('PAYLOAD_TOO_LARGE', { path });
    return bytes;
  }

  async #withMutationLock<Result>(key: string, action: () => Promise<Result>) {
    const previous = this.#mutationLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = previous.then(() =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    this.#mutationLocks.set(key, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#mutationLocks.get(key) === current) this.#mutationLocks.delete(key);
    }
  }

  async #resolveWatchPaths(workspaceId: string, paths: string[]) {
    if (!paths.length || paths.length > this.#limits.maxWatchPaths) return fail('INVALID_PATH');
    const root = this.#root(workspaceId);
    const unique = [...new Set(paths.map((path) => canonicalPath(path, true)))];
    const resolved: Array<{ path: string; absolutePath: string }> = [];
    for (const path of unique) {
      resolved.push({ path, absolutePath: await this.#existingPath(workspaceId, path) });
    }
    return { root, paths: resolved };
  }
}

type ResolvedWatchPaths = {
  root: string;
  paths: Array<{ path: string; absolutePath: string }>;
};

class WorkspaceFileWatchSubscription {
  readonly id: string;
  readonly workspaceId: string;
  readonly #dependencies: WorkspaceFileDependencies;
  readonly #debounceMs: number;
  readonly #send: (notification: WorkspaceFileWatchNotification) => void;
  #resolved: ResolvedWatchPaths;
  #watcher?: WorkspaceFileSystemWatcher;
  #generation = 0;
  #closed = false;
  #timer?: ReturnType<typeof setTimeout>;
  #pending?: { kind: WorkspaceFileWatchEvent['kind']; paths: Set<string>; directories: Set<string>; rescan: boolean };

  constructor(
    id: string,
    workspaceId: string,
    resolved: ResolvedWatchPaths,
    dependencies: WorkspaceFileDependencies,
    debounceMs: number,
    send: (notification: WorkspaceFileWatchNotification) => void,
  ) {
    this.id = id;
    this.workspaceId = workspaceId;
    this.#resolved = resolved;
    this.#dependencies = dependencies;
    this.#debounceMs = debounceMs;
    this.#send = send;
  }

  get paths() {
    return this.#resolved.paths.map((path) => path.path);
  }

  start() {
    this.#replaceWatcher();
  }

  update(resolved: ResolvedWatchPaths) {
    if (this.#closed) return fail('WATCH_NOT_FOUND');
    this.#resolved = resolved;
    this.#replaceWatcher();
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    this.#watcher?.close();
    this.#watcher = undefined;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = undefined;
  }

  #replaceWatcher() {
    this.#generation += 1;
    const generation = this.#generation;
    this.#watcher?.close();
    const absolutePaths = this.#resolved.paths.map((path) => path.absolutePath);
    const watcher = this.#dependencies.watchFs(absolutePaths, { recursive: false });
    this.#watcher = watcher;
    void this.#consume(watcher, generation);
  }

  async #consume(watcher: WorkspaceFileSystemWatcher, generation: number) {
    try {
      for await (const event of watcher) {
        if (this.#closed || generation !== this.#generation) return;
        this.#queue(event);
      }
    } catch {
      if (!this.#closed && generation === this.#generation) {
        this.#send({
          subscriptionId: this.id,
          event: {
            kind: 'other',
            paths: [],
            affectedDirectories: this.paths,
            rescan: true,
          },
        });
      }
    }
  }

  #queue(event: Deno.FsEvent) {
    const paths = event.paths
      .map((path) => relativeToRoot(this.#resolved.root, path.replace(/\/$/, '')))
      .filter((path): path is string => path !== undefined);
    const directories = paths.map(parentPath);
    this.#pending ??= { kind: event.kind, paths: new Set(), directories: new Set(), rescan: false };
    if (this.#pending.kind !== event.kind) this.#pending.kind = 'any';
    for (const path of paths) this.#pending.paths.add(path);
    for (const directory of directories) this.#pending.directories.add(directory);
    if ('flag' in event && event.flag === 'rescan') this.#pending.rescan = true;
    if (this.#pending.rescan && !directories.length) {
      for (const path of this.paths) this.#pending.directories.add(path);
    }
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#flush(), this.#debounceMs);
  }

  #flush() {
    const pending = this.#pending;
    this.#pending = undefined;
    this.#timer = undefined;
    if (!pending) return;
    this.#send({
      subscriptionId: this.id,
      event: {
        kind: pending.kind,
        paths: [...pending.paths].sort(),
        affectedDirectories: [...pending.directories].sort(),
        ...(pending.rescan ? { rescan: true } : {}),
      },
    });
  }
}

export class WorkspaceFileWatchSession {
  readonly #limits: WorkspaceFileLimits;
  readonly #dependencies: WorkspaceFileDependencies;
  readonly #resolve: (workspaceId: string, paths: string[]) => Promise<ResolvedWatchPaths>;
  readonly #send: (notification: WorkspaceFileWatchNotification) => void;
  readonly #onClose: () => void;
  readonly #subscriptions = new Map<string, WorkspaceFileWatchSubscription>();
  #closed = false;

  constructor(
    limits: WorkspaceFileLimits,
    dependencies: WorkspaceFileDependencies,
    resolve: (workspaceId: string, paths: string[]) => Promise<ResolvedWatchPaths>,
    send: (notification: WorkspaceFileWatchNotification) => void,
    onClose: () => void,
  ) {
    this.#limits = limits;
    this.#dependencies = dependencies;
    this.#resolve = resolve;
    this.#send = send;
    this.#onClose = onClose;
  }

  async start(
    params: PortalRpcParams<'workspace.file.watch.start'>,
  ): Promise<PortalRpcResult<'workspace.file.watch.start'>> {
    if (this.#closed) return fail('WATCH_NOT_FOUND');
    const resolved = await this.#resolve(params.workspaceId, params.paths);
    const id = this.#dependencies.createId();
    const subscription = new WorkspaceFileWatchSubscription(
      id,
      params.workspaceId,
      resolved,
      this.#dependencies,
      this.#limits.watchDebounceMs,
      this.#send,
    );
    this.#subscriptions.set(id, subscription);
    subscription.start();
    return { subscriptionId: id, paths: subscription.paths };
  }

  async update(
    params: PortalRpcParams<'workspace.file.watch.update'>,
  ): Promise<PortalRpcResult<'workspace.file.watch.update'>> {
    const subscription = this.#subscriptions.get(params.subscriptionId);
    if (!subscription) return fail('WATCH_NOT_FOUND');
    const resolved = await this.#resolve(subscription.workspaceId, params.paths);
    subscription.update(resolved);
    return { subscriptionId: subscription.id, paths: subscription.paths };
  }

  stop(
    params: PortalRpcParams<'workspace.file.watch.stop'>,
  ): PortalRpcResult<'workspace.file.watch.stop'> {
    const subscription = this.#subscriptions.get(params.subscriptionId);
    if (!subscription) return fail('WATCH_NOT_FOUND');
    subscription.close();
    this.#subscriptions.delete(params.subscriptionId);
    return { ok: true };
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscription of this.#subscriptions.values()) subscription.close();
    this.#subscriptions.clear();
    this.#onClose();
  }
}
