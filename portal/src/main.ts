import { PortalEditorHost, type PortalEditorTarget } from './editor.ts';
import { PortalVaultHost } from './vault.ts';
import { isTerminalClientEnvelope, PortalTerminalHost, startTerminalControlServer } from './terminal.ts';
import {
  isWindowClientEnvelope,
  isWindowHostAvailable,
  PortalWindowHost,
  type ResolvedWindowStreamConfig,
  resolveWindowStreamConfig,
  type WindowStreamConfig,
} from './window.ts';
import {
  checkPortalRuntimeHealth,
  getPortalConfigPath,
  getPortalRuntimePath,
  maskPortalRuntime,
  maskSecret,
  type PortalRuntimeFile,
  readPortalRuntime,
  removePortalRuntime,
  resolvePortalHome,
  runtimeMatchesServer,
  writePortalRuntime,
} from './lifecycle.ts';

type PortalMount = {
  projectId: string;
  localPath: string;
};

type PortalRoot = {
  id: string;
  name: string;
  path: string;
};

type PortalConfig = {
  httpServerUrl?: string;
  wsServerUrl?: string;
  authToken?: string;
  portalId?: string;
  windowStream?: WindowStreamConfig;
  portal?: {
    portalId?: string;
    portalToken?: string;
    name?: string;
    mounts?: PortalMount[];
    roots?: PortalRoot[];
  };
};

export type ResolvedPortalConfig = {
  portalId: string;
  portalToken: string;
  httpServerUrl: string;
  wsServerUrl: string;
  name: string;
  windowStream: ResolvedWindowStreamConfig;
  mounts?: PortalMount[];
  roots?: PortalRoot[];
};

type ParsedArgs = {
  command?: string;
  flags: Record<string, string | boolean>;
};

const defaultConfigPath = getPortalConfigPath();
const defaultRuntimePath = getPortalRuntimePath();
const defaultHttpServerUrl = 'http://localhost:4111';
const defaultWsServerUrl = 'ws://localhost:4112';
const defaultName = 'Mage Portal';
const version = '0.1.0';
const requiredControlCapabilities = ['terminal', 'editor'];
const macWindowCapabilities = ['portal.window.list', 'portal.window.session'];

const getWindowCapabilities = async (windowStream: ResolvedWindowStreamConfig) =>
  await isWindowHostAvailable(undefined, windowStream) ? macWindowCapabilities : [];
const getControlCapabilities = async (windowStream: ResolvedWindowStreamConfig) => [
  ...requiredControlCapabilities,
  ...await getWindowCapabilities(windowStream),
];

const parseArgs = (args: string[]): ParsedArgs => {
  const [command, ...rest] = args;
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) continue;

    const [rawKey, rawValue] = arg.slice(2).split('=', 2);
    if (rawValue !== undefined) {
      flags[rawKey] = rawValue;
      continue;
    }

    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags[rawKey] = next;
      i += 1;
      continue;
    }

    flags[rawKey] = true;
  }

  return { command, flags };
};

