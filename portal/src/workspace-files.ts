import { applyUnifiedDiff } from '../../packages/client/src/lib/proposal-unified-diff.ts';

export type PortalWorkspaceFileRoot = {
  id: string;
  name?: string;
  path: string;
};

export type PortalWorkspaceFileMount = {
  projectId: string;
  localPath: string;
};

export type PortalWorkspaceFileConfig = {
  mounts?: PortalWorkspaceFileMount[];
  roots?: PortalWorkspaceFileRoot[];
};

export type PortalWorkspaceFileTarget = {
  projectId?: string;
  workspaceId?: string;
  portalId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
};

export type PortalWorkspaceFileEntry = {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'other';
  hidden?: boolean;
  size?: number;
  mtimeMs?: number;
};

export type PortalWorkspaceFileNote = {
  path: string;
  documentType?: 'markdown' | 'coppermind';
  title: string;
  headings: string[];
  tags: string[];
  links: string[];
  embeds: string[];
  properties: Record<string, string>;
  mtimeMs?: number;
  size?: number;
  preview?: string;
};

export type PortalWorkspaceFileAttachment = {
  path: string;
  name: string;
  mediaType: 'image' | 'audio' | 'video' | 'pdf' | 'excalidraw' | 'other';
  size?: number;
  mtimeMs?: number;
};

export type PortalWorkspaceFileListInput = {
  target?: PortalWorkspaceFileTarget;
  path?: string;
} & PortalWorkspaceFileTarget;

export type PortalWorkspaceFileListResult = {
  path: string;
  entries: PortalWorkspaceFileEntry[];
};

export type PortalWorkspaceFileIndexInput = {
  target?: PortalWorkspaceFileTarget;
  path?: string;
} & PortalWorkspaceFileTarget;

export type PortalWorkspaceFileIndexResult = {
  path: string;
  entries: PortalWorkspaceFileEntry[];
  notes: PortalWorkspaceFileNote[];
  attachments: PortalWorkspaceFileAttachment[];
  backlinks: Record<string, string[]>;
  checkedAt: string;
};

export type PortalWorkspaceFileReadInput = {
  target?: PortalWorkspaceFileTarget;
  path: string;
} & PortalWorkspaceFileTarget;

export type PortalWorkspaceFileFile = {
  path: string;
  content: string;
  version: string;
  size?: number;
  mtimeMs?: number;
};

export type PortalWorkspaceFileHashInput = {
  target?: PortalWorkspaceFileTarget;
  path: string;
} & PortalWorkspaceFileTarget;

export type PortalWorkspaceFileHashResult = {
  path: string;
  contentHash: string;
  version: string;
  size?: number;
  mtimeMs?: number;
  lineCount?: number;
};

export type PortalWorkspaceFileDiffPreviewInput = {
  target?: PortalWorkspaceFileTarget;
  path: string;
  diff: string;
} & PortalWorkspaceFileTarget;

export type PortalWorkspaceFileDiffPreviewResult = {
  path: string;
  currentHash: string;
  proposedHash: string;
  currentContent: string;
  proposedContent: string;
  additions: number;
  deletions: number;
  version: string;
  size?: number;
  mtimeMs?: number;
};

export type PortalWorkspaceFileWriteInput = {
  target?: PortalWorkspaceFileTarget;
  path: string;
  content: string;
  version?: string;
  createParents?: boolean;
} & PortalWorkspaceFileTarget;

export type PortalWorkspaceFileWriteResult = {
  path: string;
  version: string;
  size?: number;
  mtimeMs?: number;
};

export type PortalWorkspaceFileMkdirInput = {
  target?: PortalWorkspaceFileTarget;
  path: string;
} & PortalWorkspaceFileTarget;

export type PortalWorkspaceFileMoveInput = {
  target?: PortalWorkspaceFileTarget;
  fromPath: string;
  toPath: string;
  overwrite?: boolean;
  createParents?: boolean;
} & PortalWorkspaceFileTarget;

export type PortalWorkspaceFileDeleteInput = {
  target?: PortalWorkspaceFileTarget;
  path: string;
  recursive?: boolean;
} & PortalWorkspaceFileTarget;

export type PortalWorkspaceFileUploadInput = {
  target?: PortalWorkspaceFileTarget;
  path: string;
  base64Content: string;
  contentType?: string;
} & PortalWorkspaceFileTarget;

