export type PortalVaultTarget = {
  projectId?: string;
  workspaceId?: string;
  portalId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
};

export type PortalVaultEntry = {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'other';
  hidden?: boolean;
  size?: number;
  mtimeMs?: number;
};

export type PortalVaultNote = {
  path: string;
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

export type PortalVaultAttachment = {
  path: string;
  name: string;
  mediaType: 'image' | 'audio' | 'video' | 'pdf' | 'excalidraw' | 'other';
  size?: number;
  mtimeMs?: number;
};

export type PortalVaultIndexInput = {
  target?: PortalVaultTarget;
  path?: string;
} & PortalVaultTarget;

export type PortalVaultIndexResult = {
  path: string;
  entries: PortalVaultEntry[];
  notes: PortalVaultNote[];
  attachments: PortalVaultAttachment[];
  backlinks: Record<string, string[]>;
  checkedAt: string;
};

export type PortalVaultReadInput = {
  target?: PortalVaultTarget;
  path: string;
} & PortalVaultTarget;

export type PortalVaultFile = {
  path: string;
  content: string;
  version: string;
};

export type PortalVaultWriteInput = {
  target?: PortalVaultTarget;
  path: string;
  content: string;
  version?: string;
} & PortalVaultTarget;

export type PortalVaultWriteResult = {
  path: string;
  version: string;
};

export type PortalVaultMkdirInput = {
  target?: PortalVaultTarget;
  path: string;
} & PortalVaultTarget;

export type PortalVaultMoveInput = {
  target?: PortalVaultTarget;
  fromPath: string;
  toPath: string;
  overwrite?: boolean;
} & PortalVaultTarget;

export type PortalVaultDeleteInput = {
  target?: PortalVaultTarget;
  path: string;
  recursive?: boolean;
} & PortalVaultTarget;

export type PortalVaultUploadInput = {
  target?: PortalVaultTarget;
  path: string;
  base64Content: string;
  contentType?: string;
} & PortalVaultTarget;

export type PortalVaultOperationResult = {
  ok: true;
  path?: string;
};

export type PortalVaultHostOptions = {
  config: {
    mounts?: Array<{ projectId: string; localPath: string }>;
    roots?: Array<{ id: string; name?: string; path: string }>;
  };
  maxReadBytes?: number;
  maxIndexBytes?: number;
};

const defaultMaxReadBytes = 5 * 1024 * 1024;
const defaultMaxIndexBytes = 2 * 1024 * 1024;
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
const getParentPath = (path: string) => path.split('/').filter(Boolean).slice(0, -1).join('/');
const getBasename = (path: string) => path.split('/').filter(Boolean).pop() ?? path;
const removeExtension = (name: string) => name.replace(/\.[^.]+$/, '');

export const parseVaultPath = (value: unknown, name = 'path') => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  if (value.includes('\0')) throw new Error(`${name} cannot contain null bytes.`);

  const normalizedInput = value.trim().replace(/\\/g, '/');
  if (!normalizedInput || normalizedInput === '.') return '';
  if (normalizedInput.startsWith('/') || /^[a-zA-Z]:\//.test(normalizedInput)) {
    throw new Error(`${name} must be relative to the vault root.`);
  }

  const normalized = normalizePath(normalizedInput);
  if (normalized === '.' || normalized === '') return '';
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${name} cannot escape the vault root.`);
  }

  return normalized.replace(/^\.\//, '');
};

const getFileVersion = (details: Deno.FileInfo) => `${details.mtime?.getTime() ?? 0}:${details.size}`;
const isMarkdownPath = (path: string) => /\.(md|markdown)$/i.test(path);
const isExcalidrawPath = (path: string) => /\.excalidraw$/i.test(path);
const isTextVaultPath = (path: string) => isMarkdownPath(path) || isExcalidrawPath(path) || /\.canvas$/i.test(path) || /\.json$/i.test(path);

const decodeUtf8 = (bytes: Uint8Array) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Only UTF-8 text files can be opened in the vault editor.');
  }
};

const decodeBase64 = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));

const getRoots = (config: PortalVaultHostOptions['config']) =>
  config.roots?.length ? config.roots : [{ id: 'default', name: 'Default', path: Deno.env.get('HOME') ?? '.' }];

const flattenInput = <T extends Record<string, unknown>>(input: T) => {
  const target = isRecord(input.target) ? input.target : {};
  const { target: _target, ...rest } = input;
  return { ...rest, ...target };
};

const attachmentMediaType = (path: string): PortalVaultAttachment['mediaType'] => {
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

const parseMarkdownNote = (path: string, content: string, details: Deno.FileInfo): PortalVaultNote => {
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

const targetCandidates = (target: string) => {
  const clean = target.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  if (!clean) return [];
  const basename = removeExtension(getBasename(clean)).toLowerCase();
  const normalized = clean.toLowerCase();
  return [
    normalized,
    normalized.endsWith('.md') ? normalized : `${normalized}.md`,
    basename,
    `${basename}.md`,
  ];
};

export class PortalVaultHost {
  private readonly config: PortalVaultHostOptions['config'];
  private readonly maxReadBytes: number;
  private readonly maxIndexBytes: number;

  constructor(options: PortalVaultHostOptions) {
    this.config = options.config;
    this.maxReadBytes = options.maxReadBytes ?? defaultMaxReadBytes;
    this.maxIndexBytes = options.maxIndexBytes ?? defaultMaxIndexBytes;
  }

  async index(input: PortalVaultIndexInput): Promise<PortalVaultIndexResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseVaultPath(record.path);
    const directoryPath = await this.resolveExistingPath(root, relativePath);
    const details = await Deno.stat(directoryPath);
    if (!details.isDirectory) throw new Error('Vault path is not a directory.');

    const entries = await this.listEntries(directoryPath, relativePath);
    const notes: PortalVaultNote[] = [];
    const attachments: PortalVaultAttachment[] = [];
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

        if (isMarkdownPath(entryRelativePath) && stat.size <= this.maxIndexBytes) {
          const bytes = await Deno.readFile(entryAbsolutePath);
          notes.push(parseMarkdownNote(entryRelativePath, decodeUtf8(bytes), stat));
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

  async read(input: PortalVaultReadInput): Promise<PortalVaultFile> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseVaultPath(record.path);
    if (!relativePath) throw new Error('path is required.');
    if (!isTextVaultPath(relativePath)) throw new Error('Only text vault files can be opened here.');

    const filePath = await this.resolveExistingPath(root, relativePath);
    const details = await Deno.stat(filePath);
    if (!details.isFile) throw new Error('Vault path is not a file.');
    if (details.size > this.maxReadBytes) throw new Error('File is too large to open in the vault editor.');

    const bytes = await Deno.readFile(filePath);
    return { path: relativePath, content: decodeUtf8(bytes), version: getFileVersion(details) };
  }

  async write(input: PortalVaultWriteInput): Promise<PortalVaultWriteResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseVaultPath(record.path);
    if (!relativePath) throw new Error('path is required.');
    if (!isTextVaultPath(relativePath)) throw new Error('Only text vault files can be written here.');
    if (typeof record.content !== 'string') throw new Error('content must be a string.');
    if (record.version !== undefined && typeof record.version !== 'string') throw new Error('version must be a string.');

    const filePath = await this.resolveWritablePath(root, relativePath);
    await this.assertExpectedVersion(filePath, record.version);
    await Deno.writeTextFile(filePath, record.content);
    const nextDetails = await Deno.stat(filePath);
    return { path: relativePath, version: getFileVersion(nextDetails) };
  }

  async mkdir(input: PortalVaultMkdirInput): Promise<PortalVaultOperationResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseVaultPath(record.path);
    if (!relativePath) throw new Error('path is required.');
    const directoryPath = await this.resolveWritablePath(root, relativePath);
    await Deno.mkdir(directoryPath, { recursive: true });
    return { ok: true, path: relativePath };
  }

  async move(input: PortalVaultMoveInput): Promise<PortalVaultOperationResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const fromPath = parseVaultPath(record.fromPath, 'fromPath');
    const toPath = parseVaultPath(record.toPath, 'toPath');
    if (!fromPath || !toPath) throw new Error('fromPath and toPath are required.');
    const source = await this.resolveExistingPath(root, fromPath);
    const destination = await this.resolveWritablePath(root, toPath);
    if (record.overwrite !== true && await this.statMaybe(destination)) throw new Error('Destination already exists.');
    await Deno.rename(source, destination);
    return { ok: true, path: toPath };
  }

  async delete(input: PortalVaultDeleteInput): Promise<PortalVaultOperationResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseVaultPath(record.path);
    if (!relativePath) throw new Error('path is required.');
    const target = await this.resolveExistingPath(root, relativePath);
    await Deno.remove(target, { recursive: record.recursive === true });
    return { ok: true, path: relativePath };
  }

  async upload(input: PortalVaultUploadInput): Promise<PortalVaultOperationResult> {
    const record = flattenInput(input);
    const root = await this.resolveWorkspaceRoot(record);
    const relativePath = parseVaultPath(record.path);
    if (!relativePath) throw new Error('path is required.');
    if (typeof record.base64Content !== 'string') throw new Error('base64Content must be a string.');
    const filePath = await this.resolveWritablePath(root, relativePath);
    await Deno.writeFile(filePath, decodeBase64(record.base64Content));
    return { ok: true, path: relativePath };
  }

  private async listEntries(absolutePath: string, relativePath: string) {
    const entries: PortalVaultEntry[] = [];
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
      const target = await Deno.realPath(joinPath(rootPath, parseVaultPath(repoPath, 'repoPath')));
      this.assertWithinRoot(rootPath, target, 'Path escapes Portal root');
      return target;
    }

    throw new Error(`Vault is not mounted: ${String(input.projectId)}`);
  }

  private async resolveExistingPath(root: string, relativePath: string) {
    const normalizedPath = parseVaultPath(relativePath);
    const candidate = joinPath(root, normalizedPath);
    const resolved = await Deno.realPath(candidate);
    this.assertWithinRoot(root, resolved);
    return resolved;
  }

  private async resolveWritablePath(root: string, relativePath: string) {
    const normalizedPath = parseVaultPath(relativePath);
    const parentPath = joinPath(root, getParentPath(normalizedPath));
    await Deno.mkdir(parentPath, { recursive: true });
    const realParentPath = await Deno.realPath(parentPath);
    this.assertWithinRoot(root, realParentPath);
    const candidate = joinPath(realParentPath, getBasename(normalizedPath));
    this.assertWithinRoot(root, candidate);
    return candidate;
  }

  private async assertExpectedVersion(path: string, version: unknown) {
    if (version !== undefined && typeof version !== 'string') throw new Error('version must be a string.');
    const currentDetails = await this.statMaybe(path);
    if (!currentDetails) {
      if (version) throw new Error('File changed on disk. Reload before saving.');
      return;
    }
    if (!currentDetails.isFile) throw new Error('Vault path is not a file.');
    if (version && version !== getFileVersion(currentDetails)) throw new Error('File changed on disk. Reload before saving.');
  }

  private assertWithinRoot(root: string, candidate: string, message = 'Vault path cannot escape the vault root.') {
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