const stringFlag = (flags: Record<string, string | boolean>, key: string) => {
  const value = flags[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

const numberFlag = (flags: Record<string, string | boolean>, key: string) => {
  const value = stringFlag(flags, key);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const ensureParentDir = async (path: string) => {
  const slashIndex = path.lastIndexOf('/');
  if (slashIndex <= 0) return;
  await Deno.mkdir(path.slice(0, slashIndex), { recursive: true });
};

const normalizePath = (path: string) => {
  const absolute = path.startsWith('/');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${absolute ? '/' : ''}${parts.join('/')}` || (absolute ? '/' : '.');
};

const getParentPath = (path: string) => {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex <= 0 ? '/' : path.slice(0, slashIndex);
};

const pathBasename = (path: string) => path.split('/').filter(Boolean).pop() || path;

const workspaceSlug = (value: string) => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || `workspace-${crypto.randomUUID().slice(0, 8)}`;
};

type WeaveContextScope = 'global' | 'project';

type WeaveContextFileKind = 'config' | 'mcp' | 'profile' | 'prompt' | 'skill' | 'agents';

type WeaveContextFile = {
  kind: WeaveContextFileKind;
  path: string;
  content: string;
  size: number;
  updatedAt?: string;
};

const fileMutationQueues = new Map<string, Promise<unknown>>();

const withFileMutationQueue = async <T>(path: string, task: () => Promise<T>) => {
  const previous = fileMutationQueues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  fileMutationQueues.set(path, next);
  try {
    return await next;
  } finally {
    if (fileMutationQueues.get(path) === next) fileMutationQueues.delete(path);
  }
};

const readConfig = async (path: string): Promise<PortalConfig> => {
  const content = await Deno.readTextFile(path).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return '{}';
    throw error;
  });
  return JSON.parse(content) as PortalConfig;
};

const resolvePortalConfig = (
  config: PortalConfig,
  windowStream = resolveWindowStreamConfig(config.windowStream),
): ResolvedPortalConfig => {
  const portal = config.portal ?? {};
  if (!portal.portalId || !portal.portalToken) throw new Error('Portal is not logged in. Run portal login first.');
  return {
    portalId: portal.portalId,
    portalToken: portal.portalToken,
    httpServerUrl: normalizeHttpUrl(config.httpServerUrl ?? defaultHttpServerUrl),
    wsServerUrl: normalizeWsUrl(config.wsServerUrl ?? defaultWsServerUrl),
    name: portal.name ?? defaultName,
    windowStream,
    mounts: portal.mounts,
    roots: portal.roots,
  };
};

const writeConfig = async (path: string, config: PortalConfig) => {
  await ensureParentDir(path);
  await Deno.writeTextFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
};

const toWsUrl = (server: string) => {
  const url = new URL(server);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  return url.toString().replace(/\/$/, '');
};

const normalizeHttpUrl = (server: string) => server.replace(/\/$/, '');
const normalizeWsUrl = (server: string) => toWsUrl(server).replace(/\/$/, '');

const login = async (flags: Record<string, string | boolean>) => {
  const httpServerUrl = normalizeHttpUrl(stringFlag(flags, 'server') ?? defaultHttpServerUrl);
  const wsServerUrl = normalizeWsUrl(stringFlag(flags, 'ws-server') ?? defaultWsServerUrl);
  const authToken = stringFlag(flags, 'token') ?? Deno.env.get('WEAVE_AUTH_TOKEN');
  const configPath = stringFlag(flags, 'config') ?? defaultConfigPath;
  const name = stringFlag(flags, 'name') ?? defaultName;

  if (!authToken) throw new Error('Missing auth token. Pass --token or set WEAVE_AUTH_TOKEN.');

  const response = await fetch(`${httpServerUrl}/portals/token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${authToken}` },
  });

  if (!response.ok) throw new Error(`Portal token request failed: ${response.status} ${await response.text()}`);

  const body = await response.json() as { portalId?: string; token?: string };
  if (!body.portalId || !body.token) throw new Error('Portal token response missing portalId/token.');

  const existingConfig = await readConfig(configPath);
  const config: PortalConfig = {
    ...existingConfig,
    httpServerUrl,
    wsServerUrl,
    portalId: body.portalId,
    portal: {
      ...(existingConfig.portal ?? {}),
      portalId: body.portalId,
      portalToken: body.token,
      name,
    },
  };

  await writeConfig(configPath, config);
  console.log(`Portal logged in: ${body.portalId}`);
  console.log(`Config: ${configPath}`);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getRoots = (config: Pick<ResolvedPortalConfig, 'roots'>) =>
  config.roots?.length ? config.roots : [{ id: 'default', name: 'Default', path: Deno.env.get('HOME') ?? '.' }];

const isAbsolutePath = (path: string) => path.startsWith('/');
const expandHomePath = (path: string) => {
  if (path === '~') return Deno.env.get('HOME') ?? path;
  if (path.startsWith('~/')) return `${Deno.env.get('HOME') ?? '~'}${path.slice(1)}`;
  return path;
};

const resolveRootPath = async (config: ResolvedPortalConfig, rootId: string, path = '') => {
  const root = getRoots(config).find((item) => item.id === rootId);
  if (!root) throw new Error(`Unknown root: ${rootId}`);
  const rootPath = await Deno.realPath(root.path);
  const normalizedPath = expandHomePath(path.trim());
  const target = normalizedPath
    ? await Deno.realPath(isAbsolutePath(normalizedPath) ? normalizedPath : `${rootPath}/${normalizedPath}`)
    : rootPath;
  if (target !== rootPath && !target.startsWith(`${rootPath}/`)) throw new Error('Path escapes Portal root');
  return { rootPath, target };
};

const decodeOutput = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();

const runGit = async (cwd: string, args: string[]) => {
  const command = new Deno.Command('git', { cwd, args, stdout: 'piped', stderr: 'piped' });
  const output = await command.output();
  if (!output.success) throw new Error(decodeOutput(output.stderr) || `git ${args.join(' ')} failed`);
  return decodeOutput(output.stdout);
};

const runShell = async (cwd: string, commandText: string) => {
  const command = new Deno.Command('bash', { cwd, args: ['-lc', commandText], stdout: 'piped', stderr: 'piped' });
  const output = await command.output();
  return {
    ok: output.success,
    stdout: decodeOutput(output.stdout),
    stderr: decodeOutput(output.stderr),
    exitCode: output.code,
  };
};

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const parseJsonOutput = (stdout: string, commandName: string) => {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`${commandName} returned invalid JSON`);
  }
};

const getWorktrunkStatus = async (cwd = Deno.cwd()) => {
  const result = await runShell(cwd, 'command -v wt && wt --version');
  if (!result.ok) return { ok: true, installed: false, error: 'wt is not installed or not on Portal PATH' };
  const [path = '', versionText = ''] = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  return { ok: true, installed: true, path, version: versionText.replace(/^wt\s+/, '') };
};

const assertWorktrunkInstalled = async (cwd: string) => {
  const status = await getWorktrunkStatus(cwd);
  if (!status.installed) {
    const error = new Error(
      'WT_MISSING: wt is not installed or not on Portal PATH. Install Worktrunk or add wt to PATH, then restart Portal.',
    );
    error.name = 'WT_MISSING';
    throw error;
  }
  return status;
};

const runWtJson = async (cwd: string, args: string[]) => {
  await assertWorktrunkInstalled(cwd);
  const commandText = ['wt', ...args.map(shellQuote)].join(' ');
  const result = await runShell(cwd, commandText);
  if (!result.ok) {
    const error = new Error(`WT_COMMAND_FAILED: ${result.stderr || result.stdout || commandText}`);
    error.name = 'WT_COMMAND_FAILED';
    throw error;
  }
  return parseJsonOutput(result.stdout, `wt ${args.join(' ')}`);
};

const readAgentsMd = async (root: string) => {
  const path = `${root}/AGENTS.md`;
  const info = await Deno.stat(path).catch(() => undefined);
  if (!info?.isFile || info.size > 128_000) return undefined;
  const content = await Deno.readTextFile(path);
  return {
    path: 'AGENTS.md',
    content: content.slice(0, 32_000),
    size: info.size,
    updatedAt: info.mtime?.toISOString(),
  };
};

const maxWeaveContextFileSize = 256_000;
const maxWeaveContextContentLength = 128_000;

const relativePath = (root: string, target: string) =>
  target === root ? '' : target.startsWith(`${root}/`) ? target.slice(root.length + 1) : target;

const readWeaveContextFile = async (
  absolutePath: string,
  contextPath: string,
  kind: WeaveContextFileKind,
): Promise<WeaveContextFile | undefined> => {
  const info = await Deno.stat(absolutePath).catch(() => undefined);
  if (!info?.isFile || info.size > maxWeaveContextFileSize) return undefined;
  const content = await Deno.readTextFile(absolutePath).catch(() => undefined);
  if (typeof content !== 'string') return undefined;
  return {
    kind,
    path: contextPath,
    content: content.slice(0, maxWeaveContextContentLength),
    size: info.size,
    updatedAt: info.mtime?.toISOString(),
  };
};

const listDirEntries = async (path: string) => {
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(path)) entries.push(entry);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
};

const collectTextFiles = async (
  root: string,
  contextPrefix: string,
  kind: WeaveContextFileKind,
  options: { extensions?: string[]; fileNames?: string[]; maxDepth?: number } = {},
): Promise<WeaveContextFile[]> => {
  const maxDepth = options.maxDepth ?? 6;
  const extensions = options.extensions;
  const fileNames = options.fileNames;
  const files: WeaveContextFile[] = [];

  const visit = async (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const entry of await listDirEntries(dir)) {
      const absolutePath = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile) continue;
      if (fileNames && !fileNames.includes(entry.name)) continue;
      if (extensions && !extensions.some((extension) => entry.name.endsWith(extension))) continue;

      const contextPath = `${contextPrefix}/${relativePath(root, absolutePath)}`;
      const file = await readWeaveContextFile(absolutePath, contextPath, kind);
      if (file) files.push(file);
    }
  };

  await visit(root, 0);
  return files;
};

const collectWeaveDirectory = async (
  dir: string,
  contextPrefix: string,
  options: { includeProfiles: boolean; includeConfig: boolean },
) => {
  const files: WeaveContextFile[] = [];

  if (options.includeConfig) {
    const config = await readWeaveContextFile(
      `${dir}/weave.config.json`,
      `${contextPrefix}/weave.config.json`,
      'config',
    );
    if (config) files.push(config);
  }

  const mcp = await readWeaveContextFile(`${dir}/mcp.json`, `${contextPrefix}/mcp.json`, 'mcp');
  if (mcp) files.push(mcp);

  if (options.includeProfiles) {
    files.push(
      ...await collectTextFiles(`${dir}/profiles`, `${contextPrefix}/profiles`, 'profile', {
        extensions: ['.md'],
        maxDepth: 0,
      }),
    );
  }

  files.push(
    ...await collectTextFiles(`${dir}/prompts`, `${contextPrefix}/prompts`, 'prompt', {
      extensions: ['.md'],
      maxDepth: 0,
    }),
  );
  files.push(
    ...await collectTextFiles(`${dir}/skills`, `${contextPrefix}/skills`, 'skill', {
      fileNames: ['SKILL.md'],
      maxDepth: 8,
    }),
  );

  return files;
};

const collectAgentInstructionChain = async (gitRoot: string, workspaceRoot: string) => {
  const root = await Deno.realPath(gitRoot);
  const target = await Deno.realPath(workspaceRoot);
  const chain: string[] = [root];

  if (target.startsWith(`${root}/`)) {
    let current = target;
    const parents: string[] = [];
    while (current !== root && current.startsWith(`${root}/`)) {
      parents.push(current);
      current = getParentPath(current);
    }
    chain.push(...parents.reverse());
  }

  const files: WeaveContextFile[] = [];
  for (const dir of chain) {
    const contextPath = relativePath(root, `${dir}/AGENTS.md`) || 'AGENTS.md';
    const file = await readWeaveContextFile(`${dir}/AGENTS.md`, contextPath, 'agents');
    if (file) files.push(file);
  }
  return files;
};

const inspectGit = async (path: string) => {
  const root = await runGit(path, ['rev-parse', '--show-toplevel']);
  const currentBranch = await runGit(root, ['branch', '--show-current']).catch(() => '');
  const defaultRef = await runGit(root, ['symbolic-ref', 'refs/remotes/origin/HEAD']).catch(() => '');
  const defaultBranch = defaultRef ? defaultRef.split('/').pop() : currentBranch || 'main';
  const remote = await runGit(root, ['config', '--get', 'remote.origin.url']).catch(() => undefined);
  const agentsMd = await readAgentsMd(root).catch(() => undefined);
  return { root, currentBranch, defaultBranch, remote, agentsMd };
};

const resolveWorkspaceRoot = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  if (typeof request.workspacePath === 'string' && request.workspacePath.trim()) {
    return await Deno.realPath(request.workspacePath.trim());
  }

  const mount = typeof request.projectId === 'string'
    ? (config.mounts ?? []).find((item) => item.projectId === request.projectId)
    : undefined;

  const root = mount
    ? await Deno.realPath(mount.localPath)
    : typeof request.rootId === 'string' && typeof request.repoPath === 'string'
    ? (await resolveRootPath(config, request.rootId, request.repoPath)).target
    : undefined;

  if (!root) throw new Error(`Project is not mounted: ${String(request.projectId)}`);
  return root;
};

const resolveWorkspacePath = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
  path: string,
  mustExist = true,
) => {
  const root = await resolveWorkspaceRoot(config, request);
  const candidatePath = normalizePath(path.startsWith('/') ? path : `${root}/${path}`);

  if (mustExist) {
    const candidate = await Deno.realPath(candidatePath);
    if (candidate !== root && !candidate.startsWith(`${root}/`)) throw new Error('Path escapes Project mount');
    return { root, candidate };
  }

  const parentPath = getParentPath(candidatePath);
  const realParent = await Deno.realPath(parentPath).catch(async () => {
    await Deno.mkdir(parentPath, { recursive: true });
    return await Deno.realPath(parentPath);
  });
  const candidate = normalizePath(`${realParent}/${candidatePath.slice(parentPath.length + 1)}`);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) throw new Error('Path escapes Project mount');
  return { root, candidate };
};

const pathStatTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const args = (request.args ?? {}) as Record<string, unknown>;
  const path = typeof args.path === 'string' ? expandHomePath(args.path.trim()) : '';
  if (!path) return { ok: false, error: 'path is required' };
  const rootId = typeof args.rootId === 'string' && args.rootId.trim() ? args.rootId.trim() : undefined;
  const realPath = rootId ? (await resolveRootPath(config, rootId, path)).target : await Deno.realPath(path);
  const stat = await Deno.stat(realPath);
  return { ok: true, path: realPath, isDirectory: stat.isDirectory, isFile: stat.isFile, isSymlink: stat.isSymlink };
};

const listRootTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  const rootId = typeof args?.rootId === 'string' ? args.rootId : 'default';
  const path = typeof args?.path === 'string' ? args.path : '';
  const { rootPath, target } = await resolveRootPath(config, rootId, path);
  const entries = [];
  for await (const entry of Deno.readDir(target)) {
    entries.push({
      name: entry.name,
      type: entry.isDirectory ? 'directory' : entry.isFile ? 'file' : 'other',
      hidden: entry.name.startsWith('.'),
    });
  }
  const git = await inspectGit(target).catch(() => undefined);
  const relativePath = target === rootPath ? '' : target.slice(rootPath.length + 1);
  return {
    ok: true,
    rootId,
    path: relativePath,
    realPath: target,
    entries: entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1),
    isGitRepo: Boolean(git),
    git,
  };
};

const inspectGitTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  const rootId = typeof args?.rootId === 'string' ? args.rootId : 'default';
  const path = typeof args?.path === 'string' ? args.path : '';
  const { rootPath, target } = await resolveRootPath(config, rootId, path);
  const git = await inspectGit(target);
  if (git.root !== target) throw new Error('Selected path is inside a git repo; select the repo root');
  return { ok: true, rootId, path: target === rootPath ? '' : target.slice(rootPath.length + 1), git };
};

const readAgentInstructionsTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  const rootId = typeof args?.rootId === 'string' ? args.rootId : 'default';
  const path = typeof args?.path === 'string' ? args.path : '';
  const { target } = await resolveRootPath(config, rootId, path);
  const root = await runGit(target, ['rev-parse', '--show-toplevel']);
  const agentInstructions = await readAgentsMd(root).catch(() => undefined);
  return { ok: true, agentInstructions };
};

const collectProjectWeaveDirectories = async (gitRoot: string, workspaceRoot: string) => {
  const root = await Deno.realPath(gitRoot);
  const target = await Deno.realPath(workspaceRoot);
  const chain: string[] = [root];

  if (target.startsWith(`${root}/`)) {
    let current = target;
    const parents: string[] = [];
    while (current !== root && current.startsWith(`${root}/`)) {
      parents.push(current);
      current = getParentPath(current);
    }
    chain.push(...parents.reverse());
  }

  const files: WeaveContextFile[] = [];
  for (const dir of chain) {
    const weaveDir = `${dir}/.weave`;
    const prefix = relativePath(root, weaveDir) || '.weave';
    files.push(...await collectWeaveDirectory(weaveDir, prefix, { includeProfiles: false, includeConfig: false }));
  }

  return files;
};

export const discoverGlobalWeaveContext = async () => {
  const home = Deno.env.get('HOME');
  if (!home) return { basePath: undefined, files: [] as WeaveContextFile[] };
  const basePath = normalizePath(`${home}/.config/weave`);
  const files = await collectWeaveDirectory(basePath, '.config/weave', { includeProfiles: true, includeConfig: true });
  return { basePath, files };
};

export const discoverProjectWeaveContext = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const workspaceRoot = await resolveWorkspaceRoot(config, request);
  const gitRoot = await runGit(workspaceRoot, ['rev-parse', '--show-toplevel']).catch(() => workspaceRoot);
  const [agents, weaveFiles] = await Promise.all([
    collectAgentInstructionChain(gitRoot, workspaceRoot),
    collectProjectWeaveDirectories(gitRoot, workspaceRoot),
  ]);
  return { basePath: gitRoot, workspacePath: workspaceRoot, files: [...agents, ...weaveFiles] };
};

export const discoverWeaveContextTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  const scope: WeaveContextScope = args?.scope === 'project' ? 'project' : 'global';
  const discovered = scope === 'project'
    ? await discoverProjectWeaveContext(config, request)
    : await discoverGlobalWeaveContext();
  return {
    ok: true,
    scope,
    ...discovered,
    files: discovered.files,
  };
};

const normalizeWtWorktree = (item: unknown) => {
  const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
  const commit = record.commit && typeof record.commit === 'object'
    ? record.commit as Record<string, unknown>
    : undefined;
  const worktree = record.worktree && typeof record.worktree === 'object'
    ? record.worktree as Record<string, unknown>
    : undefined;
  return {
    branch: typeof record.branch === 'string' ? record.branch : undefined,
    path: typeof record.path === 'string' ? normalizePath(record.path) : undefined,
    commit: typeof commit?.sha === 'string' ? commit.sha : undefined,
    head: typeof commit?.sha === 'string' ? commit.sha : undefined,
    shortCommit: typeof commit?.short_sha === 'string' ? commit.short_sha : undefined,
    message: typeof commit?.message === 'string' ? commit.message : undefined,
    isMain: record.is_main === true,
    isCurrent: record.is_current === true,
    detached: worktree?.detached === true,
    statusline: typeof record.statusline === 'string' ? record.statusline.replace(/\u001b\[[0-9;]*m/g, '') : undefined,
  };
};

const normalizeGitWorktree = async (path: string) => {
  const realPath = await Deno.realPath(path);
  const branch = await runGit(realPath, ['branch', '--show-current']).catch(() => '');
  const commit = await runGit(realPath, ['rev-parse', 'HEAD']).catch(() => undefined);
  return { path: realPath, branch: branch || undefined, commit, head: commit, detached: !branch };
};

const resolveNewWorkspacePath = async (root: string, args: Record<string, unknown>, label: string) => {
  const requestedPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
  const target = requestedPath
    ? normalizePath(requestedPath.startsWith('/') ? requestedPath : `${getParentPath(root)}/${requestedPath}`)
    : normalizePath(`${getParentPath(root)}/${pathBasename(root)}.${workspaceSlug(label)}`);
  const parent = getParentPath(target);
  await Deno.stat(target).then(() => {
    throw new Error(`Workspace path already exists: ${target}`);
  }).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  });
  await Deno.mkdir(parent, { recursive: true });
  return target;
};

const worktrunkStatusTool = async () => getWorktrunkStatus();

const worktrunkListTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const root = await resolveWorkspaceRoot(config, request);
  const result = await runWtJson(root, ['-C', root, 'list', '--format', 'json']);
  const worktrees = Array.isArray(result) ? result.map(normalizeWtWorktree) : [];
  return { ok: true, worktrees };
};

const worktrunkCreateTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  const branch = typeof args?.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined;
  if (!branch) throw new Error('Missing branch');
  const base = typeof args?.base === 'string' && args.base.trim() ? args.base.trim() : undefined;
  const root = await resolveWorkspaceRoot(config, request);
  const wtArgs = ['-C', root, 'switch', '--create', branch, '--format', 'json', '--no-cd', '--yes'];
  if (base) wtArgs.splice(5, 0, '--base', base);
  const result = await runWtJson(root, wtArgs);
  return { ok: true, worktree: normalizeWtWorktree(result), raw: result };
};

const gitWorktreeCreateTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined ?? {};
  const mode = args.mode === 'existingBranch' || args.mode === 'detached' ? args.mode : 'newBranch';
  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
  const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined;
  const base = typeof args.base === 'string' && args.base.trim() ? args.base.trim() : undefined;
  if (mode !== 'detached' && !branch) throw new Error('Missing branch');
  const root = await resolveWorkspaceRoot(config, request);
  const target = await resolveNewWorkspacePath(root, args, name ?? branch ?? base ?? 'detached');
  const gitArgs = mode === 'newBranch'
    ? ['worktree', 'add', '-b', branch!, target, base ?? 'HEAD']
    : mode === 'existingBranch'
    ? ['worktree', 'add', target, branch!]
    : ['worktree', 'add', '--detach', target, base ?? 'HEAD'];
  await runGit(root, gitArgs);
  return { ok: true, worktree: await normalizeGitWorktree(target) };
};

const gitWorktreeListTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const root = await resolveWorkspaceRoot(config, request);
  const stdout = await runGit(root, ['worktree', 'list', '--porcelain']);
  const records = stdout.split(/\n{2,}/).map((record) => record.trim()).filter(Boolean);
  const worktrees = records.map((record) => {
    const fields: Record<string, string | boolean> = {};
    for (const line of record.split('\n')) {
      const [key = '', ...rest] = line.split(' ');
      fields[key] = rest.length ? rest.join(' ') : true;
    }
    const branch = typeof fields.branch === 'string' ? fields.branch.replace(/^refs\/heads\//, '') : undefined;
    const path = typeof fields.worktree === 'string' ? normalizePath(fields.worktree) : undefined;
    const head = typeof fields.HEAD === 'string' ? fields.HEAD : undefined;
    return {
      path,
      branch,
      commit: head,
      head,
      detached: fields.detached === true || !branch,
      isCurrent: path === root,
    };
  });
  return { ok: true, worktrees };
};

export type GitBranchOption = {
  name: string;
  ref: string;
  kind: 'local' | 'remote';
  current?: boolean;
};

const normalizeBranchOption = (
  branch: string,
  kind: GitBranchOption['kind'],
  currentBranch: string,
  localNames: Set<string>,
): GitBranchOption | undefined => {
  if (!branch || branch.endsWith('/HEAD')) return undefined;
  if (kind === 'local') return { name: branch, ref: branch, kind, current: branch === currentBranch };
  if (!branch.includes('/')) return undefined;

  const name = branch.startsWith('origin/') ? branch.slice('origin/'.length) : branch;
  if (branch.startsWith('origin/') && localNames.has(name)) return undefined;
  return { name, ref: branch, kind };
};

export const listGitBranchesTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const root = await resolveWorkspaceRoot(config, request);
  const currentBranch = await runGit(root, ['branch', '--show-current']).catch(() => '');
  const localOutput = await runGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).catch(() => '');
  const remoteOutput = await runGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']).catch(() =>
    ''
  );
  const localNames = new Set(localOutput.split('\n').map((line) => line.trim()).filter(Boolean));
  const localBranches = [...localNames].flatMap((branch) =>
    normalizeBranchOption(branch, 'local', currentBranch, localNames) ?? []
  );
  const remoteBranches = remoteOutput.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((branch) => normalizeBranchOption(branch, 'remote', currentBranch, localNames) ?? []);
  const branches = [...localBranches, ...remoteBranches]
    .sort((a, b) => Number(b.current === true) - Number(a.current === true) || a.name.localeCompare(b.name));
  return { ok: true, branches };
};

const gitWorktreeSwitchTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined ?? {};
  const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined;
  if (!branch) throw new Error('Missing branch');
  const root = await resolveWorkspaceRoot(config, request);
  const base = typeof args.base === 'string' && args.base.trim() ? args.base.trim() : undefined;
  const gitArgs = args.create === true ? ['switch', '-c', branch, ...(base ? [base] : [])] : ['switch', branch];
  await runGit(root, gitArgs);
  return { ok: true, worktree: await normalizeGitWorktree(root) };
};

const gitWorktreeRemoveTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined ?? {};
  const target = typeof args.path === 'string' && args.path.trim()
    ? args.path.trim()
    : typeof request.workspacePath === 'string' && request.workspacePath.trim()
    ? request.workspacePath.trim()
    : undefined;
  if (!target) throw new Error('Missing path');
  const root = await resolveWorkspaceRoot(config, { ...request, workspacePath: undefined });
  const gitArgs = ['worktree', 'remove', target];
  if (args.force === true) gitArgs.push('--force');
  await runGit(root, gitArgs);
  return { ok: true };
};

const worktrunkRemoveTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  const target = typeof args?.branch === 'string' && args.branch.trim()
    ? args.branch.trim()
    : typeof args?.path === 'string' && args.path.trim()
    ? args.path.trim()
    : undefined;
  if (!target) throw new Error('Missing branch or path');
  const root = await resolveWorkspaceRoot(config, request);
  const wtArgs = ['-C', root, 'remove', target, '--foreground', '--format', 'json', '--yes'];
  if (args?.force === true) wtArgs.push('--force');
  if (args?.forceDelete === true) wtArgs.push('--force-delete');
  if (args?.deleteBranch === false) wtArgs.push('--no-delete-branch');
  const result = await runWtJson(root, wtArgs);
  return { ok: true, result };
};

const gitWorktreeValidateTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  const path = typeof args?.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
  if (!path) throw new Error('Missing path');

  const primaryRoot = await resolveWorkspaceRoot(config, request);
  const candidate = path.startsWith('/')
    ? await Deno.realPath(path)
    : (await resolveRootPath(config, typeof args?.rootId === 'string' ? args.rootId : 'default', path)).target;
  const primaryCommonDir = await runGit(primaryRoot, ['rev-parse', '--git-common-dir']);
  const candidateCommonDir = await runGit(candidate, ['rev-parse', '--git-common-dir']);
  const normalizedPrimaryCommonDir = primaryCommonDir.startsWith('/')
    ? await Deno.realPath(primaryCommonDir)
    : await Deno.realPath(`${primaryRoot}/${primaryCommonDir}`);
  const normalizedCandidateCommonDir = candidateCommonDir.startsWith('/')
    ? await Deno.realPath(candidateCommonDir)
    : await Deno.realPath(`${candidate}/${candidateCommonDir}`);
  if (normalizedPrimaryCommonDir !== normalizedCandidateCommonDir) {
    throw new Error('Selected path is not a worktree for this Project repo');
  }

  const branch = await runGit(candidate, ['branch', '--show-current']).catch(() => '');
  const commit = await runGit(candidate, ['rev-parse', 'HEAD']).catch(() => undefined);
  return {
    ok: true,
    worktree: { path: candidate, branch: branch || undefined, commit, head: commit, detached: !branch },
  };
};

const maxReadLines = 2000;
const maxReadBytes = 50 * 1024;

const truncateReadContent = (content: string, startLine: number, totalLines: number, userLimit?: number) => {
  const lines = content.split('\n');
  let selectedLines = userLimit ? lines.slice(0, userLimit) : lines;
  let truncatedByLimit = userLimit !== undefined && userLimit < lines.length;
  let bytes = 0;
  let count = 0;

  for (const line of selectedLines) {
    const lineBytes = new TextEncoder().encode(`${line}\n`).byteLength;
    if (count >= maxReadLines || bytes + lineBytes > maxReadBytes) break;
    bytes += lineBytes;
    count += 1;
  }

  if (count < selectedLines.length) truncatedByLimit = true;
  selectedLines = selectedLines.slice(0, count);
  const output = selectedLines.join('\n');
  if (!truncatedByLimit) return output;

  const nextOffset = startLine + count;
  const shownEnd = nextOffset - 1;
  if (userLimit !== undefined && count >= userLimit) {
    const remaining = totalLines - shownEnd;
    return `${output}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  }
  return `${output}\n\n[Showing lines ${startLine}-${shownEnd} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
};

const readFileTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  if (typeof request.projectId !== 'string') throw new Error('Missing projectId');
  if (typeof args?.path !== 'string') throw new Error('Missing path');

  const { candidate: filePath } = await resolveWorkspacePath(config, request, args.path);
  const content = await Deno.readTextFile(filePath);
  const lines = content.split('\n');
  const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 1;
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : undefined;
  if (offset > lines.length) throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);

  const selected = lines.slice(offset - 1).join('\n');
  return { ok: true, content: truncateReadContent(selected, offset, lines.length, limit) };
};

const writeFileTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  if (typeof request.projectId !== 'string') throw new Error('Missing projectId');
  if (typeof args?.path !== 'string') throw new Error('Missing path');
  if (typeof args?.content !== 'string') throw new Error('Missing content');

  const { candidate: filePath } = await resolveWorkspacePath(config, request, args.path, false);
  return await withFileMutationQueue(filePath, async () => {
    await ensureParentDir(filePath);
    await Deno.writeTextFile(filePath, args.content as string);
    return { ok: true, bytes: new TextEncoder().encode(args.content as string).byteLength };
  });
};

const detectLineEnding = (content: string) => content.includes('\r\n') ? '\r\n' : '\n';
const normalizeLineEndings = (content: string) => content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const restoreLineEndings = (content: string, lineEnding: string) =>
  lineEnding === '\r\n' ? content.replace(/\n/g, '\r\n') : content;
const stripBom = (content: string) =>
  content.startsWith('\uFEFF') ? { bom: '\uFEFF', text: content.slice(1) } : { bom: '', text: content };

const countOccurrences = (content: string, text: string) => {
  let count = 0;
  let index = content.indexOf(text);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(text, index + text.length);
  }
  return count;
};

const formatUnifiedRange = (startIndex: number, length: number) => {
  const startLine = length === 0 ? startIndex : startIndex + 1;
  return length === 1 ? String(startLine) : `${startLine},${length}`;
};

export const generateUnifiedDiff = (oldContent: string, newContent: string) => {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  let prefix = 0;
  while (oldLines[prefix] === newLines[prefix] && prefix < oldLines.length && prefix < newLines.length) prefix += 1;

  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const start = Math.max(0, prefix - 3);
  const endOld = Math.min(oldLines.length - 1, oldSuffix + 3);
  const endNew = Math.min(newLines.length - 1, newSuffix + 3);
  const oldRangeLength = endOld >= start ? endOld - start + 1 : 0;
  const newRangeLength = endNew >= start ? endNew - start + 1 : 0;
  const output: string[] = [];

  output.push(`@@ -${formatUnifiedRange(start, oldRangeLength)} +${formatUnifiedRange(start, newRangeLength)} @@`);
  for (let i = start; i < prefix; i += 1) {
    output.push(` ${oldLines[i]}`);
  }
  for (let i = prefix; i <= oldSuffix; i += 1) {
    output.push(`-${oldLines[i]}`);
  }
  for (let i = prefix; i <= newSuffix; i += 1) {
    output.push(`+${newLines[i]}`);
  }
  for (let i = Math.max(prefix, newSuffix + 1); i <= endNew; i += 1) {
    output.push(` ${newLines[i]}`);
  }

  return output.join('\n');
};

const editFileTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  if (typeof request.projectId !== 'string') throw new Error('Missing projectId');
  if (typeof args?.path !== 'string') throw new Error('Missing path');
  if (!Array.isArray(args?.edits) || args.edits.length === 0) throw new Error('Missing edits');
  const requestedEdits = args.edits;

  const { candidate: filePath } = await resolveWorkspacePath(config, request, args.path);
  return await withFileMutationQueue(filePath, async () => {
    const rawContent = await Deno.readTextFile(filePath);
    const { bom, text } = stripBom(rawContent);
    const lineEnding = detectLineEnding(text);
    const content = normalizeLineEndings(text);
    const matchedEdits: Array<{ index: number; length: number; newText: string; editIndex: number }> = [];

    requestedEdits.forEach((edit: unknown, editIndex: number) => {
      if (!edit || typeof edit !== 'object') throw new Error(`Invalid edits[${editIndex}]`);
      const oldText = (edit as Record<string, unknown>).oldText;
      const newText = (edit as Record<string, unknown>).newText;
      if (typeof oldText !== 'string' || typeof newText !== 'string') throw new Error(`Invalid edits[${editIndex}]`);
      if (!oldText) throw new Error(`edits[${editIndex}].oldText must not be empty`);

      const normalizedOldText = normalizeLineEndings(oldText);
      const matchIndex = content.indexOf(normalizedOldText);
      if (matchIndex === -1) {
        throw new Error(
          `Could not find edits[${editIndex}] in ${args.path}. The oldText must match exactly including all whitespace and newlines.`,
        );
      }
      const occurrences = countOccurrences(content, normalizedOldText);
      if (occurrences > 1) {
        throw new Error(
          `Found ${occurrences} occurrences of edits[${editIndex}] in ${args.path}. Each oldText must be unique.`,
        );
      }
      matchedEdits.push({
        index: matchIndex,
        length: normalizedOldText.length,
        newText: normalizeLineEndings(newText),
        editIndex,
      });
    });

    matchedEdits.sort((a, b) => a.index - b.index);
    for (let i = 1; i < matchedEdits.length; i += 1) {
      const previous = matchedEdits[i - 1];
      const current = matchedEdits[i];
      if (previous.index + previous.length > current.index) {
        throw new Error(
          `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${args.path}. Merge them into one edit or target disjoint regions.`,
        );
      }
    }

    let nextContent = content;
    for (let i = matchedEdits.length - 1; i >= 0; i -= 1) {
      const edit = matchedEdits[i];
      nextContent = `${nextContent.slice(0, edit.index)}${edit.newText}${nextContent.slice(edit.index + edit.length)}`;
    }
    if (nextContent === content) {
      throw new Error(`No changes made to ${args.path}. The replacements produced identical content.`);
    }

    await Deno.writeTextFile(filePath, bom + restoreLineEndings(nextContent, lineEnding));
    return { ok: true, replacements: matchedEdits.length, diff: generateUnifiedDiff(content, nextContent) };
  });
};

const bashTool = async (config: ResolvedPortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  if (typeof request.projectId !== 'string') throw new Error('Missing projectId');
  if (typeof args?.command !== 'string' || !args.command.trim()) throw new Error('Missing command');

  const root = await resolveWorkspaceRoot(config, request);
  const timeoutMs = typeof args.timeout === 'number' && args.timeout > 0 ? Math.floor(args.timeout * 1000) : 30_000;
  const command = new Deno.Command('bash', {
    cwd: root,
    args: ['-lc', args.command],
    stdout: 'piped',
    stderr: 'piped',
  });
  const child = command.spawn();
  const timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs);

  try {
    const output = await child.output();
    return {
      ok: output.success,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
      exitCode: output.code,
    };
  } finally {
    clearTimeout(timeout);
  }
};

const editorTargetFromRequest = (request: Record<string, unknown>): PortalEditorTarget => ({
  projectId: typeof request.projectId === 'string' ? request.projectId : undefined,
  workspaceId: typeof request.workspaceId === 'string' ? request.workspaceId : undefined,
  rootId: typeof request.rootId === 'string' ? request.rootId : undefined,
  repoPath: typeof request.repoPath === 'string' ? request.repoPath : undefined,
  workspacePath: typeof request.workspacePath === 'string' ? request.workspacePath : undefined,
});

const editorInputFromToolCall = (request: Record<string, unknown>) => {
  const args = isRecord(request.args) ? request.args : {};
  return { target: editorTargetFromRequest(request), ...args };
};

const handleToolCall = async (
  config: ResolvedPortalConfig,
  editorHost: PortalEditorHost,
  vaultHost: PortalVaultHost,
  windowHost: PortalWindowHost,
  ws: WebSocket,
  request: Record<string, unknown>,
) => {
  const id = typeof request.id === 'string' ? request.id : undefined;
  if (!id) return;

  try {
    const result = request.tool === 'read'
      ? await readFileTool(config, request)
      : request.tool === 'write'
      ? await writeFileTool(config, request)
      : request.tool === 'edit'
      ? await editFileTool(config, request)
      : request.tool === 'bash'
      ? await bashTool(config, request)
      : request.tool === 'portal.editor.list'
      ? await editorHost.list(editorInputFromToolCall(request))
      : request.tool === 'portal.editor.read'
      ? await editorHost.read(editorInputFromToolCall(request) as Parameters<PortalEditorHost['read']>[0])
      : request.tool === 'portal.editor.write'
      ? await editorHost.write(editorInputFromToolCall(request) as Parameters<PortalEditorHost['write']>[0])
      : request.tool === 'portal.editor.mkdir'
      ? await editorHost.mkdir(editorInputFromToolCall(request) as Parameters<PortalEditorHost['mkdir']>[0])
      : request.tool === 'portal.editor.move'
      ? await editorHost.move(editorInputFromToolCall(request) as Parameters<PortalEditorHost['move']>[0])
      : request.tool === 'portal.editor.delete'
      ? await editorHost.delete(editorInputFromToolCall(request) as Parameters<PortalEditorHost['delete']>[0])
      : request.tool === 'portal.vault.index'
      ? await vaultHost.index(editorInputFromToolCall(request) as Parameters<PortalVaultHost['index']>[0])
      : request.tool === 'portal.vault.read'
      ? await vaultHost.read(editorInputFromToolCall(request) as Parameters<PortalVaultHost['read']>[0])
      : request.tool === 'portal.vault.write'
      ? await vaultHost.write(editorInputFromToolCall(request) as Parameters<PortalVaultHost['write']>[0])
      : request.tool === 'portal.vault.mkdir'
      ? await vaultHost.mkdir(editorInputFromToolCall(request) as Parameters<PortalVaultHost['mkdir']>[0])
      : request.tool === 'portal.vault.move'
      ? await vaultHost.move(editorInputFromToolCall(request) as Parameters<PortalVaultHost['move']>[0])
      : request.tool === 'portal.vault.delete'
      ? await vaultHost.delete(editorInputFromToolCall(request) as Parameters<PortalVaultHost['delete']>[0])
      : request.tool === 'portal.vault.upload'
      ? await vaultHost.upload(editorInputFromToolCall(request) as Parameters<PortalVaultHost['upload']>[0])
      : request.tool === 'portal.window.list'
      ? await windowHost.list()
      : request.tool === 'portal.fs.list'
      ? await listRootTool(config, request)
      : request.tool === 'portal.fs.stat'
      ? await pathStatTool(config, request)
      : request.tool === 'portal.git.inspect'
      ? await inspectGitTool(config, request)
      : request.tool === 'portal.agentInstructions.read'
      ? await readAgentInstructionsTool(config, request)
      : request.tool === 'portal.context.discover'
      ? await discoverWeaveContextTool(config, request)
      : request.tool === 'portal.worktrunk.status'
      ? await worktrunkStatusTool()
      : request.tool === 'portal.worktrunk.list'
      ? await worktrunkListTool(config, request)
      : request.tool === 'portal.worktrunk.create'
      ? await worktrunkCreateTool(config, request)
      : request.tool === 'portal.worktrunk.remove'
      ? await worktrunkRemoveTool(config, request)
      : request.tool === 'portal.git.worktree.create'
      ? await gitWorktreeCreateTool(config, request)
      : request.tool === 'portal.git.worktree.list'
      ? await gitWorktreeListTool(config, request)
      : request.tool === 'portal.git.branches.list'
      ? await listGitBranchesTool(config, request)
      : request.tool === 'portal.git.worktree.switch'
      ? await gitWorktreeSwitchTool(config, request)
      : request.tool === 'portal.git.worktree.remove'
      ? await gitWorktreeRemoveTool(config, request)
      : request.tool === 'portal.git.worktree.validate'
      ? await gitWorktreeValidateTool(config, request)
      : undefined;
    if (!result) throw new Error(`Unsupported tool: ${String(request.tool)}`);
    ws.send(JSON.stringify({ id, type: 'tool.result', ...result }));
  } catch (error) {
    ws.send(JSON.stringify({
      id,
      type: 'tool.result',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
};

const getPortalCapabilities = async (config: ResolvedPortalConfig) => {
  const baseCapabilities = [
    'read',
    'write',
    'edit',
    'bash',
    'terminal',
    'portal.editor.list',
    'portal.editor.read',
    'portal.editor.write',
    'portal.editor.mkdir',
    'portal.editor.move',
    'portal.editor.delete',
    'portal.vault.index',
    'portal.vault.read',
    'portal.vault.write',
    'portal.vault.mkdir',
    'portal.vault.move',
    'portal.vault.delete',
    'portal.vault.upload',
    'portal.fs.list',
    'portal.fs.stat',
    'portal.git.inspect',
    'portal.agentInstructions.read',
    'portal.context.discover',
    'portal.git.worktree.validate',
    'portal.git.worktree.create',
    'portal.git.worktree.list',
    'portal.git.branches.list',
    'portal.git.worktree.switch',
    'portal.git.worktree.remove',
    'portal.worktrunk.status',
  ];
  const status = await getWorktrunkStatus().catch(() => ({ installed: false }));
  const capabilities = status.installed
    ? [...baseCapabilities, 'portal.worktrunk.list', 'portal.worktrunk.create', 'portal.worktrunk.remove']
    : baseCapabilities;
  return [...capabilities, ...await getWindowCapabilities(config.windowStream)];
};

const hasRequiredControlCapabilities = (body: unknown) => {
  const capabilities = body && typeof body === 'object'
    ? (body as { controlCapabilities?: unknown }).controlCapabilities
    : undefined;
  return Array.isArray(capabilities) &&
    requiredControlCapabilities.every((capability) => capabilities.includes(capability));
};

const shutdownRuntime = async (runtime: PortalRuntimeFile | undefined) => {
  if (!runtime?.controlHost || !runtime.controlPort || !runtime.controlToken) return;
  const url = new URL(`http://${runtime.controlHost}:${runtime.controlPort}/shutdown`);
  url.searchParams.set('token', runtime.controlToken);
  await fetch(url).catch(() => undefined);
};

const connectOnce = (
  config: ResolvedPortalConfig,
  terminalHost: PortalTerminalHost,
  editorHost: PortalEditorHost,
  vaultHost: PortalVaultHost,
  windowHost: PortalWindowHost,
  onSocket?: (ws: WebSocket) => void,
) =>
  new Promise<void>((resolve, reject) => {
    const url = new URL('/portals/connect', config.wsServerUrl);
    url.searchParams.set('portalId', config.portalId);
    url.searchParams.set('token', config.portalToken);

    const ws = new WebSocket(url);
    onSocket?.(ws);
    let accepted = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      if (heartbeat !== undefined) clearInterval(heartbeat);
    };

    ws.onopen = () => {
      console.log(`Connected socket: ${url.origin}`);
    };

    ws.onmessage = async (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      console.log('<-', JSON.stringify(message));

      if (message.type === 'portal.accepted') {
        accepted = true;
        ws.send(JSON.stringify({
          type: 'portal.hello',
          name: config.name,
          version,
          capabilities: await getPortalCapabilities(config),
          mounts: config.mounts ?? [],
          roots: getRoots(config).map((root) => ({ id: root.id, name: root.name })),
        }));
        heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'portal.pong' }));
        }, 15_000);
      }

      if (message.type === 'portal.rejected') {
        cleanup();
        reject(new Error(typeof message.error === 'string' ? message.error : 'Portal rejected'));
        ws.close();
      }

      if (isTerminalClientEnvelope(message)) {
        void terminalHost.handleClientMessage(message.clientId, message.message, (terminalEvent) => {
          ws.send(JSON.stringify({ type: 'terminal.event', clientId: message.clientId, event: terminalEvent }));
        });
        return;
      }

      if (isWindowClientEnvelope(message)) {
        void windowHost.handleClientMessage(message.clientId, message.message, (windowEvent) => {
          ws.send(JSON.stringify({ type: 'window.event', clientId: message.clientId, event: windowEvent }));
        });
        return;
      }

      if (message.type === 'tool.call') void handleToolCall(config, editorHost, vaultHost, windowHost, ws, message);
    };

    ws.onerror = () => {
      cleanup();
      if (!accepted) reject(new Error('WebSocket connection failed'));
    };

    ws.onclose = (event) => {
      cleanup();
      terminalHost.detachClientsByPrefix('relay:');
      windowHost.detachClientsByPrefix('window:');
      console.log(`Socket closed: ${event.code} ${event.reason}`.trim());
      resolve();
    };
  });