export type PortalWorkspaceFileWatchInput = {
  target?: PortalWorkspaceFileTarget;
  paths?: string[];
} & PortalWorkspaceFileTarget;

export type PortalWorkspaceFileOperationResult = {
  ok: true;
  path?: string;
};

export type PortalWorkspaceFileWatchEvent = {
  kind: Deno.FsEvent['kind'] | 'any';
  paths: string[];
  affectedDirectories: string[];
  rescan?: boolean;
};

export type PortalWorkspaceFileWatchReadyEvent = {
  type: 'workspace-file.watch.ready';
  requestId?: string;
  paths: string[];
};

export type PortalWorkspaceFileWatchChangeEvent = {
  type: 'workspace-file.watch.change';
  event: PortalWorkspaceFileWatchEvent;
};

export type PortalWorkspaceFileWatchErrorEvent = {
  type: 'workspace-file.watch.error';
  requestId?: string;
  error: string;
};

export type PortalWorkspaceFileWatchHostEvent =
  | PortalWorkspaceFileWatchReadyEvent
  | PortalWorkspaceFileWatchChangeEvent
  | PortalWorkspaceFileWatchErrorEvent;

export type PortalWorkspaceFileWatchClientMessage =
  | { type: 'watch.start'; requestId?: string; target?: PortalWorkspaceFileTarget; paths?: string[] }
  | { type: 'watch.update'; requestId?: string; paths?: string[] }
  | { type: 'watch.stop'; requestId?: string };

export type PortalWorkspaceFileWatchClientEnvelope = {
  type: 'workspace-file.watch.client';
  clientId: string;
  message: PortalWorkspaceFileWatchClientMessage;
};

export type PortalWorkspaceFileWatchEventHandler = (event: PortalWorkspaceFileWatchEvent) => void | Promise<void>;
export type PortalWorkspaceFileWatchErrorHandler = (error: Error) => void | Promise<void>;

export type PortalWorkspaceFileFsWatcher = AsyncIterable<Deno.FsEvent> & {
  close: () => void;
};

export type PortalWorkspaceFileWatchFactory = (
  paths: string | string[],
  options: { recursive: boolean },
) => PortalWorkspaceFileFsWatcher;

export type PortalWorkspaceFileHostOptions = {
  config: PortalWorkspaceFileConfig;
  maxReadBytes?: number;
  maxIndexBytes?: number;
  watchFs?: PortalWorkspaceFileWatchFactory;
  watchDebounceMs?: number;
};

const defaultMaxReadBytes = 2 * 1024 * 1024;
const defaultMaxIndexBytes = 2 * 1024 * 1024;
const defaultWatchDebounceMs = 80;
const maxIndexedFiles = 5_000;

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

const removeExtension = (name: string) => name.replace(/\.[^.]+$/, '');
const isAbsolutePath = (path: string) => path.startsWith('/');
const expandHomePath = (path: string) => {
  if (path === '~') return Deno.env.get('HOME') ?? path;
  if (path.startsWith('~/')) return `${Deno.env.get('HOME') ?? '~'}${path.slice(1)}`;
  return path;
};