const daemon = async (flags: Record<string, string | boolean>) => {
  const configPath = stringFlag(flags, 'config') ?? defaultConfigPath;
  const runtimePath = stringFlag(flags, 'runtime') ?? defaultRuntimePath;
  const rawConfig = await readConfig(configPath);
  const windowStream = resolveWindowStreamConfig(rawConfig.windowStream, flags);
  const config = resolvePortalConfig(rawConfig, windowStream);
  config.wsServerUrl = normalizeWsUrl(stringFlag(flags, 'ws-server') ?? config.wsServerUrl);
  config.name = stringFlag(flags, 'name') ?? config.name;
  const noControl = flags['no-control'] === true;
  const existingRuntime = noControl ? undefined : await readPortalRuntime(runtimePath);

  if (existingRuntime) {
    const existingHealth = await checkPortalRuntimeHealth(existingRuntime);
    if (existingHealth.ok) {
      if (runtimeMatchesServer(existingRuntime, config.httpServerUrl, config.wsServerUrl)) {
        if (hasRequiredControlCapabilities(existingHealth.body)) {
          console.log(`Portal daemon already running: ${existingRuntime.portalId}`);
          console.log(`Runtime: ${runtimePath}`);
          return;
        }
        await shutdownRuntime(existingRuntime);
        await removePortalRuntime(runtimePath).catch(() => undefined);
      } else {
        throw new Error(
          `Portal daemon is already running for a different server. Run "portal stop" first: ${runtimePath}`,
        );
      }
    }
    await removePortalRuntime(runtimePath).catch(() => undefined);
  }

  const terminalHost = new PortalTerminalHost({ config });
  const editorHost = new PortalEditorHost({ config });
  const vaultHost = new PortalVaultHost({ config });
  const windowHost = new PortalWindowHost({ config });
  const controlToken = noControl ? undefined : stringFlag(flags, 'control-token') ?? crypto.randomUUID();
  const controlPort = noControl ? undefined : numberFlag(flags, 'control-port') ?? 0;
  const controlHost = stringFlag(flags, 'control-host') ?? '127.0.0.1';
  let activeSocket: WebSocket | undefined;
  let stopping = false;
  let runtimeInterval: ReturnType<typeof setInterval> | undefined;
  let controlServer: Deno.HttpServer<Deno.NetAddr> | undefined;
  let runtime: PortalRuntimeFile | undefined;
  const controlCapabilities = await getControlCapabilities(windowStream);

  const cleanup = async () => {
    if (runtimeInterval !== undefined) clearInterval(runtimeInterval);
    terminalHost.dispose();
    windowHost.dispose();
    activeSocket?.close();
    if (controlServer) await controlServer.shutdown().catch(() => undefined);
    await removePortalRuntime(runtimePath).catch(() => undefined);
  };

  const requestStop = () => {
    stopping = true;
    activeSocket?.close();
  };

  console.log(`Portal daemon: ${config.portalId}`);
  console.log(`WebSocket: ${config.wsServerUrl}`);
  if (controlToken && controlPort !== undefined) {
    controlServer = startTerminalControlServer({
      host: terminalHost,
      editor: editorHost,
      vault: vaultHost,
      hostname: controlHost,
      port: controlPort,
      token: controlToken,
      metadata: {
        portalId: config.portalId,
        configPath,
        httpServerUrl: config.httpServerUrl,
        wsServerUrl: config.wsServerUrl,
        runtimePath,
        controlCapabilities,
      },
      onShutdown: requestStop,
    });
    const actualControlPort = controlServer.addr.port;
    const now = new Date().toISOString();
    runtime = {
      version: 1,
      pid: Deno.pid,
      portalId: config.portalId,
      configPath,
      httpServerUrl: config.httpServerUrl,
      wsServerUrl: config.wsServerUrl,
      controlHost,
      controlPort: actualControlPort,
      controlToken,
      controlCapabilities,
      startedAt: now,
      updatedAt: now,
    };
    await writePortalRuntime(runtimePath, runtime);
    runtimeInterval = setInterval(() => {
      if (!runtime) return;
      runtime.updatedAt = new Date().toISOString();
      void writePortalRuntime(runtimePath, runtime).catch(() => undefined);
    }, 15_000);
    console.log(`Portal home: ${resolvePortalHome()}`);
    console.log(`Config: ${configPath}`);
    console.log(`Runtime: ${runtimePath}`);
    console.log(`Local control: http://${controlHost}:${actualControlPort}`);
  } else {
    console.log('Local control: disabled');
  }

  let retryMs = 1_000;
  try {
    Deno.addSignalListener('SIGINT', requestStop);
    Deno.addSignalListener('SIGTERM', requestStop);
  } catch {
    // Signal listeners are best-effort for compiled and non-POSIX runtimes.
  }

  while (!stopping) {
    try {
      await connectOnce(config, terminalHost, editorHost, vaultHost, windowHost, (ws) => {
        activeSocket = ws;
      });
      retryMs = 1_000;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }

    if (stopping) break;
    console.log(`Reconnecting in ${retryMs}ms`);
    const sleepStartedAt = Date.now();
    while (!stopping && Date.now() - sleepStartedAt < retryMs) await sleep(Math.min(250, retryMs));
    retryMs = Math.min(retryMs * 2, 30_000);
  }

  await cleanup();
};

const addRoot = async (flags: Record<string, string | boolean>) => {
  const configPath = stringFlag(flags, 'config') ?? defaultConfigPath;
  const path = stringFlag(flags, 'path');
  const name = stringFlag(flags, 'name') ?? 'Default';
  const id = stringFlag(flags, 'id') ?? 'default';
  if (!path) throw new Error('root requires --path');

  const config = await readConfig(configPath);
  const realPath = await Deno.realPath(path);
  const portal = config.portal ?? {};
  const roots = (portal.roots ?? []).filter((root) => root.id !== id);
  config.portal = { ...portal, roots: [...roots, { id, name, path: realPath }] };
  await writeConfig(configPath, config);
  console.log(`Root ${id}: ${realPath}`);
};

const mountProject = async (flags: Record<string, string | boolean>) => {
  const configPath = stringFlag(flags, 'config') ?? defaultConfigPath;
  const projectId = stringFlag(flags, 'project');
  const path = stringFlag(flags, 'path');
  if (!projectId || !path) throw new Error('mount requires --project and --path');

  const config = await readConfig(configPath);
  const realPath = await Deno.realPath(path);
  const portal = config.portal ?? {};
  const mounts = (portal.mounts ?? []).filter((mount) => mount.projectId !== projectId);
  config.portal = { ...portal, mounts: [...mounts, { projectId, localPath: realPath }] };
  await writeConfig(configPath, config);
  console.log(`Mounted ${projectId}: ${realPath}`);
};