export const parseWorkspaceFilePath = (value: unknown, name = 'path') => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  if (value.includes('\0')) throw new Error(`${name} cannot contain null bytes.`);

  const normalizedInput = value.trim().replace(/\\/g, '/');
  if (!normalizedInput || normalizedInput === '.') return '';
  if (normalizedInput.startsWith('/') || /^[a-zA-Z]:\//.test(normalizedInput)) {
    throw new Error(`${name} must be relative to the workspace root.`);
  }

  const normalized = normalizePath(normalizedInput);
  if (normalized === '.' || normalized === '') return '';
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${name} cannot escape the workspace root.`);
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
    throw new Error('Only UTF-8 text files can be opened in the workspace.');
  }
};

const hashBytes = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 12);
};

const countTextLines = (content: string) => {
  if (!content) return 0;
  return content.endsWith('\n') ? content.slice(0, -1).split('\n').length : content.split('\n').length;
};

const isMarkdownPath = (path: string) => /\.(md|markdown)$/i.test(path);
const isExcalidrawPath = (path: string) => /\.excalidraw$/i.test(path);
const isCoppermindPath = (path: string) => /\.cpr$/i.test(path);
const decodeBase64 = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));

const attachmentMediaType = (path: string): PortalWorkspaceFileAttachment['mediaType'] => {
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

const parseMarkdownNote = (path: string, content: string, details: Deno.FileInfo): PortalWorkspaceFileNote => {
  const { properties, body } = parseFrontmatter(content);
  const headings = Array.from(body.matchAll(/^#{1,6}\s+(.+)$/gm)).map(match => match[1].trim());
  const wikiMatches = Array.from(content.matchAll(/(!?)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g));
  const markdownMatches = Array.from(content.matchAll(/(!?)\[[^\]]*]\(([^)#][^)]*)\)/g));
  const tags = Array.from(new Set(Array.from(content.matchAll(/(?:^|\s)#([A-Za-z0-9_/-]+)/g)).map(match => match[1])));
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
    mtimeMs: details.mtime?.getTime(),
    size: details.size,
    preview,
  };
};

const getBlockSuiteText = (value: unknown) => {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value) || !Array.isArray(value.delta)) return '';
  return value.delta
    .map(operation => isRecord(operation) && typeof operation.insert === 'string' ? operation.insert : '')
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
    .map(block => isRecord(block) && typeof block.text === 'string' ? block.text.trim() : '')
    .filter(Boolean)
    .join(' ');
};

const parseCoppermindNote = (path: string, content: string, details: Deno.FileInfo): PortalWorkspaceFileNote => {
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
    mtimeMs: details.mtime?.getTime(),
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

const getRoots = (config: PortalWorkspaceFileConfig) =>
  config.roots?.length ? config.roots : [{ id: 'default', name: 'Default', path: Deno.env.get('HOME') ?? '.' }];

const flattenInput = <T extends Record<string, unknown>>(input: T) => {
  const target = isRecord(input.target) ? input.target : {};
  const { target: _target, ...rest } = input;
  return { ...rest, ...target };
};

const toErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const requestIdValue = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const parseWorkspaceFileWatchPaths = (value: unknown) => {
  const input = Array.isArray(value) ? value : [''];
  const paths = input.map((item) => parseWorkspaceFilePath(item)).filter((item, index, all) => all.indexOf(item) === index);
  return paths.length ? paths : [''];
};

const relativePathFromAbsolute = (root: string, path: string) => {
  const normalizedRoot = trimTrailingSlash(normalizePath(root.replace(/\\/g, '/')));
  const normalizedPath = trimTrailingSlash(normalizePath(path.replace(/\\/g, '/')));
  if (normalizedPath === normalizedRoot) return '';
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return undefined;
  return normalizedPath.slice(normalizedRoot.length + 1);
};

export const joinPortalWorkspaceFilePath = joinPath;

export const assertPortalWorkspaceFilePathWithinRoot = (
  root: string,
  candidate: string,
  message = 'workspace file path cannot escape the workspace root.',
) => {
  const normalizedRoot = trimTrailingSlash(normalizePath(root));
  const normalizedCandidate = trimTrailingSlash(normalizePath(candidate));
  if (normalizedCandidate === normalizedRoot) return;
  if (!normalizedCandidate.startsWith(`${normalizedRoot}/`)) throw new Error(message);
};

export const resolvePortalWorkspaceFileRoot = async (
  config: PortalWorkspaceFileConfig,
  input: Record<string, unknown>,
) => {
  const workspacePath = optionalString(input.workspacePath);
  if (workspacePath) return await Deno.realPath(expandHomePath(workspacePath));

  const projectId = optionalString(input.projectId);
  const mount = projectId ? (config.mounts ?? []).find((item) => item.projectId === projectId) : undefined;
  if (mount) return await Deno.realPath(mount.localPath);

  const rootId = optionalString(input.rootId);
  const repoPath = optionalString(input.repoPath);
  if (rootId && repoPath) {
    const root = getRoots(config).find((item) => item.id === rootId);
    if (!root) throw new Error(`Unknown root: ${rootId}`);
    const rootPath = await Deno.realPath(root.path);
    const normalizedRepoPath = expandHomePath(repoPath);
    const target = await Deno.realPath(isAbsolutePath(normalizedRepoPath)
      ? normalizedRepoPath
      : joinPath(rootPath, parseWorkspaceFilePath(repoPath, 'repoPath')));
    assertPortalWorkspaceFilePathWithinRoot(rootPath, target, 'Path escapes Portal root');
    return target;
  }

  throw new Error(`Project is not mounted: ${String(input.projectId)}`);
};

type PortalWorkspaceFileWatchOptions = {
  root: string;
  paths: string[];
  watchFs: PortalWorkspaceFileWatchFactory;
  debounceMs: number;
  onEvent: PortalWorkspaceFileWatchEventHandler;
  onError?: PortalWorkspaceFileWatchErrorHandler;
};

type PendingWatchEvent = {
  kind?: PortalWorkspaceFileWatchEvent['kind'];
  paths: Set<string>;
  affectedDirectories: Set<string>;
  rescan: boolean;
};

export class PortalWorkspaceFileWatchSubscription {
  private readonly root: string;
  private readonly watchFs: PortalWorkspaceFileWatchFactory;
  private readonly debounceMs: number;
  private readonly onEvent: PortalWorkspaceFileWatchEventHandler;
  private readonly onError?: PortalWorkspaceFileWatchErrorHandler;
  private watcher?: PortalWorkspaceFileFsWatcher;
  private closed = false;
  private generation = 0;
  private paths: string[] = [];
  private pending?: PendingWatchEvent;
  private debounceTimer?: ReturnType<typeof setTimeout>;

  constructor(options: PortalWorkspaceFileWatchOptions) {
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
    if (this.closed) throw new Error('Workspace file watch subscription is closed.');
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
      const candidate = joinPath(this.root, parseWorkspaceFilePath(relativePath));
      assertPortalWorkspaceFilePathWithinRoot(this.root, candidate);
      const details = await Deno.stat(candidate).catch((error) => {
        if (error instanceof Deno.errors.NotFound) return undefined;
        throw error;
      });
      if (!details) {
        if (!relativePath) throw new Error('Workspace file root was not found.');
        continue;
      }
      if (!details.isDirectory) {
        if (!relativePath) throw new Error('Workspace file root is not a directory.');
        continue;
      }
      const realPath = await Deno.realPath(candidate);
      assertPortalWorkspaceFilePathWithinRoot(this.root, realPath);
      resolved.push({ relativePath, absolutePath: realPath });
    }
    return resolved;
  }

  private async runWatcher(watcher: PortalWorkspaceFileFsWatcher, generation: number) {
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
    const event: PortalWorkspaceFileWatchEvent = {
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

export const isWorkspaceFileWatchClientEnvelope = (message: Record<string, unknown>): message is PortalWorkspaceFileWatchClientEnvelope =>
  message.type === 'workspace-file.watch.client' &&
  typeof message.clientId === 'string' &&
  Boolean(message.message && typeof message.message === 'object');

export class PortalWorkspaceFileHost {
  private readonly config: PortalWorkspaceFileConfig;
  private readonly maxReadBytes: number;
  private readonly maxIndexBytes: number;
  private readonly watchFs: PortalWorkspaceFileWatchFactory;
  private readonly watchDebounceMs: number;
  private readonly watchClients = new Map<string, PortalWorkspaceFileWatchSubscription>();

  constructor(options: PortalWorkspaceFileHostOptions) {
    this.config = options.config;
    this.maxReadBytes = options.maxReadBytes ?? defaultMaxReadBytes;
    this.maxIndexBytes = options.maxIndexBytes ?? defaultMaxIndexBytes;
    this.watchFs = options.watchFs ?? Deno.watchFs;
    this.watchDebounceMs = options.watchDebounceMs ?? defaultWatchDebounceMs;
  }

  async list(input: PortalWorkspaceFileListInput): Promise<PortalWorkspaceFileListResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseWorkspaceFilePath(record.path);
    const directoryPath = await this.resolveExistingPath(root, relativePath);
    const details = await Deno.stat(directoryPath);
    if (!details.isDirectory) throw new Error('workspace file path is not a directory.');

    const entries: PortalWorkspaceFileEntry[] = [];
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

  async index(input: PortalWorkspaceFileIndexInput): Promise<PortalWorkspaceFileIndexResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseWorkspaceFilePath(record.path);
    const directoryPath = await this.resolveExistingPath(root, relativePath);
    const details = await Deno.stat(directoryPath);
    if (!details.isDirectory) throw new Error('workspace file path is not a directory.');

    const entries = await this.listEntries(directoryPath, relativePath);
    const notes: PortalWorkspaceFileNote[] = [];
    const attachments: PortalWorkspaceFileAttachment[] = [];
    let visited = 0;

    const walk = async (absoluteDir: string, relativeDir: string) => {
      for await (const entry of Deno.readDir(absoluteDir)) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const entryRelativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const entryAbsolutePath = joinPath(absoluteDir, entry.name);
        const stat = await Deno.stat(entryAbsolutePath).catch(() => undefined);
        if (!stat) continue;

        if (entry.isDirectory) {
          await walk(entryAbsolutePath, entryRelativePath);
          continue;
        }

        if (!entry.isFile || visited >= maxIndexedFiles) continue;
        visited += 1;

        if ((isMarkdownPath(entryRelativePath) || isCoppermindPath(entryRelativePath)) && stat.size <= this.maxIndexBytes) {
          const bytes = await Deno.readFile(entryAbsolutePath);
          const content = decodeUtf8(bytes);
          notes.push(isCoppermindPath(entryRelativePath)
            ? parseCoppermindNote(entryRelativePath, content, stat)
            : parseMarkdownNote(entryRelativePath, content, stat));
          continue;
        }

        attachments.push({
          path: entryRelativePath,
          name: entry.name,
          mediaType: attachmentMediaType(entryRelativePath),
          mtimeMs: stat.mtime?.getTime(),
          size: stat.size,
        });
      }
    };

    await walk(directoryPath, relativePath);

    const noteLookup = new Map<string, string>();
    for (const note of notes) {
      noteLookup.set(note.path.toLowerCase(), note.path);
      noteLookup.set(removeExtension(getBasename(note.path)).toLowerCase(), note.path);
      noteLookup.set(getBasename(note.path).toLowerCase(), note.path);
    }

    const backlinks: Record<string, string[]> = {};
    for (const note of notes) {
      for (const link of note.links) {
        const resolved = targetCandidates(link).map(candidate => noteLookup.get(candidate)).find(Boolean);
        if (!resolved) continue;
        backlinks[resolved] = backlinks[resolved] ?? [];
        backlinks[resolved].push(note.path);
      }
    }

    for (const path of Object.keys(backlinks)) {
      backlinks[path] = [...new Set(backlinks[path])].sort();
    }

    return {
      path: relativePath,
      entries,
      notes: notes.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' })),
      attachments: attachments.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' })),
      backlinks,
      checkedAt: new Date().toISOString(),
    };
  }

  async read(input: PortalWorkspaceFileReadInput): Promise<PortalWorkspaceFileFile> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseWorkspaceFilePath(record.path);
    if (!relativePath) throw new Error('path is required.');

    const filePath = await this.resolveExistingPath(root, relativePath);
    const details = await Deno.stat(filePath);
    if (!details.isFile) throw new Error('workspace file path is not a file.');
    if (details.size > this.maxReadBytes) throw new Error('File is too large to open in the workspace.');

    const bytes = await Deno.readFile(filePath);
    if (hasBinaryBytes(bytes)) throw new Error('Binary files cannot be opened in the workspace.');

    return {
      path: relativePath,
      content: decodeUtf8(bytes),
      version: getFileVersion(details),
      size: details.size,
      mtimeMs: details.mtime?.getTime(),
    };
  }

  async hash(input: PortalWorkspaceFileHashInput): Promise<PortalWorkspaceFileHashResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseWorkspaceFilePath(record.path);
    if (!relativePath) throw new Error('path is required.');

    const filePath = await this.resolveExistingPath(root, relativePath);
    const details = await Deno.stat(filePath);
    if (!details.isFile) throw new Error('workspace file path is not a file.');

    const bytes = await Deno.readFile(filePath);
    const text = hasBinaryBytes(bytes)
      ? undefined
      : (() => {
          try {
            return decodeUtf8(bytes);
          } catch {
            return undefined;
          }
        })();
    return {
      path: relativePath,
      contentHash: await hashBytes(bytes),
      version: getFileVersion(details),
      size: details.size,
      mtimeMs: details.mtime?.getTime(),
      ...(text !== undefined ? { lineCount: countTextLines(text) } : {}),
    };
  }

  async diffPreview(input: PortalWorkspaceFileDiffPreviewInput): Promise<PortalWorkspaceFileDiffPreviewResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseWorkspaceFilePath(record.path);
    if (!relativePath) throw new Error('path is required.');
    if (typeof record.diff !== 'string') throw new Error('diff must be a string.');

    const filePath = await this.resolveExistingPath(root, relativePath);
    const details = await Deno.stat(filePath);
    if (!details.isFile) throw new Error('workspace file path is not a file.');
    if (details.size > this.maxReadBytes) throw new Error('File is too large to preview in the workspace.');

    const bytes = await Deno.readFile(filePath);
    if (hasBinaryBytes(bytes)) throw new Error('Binary files cannot be previewed in the workspace.');

    const currentContent = decodeUtf8(bytes);
    const proposed = applyUnifiedDiff(currentContent, record.diff);
    if (!proposed.ok) throw new Error(proposed.error);
    return {
      path: relativePath,
      currentHash: await hashBytes(bytes),
      proposedHash: await hashBytes(new TextEncoder().encode(proposed.value.content)),
      currentContent,
      proposedContent: proposed.value.content,
      additions: proposed.value.additions,
      deletions: proposed.value.deletions,
      version: getFileVersion(details),
      size: details.size,
      mtimeMs: details.mtime?.getTime(),
    };
  }

  async write(input: PortalWorkspaceFileWriteInput): Promise<PortalWorkspaceFileWriteResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseWorkspaceFilePath(record.path);
    if (!relativePath) throw new Error('path is required.');
    if (typeof record.content !== 'string') throw new Error('content must be a string.');
    if (record.version !== undefined && typeof record.version !== 'string') throw new Error('version must be a string.');

    const filePath = record.createParents === true
      ? await this.resolveWritablePath(root, relativePath)
      : await this.resolveWritablePathWithExistingParent(root, relativePath);

    const currentDetails = await this.statMaybe(filePath);
    if (currentDetails) {
      if (!currentDetails.isFile) throw new Error('workspace file path is not a file.');
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

  async mkdir(input: PortalWorkspaceFileMkdirInput): Promise<PortalWorkspaceFileOperationResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseWorkspaceFilePath(record.path);
    if (!relativePath) throw new Error('path is required.');

    let currentPath = root;
    for (const segment of relativePath.split('/').filter(Boolean)) {
      const nextPath = joinPath(currentPath, segment);
      this.assertWithinRoot(root, nextPath);

      const details = await this.statMaybe(nextPath);
      if (details) {
        const realPath = await Deno.realPath(nextPath);
        this.assertWithinRoot(root, realPath);
        if (!details.isDirectory) throw new Error('workspace file path is not a directory.');
        currentPath = realPath;
        continue;
      }

      await Deno.mkdir(nextPath);
      currentPath = nextPath;
    }
    return { ok: true, path: relativePath };
  }

  async move(input: PortalWorkspaceFileMoveInput): Promise<PortalWorkspaceFileOperationResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const fromPath = parseWorkspaceFilePath(record.fromPath, 'fromPath');
    const toPath = parseWorkspaceFilePath(record.toPath, 'toPath');
    if (!fromPath || !toPath) throw new Error('fromPath and toPath are required.');
    if (record.overwrite !== undefined && typeof record.overwrite !== 'boolean') throw new Error('overwrite must be a boolean.');
    if (fromPath === toPath) return { ok: true, path: toPath };

    const sourcePath = await this.resolveExistingPath(root, fromPath);
    const targetPath = record.createParents === true
      ? await this.resolveWritablePath(root, toPath)
      : await this.resolveWritablePathWithExistingParent(root, toPath);
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

  async delete(input: PortalWorkspaceFileDeleteInput): Promise<PortalWorkspaceFileOperationResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseWorkspaceFilePath(record.path);
    if (!relativePath) throw new Error('path is required.');
    if (record.recursive !== undefined && typeof record.recursive !== 'boolean') throw new Error('recursive must be a boolean.');

    const targetPath = await this.resolveExistingPath(root, relativePath);
    await Deno.remove(targetPath, { recursive: record.recursive === true });
    return { ok: true, path: relativePath };
  }

  async upload(input: PortalWorkspaceFileUploadInput): Promise<PortalWorkspaceFileOperationResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseWorkspaceFilePath(record.path);
    if (!relativePath) throw new Error('path is required.');
    if (typeof record.base64Content !== 'string') throw new Error('base64Content must be a string.');
    const filePath = await this.resolveWritablePath(root, relativePath);
    await Deno.writeFile(filePath, decodeBase64(record.base64Content));
    return { ok: true, path: relativePath };
  }

  async watch(
    input: PortalWorkspaceFileWatchInput,
    handlers: { onEvent: PortalWorkspaceFileWatchEventHandler; onError?: PortalWorkspaceFileWatchErrorHandler },
  ) {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const paths = parseWorkspaceFileWatchPaths(record.paths);
    const subscription = new PortalWorkspaceFileWatchSubscription({
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
    message: PortalWorkspaceFileWatchClientMessage,
    send: (event: PortalWorkspaceFileWatchHostEvent) => void,
  ) {
    const requestId = requestIdValue(message.requestId);
    try {
      if (message.type === 'watch.start') {
        this.detachClient(clientId);
        const subscription = await this.watch({ target: message.target, paths: message.paths }, {
          onEvent: event => send({ type: 'workspace-file.watch.change', event }),
          onError: error => send({ type: 'workspace-file.watch.error', error: error.message }),
        });
        this.watchClients.set(clientId, subscription);
        send({ type: 'workspace-file.watch.ready', requestId, paths: subscription.getPaths() });
        return;
      }

      if (message.type === 'watch.update') {
        const subscription = this.watchClients.get(clientId);
        if (!subscription) throw new Error('Workspace file watch subscription was not started.');
        const paths = await subscription.update(parseWorkspaceFileWatchPaths(message.paths));
        send({ type: 'workspace-file.watch.ready', requestId, paths });
        return;
      }

      if (message.type === 'watch.stop') {
        this.detachClient(clientId);
        send({ type: 'workspace-file.watch.ready', requestId, paths: [] });
        return;
      }

      throw new Error('Unsupported workspace file watch message.');
    } catch (error) {
      send({ type: 'workspace-file.watch.error', requestId, error: toErrorMessage(error) });
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
    return await resolvePortalWorkspaceFileRoot(this.config, input);
  }

  private async resolveExistingPath(root: string, relativePath: string) {
    const normalizedPath = parseWorkspaceFilePath(relativePath);
    const candidate = joinPath(root, normalizedPath);
    const resolved = await Deno.realPath(candidate);
    this.assertWithinRoot(root, resolved);
    return resolved;
  }

  private async resolveWritablePath(root: string, relativePath: string) {
    const normalizedPath = parseWorkspaceFilePath(relativePath);
    const parentPath = joinPath(root, getParentPath(normalizedPath));
    await Deno.mkdir(parentPath, { recursive: true });
    const realParentPath = await Deno.realPath(parentPath);
    this.assertWithinRoot(root, realParentPath);
    const candidate = joinPath(realParentPath, getBasename(normalizedPath));
    this.assertWithinRoot(root, candidate);
    return candidate;
  }

  private async resolveWritablePathWithExistingParent(root: string, relativePath: string) {
    const normalizedPath = parseWorkspaceFilePath(relativePath);
    const parentPath = await this.resolveExistingPath(root, getParentPath(normalizedPath));
    const parentDetails = await Deno.stat(parentPath);
    if (!parentDetails.isDirectory) throw new Error('Workspace file parent path is not a directory.');
    const candidate = joinPath(parentPath, getBasename(normalizedPath));
    this.assertWithinRoot(root, candidate);
    return candidate;
  }

  private async listEntries(absolutePath: string, relativePath: string) {
    const entries: PortalWorkspaceFileEntry[] = [];
    for await (const entry of Deno.readDir(absolutePath)) {
      const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const stat = await Deno.stat(joinPath(absolutePath, entry.name)).catch(() => undefined);
      entries.push({
        name: entry.name,
        path: entryPath,
        type: entry.isDirectory ? 'directory' : entry.isFile ? 'file' : 'other',
        hidden: entry.name.startsWith('.'),
        mtimeMs: stat?.mtime?.getTime(),
        size: stat?.size,
      });
    }
    return entries.sort((left, right) => {
      if (left.type !== right.type) {
        if (left.type === 'directory') return -1;
        if (right.type === 'directory') return 1;
      }
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    });
  }

  private assertWithinRoot(root: string, candidate: string, message = 'workspace file path cannot escape the workspace root.') {
    assertPortalWorkspaceFilePathWithinRoot(root, candidate, message);
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