const status = async (flags: Record<string, string | boolean>) => {
  const configPath = stringFlag(flags, 'config') ?? defaultConfigPath;
  const runtimePath = stringFlag(flags, 'runtime') ?? defaultRuntimePath;
  const config = await readConfig(configPath);
  const portal = config.portal?.portalToken
    ? { ...config.portal, portalToken: maskSecret(config.portal.portalToken) }
    : config.portal;
  const runtime = await readPortalRuntime(runtimePath);
  const runtimeHealth = await checkPortalRuntimeHealth(runtime);
  console.log(JSON.stringify(
    {
      portalHome: resolvePortalHome(),
      configPath,
      runtimePath,
      config: { ...config, authToken: maskSecret(config.authToken), portal },
      runtime: maskPortalRuntime(runtime),
      runtimeHealth,
    },
    null,
    2,
  ));
};

const stop = async (flags: Record<string, string | boolean>) => {
  const runtimePath = stringFlag(flags, 'runtime') ?? defaultRuntimePath;
  const runtime = await readPortalRuntime(runtimePath);
  if (!runtime?.controlHost || !runtime.controlPort || !runtime.controlToken) {
    console.log(`No local Portal runtime found at ${runtimePath}`);
    return;
  }

  const url = new URL(`http://${runtime.controlHost}:${runtime.controlPort}/shutdown`);
  url.searchParams.set('token', runtime.controlToken);
  try {
    const response = await fetch(url, { method: 'POST' });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    console.log(`Stopped Portal daemon: ${runtime.portalId}`);
  } catch (error) {
    console.log(
      `Portal runtime was not reachable; removing stale runtime file. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  await removePortalRuntime(runtimePath).catch(() => undefined);
};

const usage = () => {
  console.log(`mage-portal ${version}

Commands:
  login --server http://localhost:4111 --token <auth-token> [--ws-server ws://localhost:4112] [--name <name>]
  root --path /path/to/code [--id default] [--name Code] [--config ~/.config/weave/portal/config.json]
  mount --project project_x --path /path/to/repo [--config ~/.config/weave/portal/config.json]
  daemon [--config ~/.config/weave/portal/config.json] [--ws-server ws://localhost:4112] [--control-port 0] [--control-token token] [--no-control]
         [--window-stream-backend native-webrtc] [--window-stream-codec h264|hevc]
         [--window-stream-profile balanced|quality|performance|low-bandwidth|custom]
         [--window-stream-max-fps 60] [--window-stream-max-dimension 1920] [--window-stream-bitrate-mbps 20]
         [--window-stream-color-mode srgb-full-range|srgb-video-range|rec709-full-range|rec709-video-range]
  status [--config ~/.config/weave/portal/config.json]
  stop
`);
};

const main = async () => {
  const { command, flags } = parseArgs(Deno.args);

  if (command === 'login') return login(flags);
  if (!command || command === 'daemon') return daemon(flags);
  if (command === 'root') return addRoot(flags);
  if (command === 'mount') return mountProject(flags);
  if (command === 'status') return status(flags);
  if (command === 'stop') return stop(flags);

  usage();
  if (command) Deno.exit(1);
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  });
}
