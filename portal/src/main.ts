import { PortalLspHost } from './lsp.ts';
import { PortalJupyterHost } from './jupyter.ts';
import { PortalTerminalHost } from './terminal.ts';
import { PortalWorkspaceFileHost, type PortalWorkspaceFileTarget } from './workspace-files.ts';
import {
  jupyterClientMessageSchema,
  lspClientMessageSchema,
  parsePortalToolArgs,
  parsePortalToolResult,
  parseRpcRequestParams,
  parseRpcRequestResult,
  type PortalToolArgs,
  type PortalToolName,
  portalToolNames,
  portalToolNameSchema,
  type PortalToolResult,
  RpcConnection,
  rpcRequestMethods,
  type RpcRequestParams,
  terminalClientMessageSchema,
  WEAVE_RPC_PROTOCOL_VERSION,
  workspaceFileWatchClientMessageSchema,
} from '@weave/protocol';
import { logPortalPerfEvent, startPortalPerfSampler } from './perf.ts';
import { installBoundedConsoleLog } from './bounded-log.ts';
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
  tryAcquirePortalRuntimeLock,
  verifyPortalProcessInstance,
  writePortalRuntime,
} from './lifecycle.ts';
import {
  createGitWorktree,
  fetchGitUpstream,
  getGitDiff,
  getGitLog,
  getGitShow,
  getGitStatus,
  GitWorktreeRemoveDirtyError,
  inspectGit,
  inspectGitBranchCleanup,
  listGitBranches,
  listGitWorktrees,
  pullGitUpstream,
  removeGitWorktree,
  runGit,
  switchGitWorktree,
  validateGitWorktree,
} from './git.ts';
import { assertToolAllowed, normalizeExecutionProfile } from './execution-policy.ts';
import { commandSessions } from './command-sessions.ts';
import { IdempotentExecutionCache } from './idempotency.ts';
import { PortalBinaryTransfers } from './binary-transfers.ts';

const portalToolExecutions = new IdempotentExecutionCache<unknown>();

export type { GitBranchOption } from './git.ts';

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
  serverUrl?: string;
  httpServerUrl?: string;
  wsServerUrl?: string;
  authToken?: string;
  portalId?: string;
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
  serverUrl: string;
  name: string;
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
const defaultName = 'Mage Portal';
const version = '0.1.0';

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

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

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

type WeaveContextFileKind = 'config' | 'mcp' | 'prompt' | 'skill' | 'agents';

type WeaveContextFile = {
  kind: WeaveContextFileKind;
  path: string;
  content: string;
  size: number;
  updatedAt?: string;
};

const fileMutationQueues = new Map<string, Promise<unknown>>();

const withFileMutationQueue = async <T>(
  path: string,
  task: () => Promise<T>,
) => {
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

const resolvePortalConfig = (config: PortalConfig): ResolvedPortalConfig => {
  const portal = config.portal ?? {};
  if (!portal.portalId || !portal.portalToken) {
    throw new Error('Portal is not logged in. Run portal login first.');
  }
  return {
    portalId: portal.portalId,
    portalToken: portal.portalToken,
    serverUrl: normalizeHttpUrl(
      config.serverUrl ?? config.httpServerUrl ?? defaultHttpServerUrl,
    ),
    name: portal.name ?? defaultName,
    mounts: portal.mounts,
    roots: portal.roots,
  };
};

const writeConfig = async (path: string, config: PortalConfig) => {
  await ensureParentDir(path);
  const simplified: PortalConfig = {
    serverUrl: normalizeHttpUrl(
      config.serverUrl ?? config.httpServerUrl ?? defaultHttpServerUrl,
    ),
    ...(config.portal ? { portal: config.portal } : {}),
  };
  await Deno.writeTextFile(path, `${JSON.stringify(simplified, null, 2)}\n`, {
    mode: 0o600,
  });
};

const normalizeHttpUrl = (server: string) => server.replace(/\/$/, '');

const authTokenFromLegacyMap = (rawTokens: string | undefined) => {
  const raw = rawTokens?.trim();
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'WEAVE_AUTH_TOKENS must be valid JSON or replaced with WEAVE_OWNER_TOKEN.',
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'WEAVE_AUTH_TOKENS must be an object token map or replaced with WEAVE_OWNER_TOKEN.',
    );
  }

  const tokens = Object.keys(parsed).filter((token) => token.trim());
  if (tokens.length !== 1) {
    throw new Error(
      'WEAVE_AUTH_TOKENS is unsupported for multiple tokens. Set one WEAVE_OWNER_TOKEN instead.',
    );
  }

  return tokens[0];
};

const getLoginAuthToken = (flags: Record<string, string | boolean>) =>
  stringFlag(flags, 'token') ??
    Deno.env.get('WEAVE_OWNER_TOKEN')?.trim() ??
    Deno.env.get('WEAVE_AUTH_TOKEN')?.trim() ??
    authTokenFromLegacyMap(Deno.env.get('WEAVE_AUTH_TOKENS'));

const login = async (flags: Record<string, string | boolean>) => {
  const serverUrl = normalizeHttpUrl(
    stringFlag(flags, 'server') ?? defaultHttpServerUrl,
  );
  const authToken = getLoginAuthToken(flags);
  const configPath = stringFlag(flags, 'config') ?? defaultConfigPath;
  const name = stringFlag(flags, 'name') ?? defaultName;

  if (!authToken) {
    throw new Error(
      'Missing auth token. Pass --token or set WEAVE_OWNER_TOKEN.',
    );
  }

  const connection = new RpcConnection({
    serverUrl,
    reconnect: false,
    initialize: {
      protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
      role: 'client',
      token: authToken,
      capabilities: [],
      client: {
        clientAppId: 'portal-login',
        clientInstanceId: `portal-login_${crypto.randomUUID()}`,
      },
    },
  });
  const body = await connection.request('portal.token.issue')
    .finally(() => connection.close());
  if (!body.portalId || !body.token) {
    throw new Error('Portal token response missing portalId/token.');
  }

  const existingConfig = await readConfig(configPath);
  const config: PortalConfig = {
    serverUrl,
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
  if (path.startsWith('~/')) {
    return `${Deno.env.get('HOME') ?? '~'}${path.slice(1)}`;
  }
  return path;
};

const resolveRootPath = async (
  config: ResolvedPortalConfig,
  rootId: string,
  path = '',
) => {
  const root = getRoots(config).find((item) => item.id === rootId);
  if (!root) throw new Error(`Unknown root: ${rootId}`);
  const rootPath = await Deno.realPath(root.path);
  const normalizedPath = expandHomePath(path.trim());
  const target = normalizedPath
    ? await Deno.realPath(
      isAbsolutePath(normalizedPath) ? normalizedPath : `${rootPath}/${normalizedPath}`,
    )
    : rootPath;
  if (target !== rootPath && !target.startsWith(`${rootPath}/`)) {
    throw new Error('Path escapes Portal root');
  }
  return { rootPath, target };
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
      if (
        extensions &&
        !extensions.some((extension) => entry.name.endsWith(extension))
      ) continue;

      const contextPath = `${contextPrefix}/${relativePath(root, absolutePath)}`;
      const file = await readWeaveContextFile(absolutePath, contextPath, kind);
      if (file) files.push(file);
    }
  };

  await visit(root, 0);
  return files;
};

const collectSkillDirectoryFiles = async (
  root: string,
  contextPrefix: string,
): Promise<WeaveContextFile[]> => {
  const files: WeaveContextFile[] = [];
  const visit = async (dir: string, depth: number) => {
    if (depth > 8) return;
    for (const entry of await listDirEntries(dir)) {
      const absolutePath = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile) continue;
      const contextPath = `${contextPrefix}/${relativePath(root, absolutePath)}`;
      const file = await readWeaveContextFile(
        absolutePath,
        contextPath,
        'skill',
      );
      if (file) files.push(file);
    }
  };

  await visit(root, 0);
  return files;
};

const projectSkillNameFromPath = (path: string) => {
  const parts = path.split('/').filter(Boolean);
  const skillsIndex = parts.lastIndexOf('skills');
  return skillsIndex >= 0 ? parts[skillsIndex + 1] : undefined;
};

const mergeProjectSkillFiles = (
  weaveSkillFiles: WeaveContextFile[],
  agentSkillFiles: WeaveContextFile[],
) => {
  const agentSkillNames = new Set(agentSkillFiles.map((file) => projectSkillNameFromPath(file.path)).filter(Boolean));
  return [
    ...weaveSkillFiles.filter((file) => !agentSkillNames.has(projectSkillNameFromPath(file.path))),
    ...agentSkillFiles,
  ];
};

const collectWeaveDirectory = async (
  dir: string,
  contextPrefix: string,
  options: { includeConfig: boolean; includeSkills?: boolean },
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

  files.push(
    ...await collectTextFiles(
      `${dir}/prompts`,
      `${contextPrefix}/prompts`,
      'prompt',
      {
        extensions: ['.md'],
        maxDepth: 0,
      },
    ),
  );
  if (options.includeSkills !== false) {
    files.push(
      ...await collectSkillDirectoryFiles(
        `${dir}/skills`,
        `${contextPrefix}/skills`,
      ),
    );
  }

  return files;
};

const collectRootAgentInstructions = async (workspaceRoot: string) => {
  const root = await Deno.realPath(workspaceRoot);
  const gitRoot = await runGit(root, ['rev-parse', '--show-toplevel']).catch(
    () => root,
  );
  const normalizedGitRoot = normalizePath(gitRoot);
  const directories = [normalizedGitRoot];
  if (root !== normalizedGitRoot && root.startsWith(`${normalizedGitRoot}/`)) {
    let current = normalizedGitRoot;
    for (
      const segment of root.slice(normalizedGitRoot.length + 1).split('/')
        .filter(Boolean)
    ) {
      current = `${current}/${segment}`;
      directories.push(current);
    }
  } else if (root !== normalizedGitRoot) {
    directories.push(root);
  }

  const files: WeaveContextFile[] = [];
  for (const directory of directories) {
    const prefix = relativePath(normalizedGitRoot, directory);
    for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
      const contextPath = prefix ? `${prefix}/${name}` : name;
      const file = await readWeaveContextFile(
        `${directory}/${name}`,
        contextPath,
        'agents',
      );
      if (file) files.push(file);
    }
  }
  return files;
};

const resolveWorkspaceRoot = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  if (
    typeof request.workspacePath === 'string' && request.workspacePath.trim()
  ) {
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

  if (!root) {
    throw new Error(`Project is not mounted: ${String(request.projectId)}`);
  }
  return root;
};

export const resolveWorkspacePath = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
  path: string,
  mustExist = true,
) => {
  const root = await resolveWorkspaceRoot(config, request);
  const candidatePath = normalizePath(
    path.startsWith('/') ? path : `${root}/${path}`,
  );

  if (mustExist) {
    const candidate = await Deno.realPath(candidatePath);
    if (candidate !== root && !candidate.startsWith(`${root}/`)) {
      throw new Error('Path escapes Project mount');
    }
    return { root, candidate };
  }

  const parentPath = getParentPath(candidatePath);
  if (candidatePath !== root && !candidatePath.startsWith(`${root}/`)) {
    throw new Error('Path escapes Project mount');
  }
  let existingParent = parentPath;
  while (!(await Deno.stat(existingParent).catch(() => undefined))) {
    const next = getParentPath(existingParent);
    if (next === existingParent) throw new Error('Path has no existing parent');
    existingParent = next;
  }
  const realExistingParent = await Deno.realPath(existingParent);
  if (
    realExistingParent !== root && !realExistingParent.startsWith(`${root}/`)
  ) {
    throw new Error('Path escapes Project mount');
  }
  await Deno.mkdir(parentPath, { recursive: true });
  const realParent = await Deno.realPath(parentPath);
  const candidate = normalizePath(
    `${realParent}/${candidatePath.slice(parentPath.length + 1)}`,
  );
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new Error('Path escapes Project mount');
  }
  return { root, candidate };
};

const pathStatTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const args = (request.args ?? {}) as Record<string, unknown>;
  const path = typeof args.path === 'string' ? expandHomePath(args.path.trim()) : '';
  if (!path) return { ok: false, error: 'path is required' };
  const rootId = typeof args.rootId === 'string' && args.rootId.trim() ? args.rootId.trim() : undefined;
  const realPath = rootId ? (await resolveRootPath(config, rootId, path)).target : await Deno.realPath(path);
  const stat = await Deno.stat(realPath);
  return {
    ok: true,
    path: realPath,
    isDirectory: stat.isDirectory,
    isFile: stat.isFile,
    isSymlink: stat.isSymlink,
  };
};

const listRootTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
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

const inspectGitTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const args = request.args as Record<string, unknown> | undefined;
  const rootId = typeof args?.rootId === 'string' ? args.rootId : 'default';
  const path = typeof args?.path === 'string' ? args.path : '';
  const { rootPath, target } = await resolveRootPath(config, rootId, path);
  const git = await inspectGit(target);
  if (git.root !== target) {
    throw new Error('Selected path is inside a git repo; select the repo root');
  }
  return {
    ok: true,
    rootId,
    path: target === rootPath ? '' : target.slice(rootPath.length + 1),
    git,
  };
};

const readAgentInstructionsTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const args = request.args as Record<string, unknown> | undefined;
  const rootId = typeof args?.rootId === 'string' ? args.rootId : 'default';
  const path = typeof args?.path === 'string' ? args.path : '';
  const { target } = await resolveRootPath(config, rootId, path);
  const files = await collectRootAgentInstructions(target);
  const agentInstructions = files.length
    ? files.map((file) => `# ${file.path}\n\n${file.content}`).join('\n\n')
    : undefined;
  return { ok: true, agentInstructions, files };
};

const collectProjectContextFiles = async (workspaceRoot: string) => {
  const root = await Deno.realPath(workspaceRoot);
  const [weaveFiles, weaveSkillFiles, agentSkillFiles] = await Promise.all([
    collectWeaveDirectory(`${root}/.weave`, '.weave', {
      includeConfig: false,
      includeSkills: false,
    }),
    collectSkillDirectoryFiles(`${root}/.weave/skills`, '.weave/skills'),
    collectSkillDirectoryFiles(`${root}/.agents/skills`, '.agents/skills'),
  ]);
  return [...weaveFiles, ...mergeProjectSkillFiles(weaveSkillFiles, agentSkillFiles)];
};

export const discoverGlobalWeaveContext = async () => {
  const home = Deno.env.get('HOME');
  if (!home) return { basePath: undefined, files: [] as WeaveContextFile[] };
  const basePath = normalizePath(`${home}/.config/weave`);
  const files = await collectWeaveDirectory(basePath, '.config/weave', {
    includeConfig: true,
  });
  return { basePath, files };
};

export const discoverProjectWeaveContext = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const workspaceRoot = await resolveWorkspaceRoot(config, request);
  const [agents, weaveFiles] = await Promise.all([
    collectRootAgentInstructions(workspaceRoot),
    collectProjectContextFiles(workspaceRoot),
  ]);
  const files = [...agents, ...weaveFiles];
  return {
    basePath: workspaceRoot,
    workspacePath: workspaceRoot,
    files,
    diagnostics: {
      instructionFiles: agents.length,
      instructionBytes: agents.reduce(
        (total, file) => total + (file.size ?? file.content.length),
        0,
      ),
      truncatedFiles: files.filter((file) => (file.size ?? 0) > file.content.length).map((file) => file.path),
      precedence: 'git-root-to-workspace; AGENTS.override.md follows AGENTS.md at each level',
    },
  };
};

export const discoverWeaveContextTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
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

const gitWorktreeCreateTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const args = request.args as Record<string, unknown> | undefined ?? {};
  const root = await resolveWorkspaceRoot(config, request);
  return { ok: true, worktree: await createGitWorktree(root, args) };
};

const gitWorktreeListTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const root = await resolveWorkspaceRoot(config, request);
  return { ok: true, worktrees: await listGitWorktrees(root) };
};

export const listGitBranchesTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const root = await resolveWorkspaceRoot(config, request);
  return { ok: true, branches: await listGitBranches(root) };
};

const gitWorktreeSwitchTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const args = request.args as Record<string, unknown> | undefined ?? {};
  const root = await resolveWorkspaceRoot(config, request);
  return { ok: true, worktree: await switchGitWorktree(root, args) };
};

const gitWorktreeRemoveTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const args = request.args as Record<string, unknown> | undefined ?? {};
  const root = await resolveWorkspaceRoot(config, {
    ...request,
    workspacePath: undefined,
  });
  try {
    const result = await removeGitWorktree(
      root,
      args,
      typeof request.workspacePath === 'string' ? request.workspacePath : undefined,
    );
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof GitWorktreeRemoveDirtyError) {
      return { ok: false, code: error.code, error: error.message };
    }
    throw error;
  }
};

const gitWorktreeBranchCleanupTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const args = request.args as Record<string, unknown> | undefined ?? {};
  const root = await resolveWorkspaceRoot(config, {
    ...request,
    workspacePath: undefined,
  });
  const branchCleanup = await inspectGitBranchCleanup(
    root,
    args,
    typeof request.workspacePath === 'string' ? request.workspacePath : undefined,
  );
  return { ok: true, branchCleanup };
};

const gitWorktreeValidateTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const args = request.args as Record<string, unknown> | undefined;
  const path = typeof args?.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
  if (!path) throw new Error('Missing path');

  const primaryRoot = await resolveWorkspaceRoot(config, request);
  const candidate = path.startsWith('/') ? await Deno.realPath(path) : (await resolveRootPath(
    config,
    typeof args?.rootId === 'string' ? args.rootId : 'default',
    path,
  )).target;
  return {
    ok: true,
    worktree: await validateGitWorktree(primaryRoot, candidate),
  };
};

const gitStatusTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const root = await resolveWorkspaceRoot(config, request);
  return { ok: true, ...await getGitStatus(root) };
};

const gitFetchTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const root = await resolveWorkspaceRoot(config, request);
  return { ok: true, ...await fetchGitUpstream(root) };
};

const gitPullTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const root = await resolveWorkspaceRoot(config, request);
  return { ok: true, ...await pullGitUpstream(root) };
};

const gitDiffTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const root = await resolveWorkspaceRoot(config, request);
  return {
    ok: true,
    ...await getGitDiff(
      root,
      request.args as Record<string, unknown> | undefined ?? {},
    ),
  };
};

const gitLogTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const root = await resolveWorkspaceRoot(config, request);
  return {
    ok: true,
    ...await getGitLog(
      root,
      request.args as Record<string, unknown> | undefined ?? {},
    ),
  };
};

const gitShowTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const root = await resolveWorkspaceRoot(config, request);
  return {
    ok: true,
    ...await getGitShow(
      root,
      request.args as Record<string, unknown> | undefined ?? {},
    ),
  };
};

const maxReadLines = 2000;
const maxReadBytes = 50 * 1024;

const truncateReadContent = (
  content: string,
  startLine: number,
  totalLines: number,
  userLimit?: number,
) => {
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

const readFileTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const args = request.args as Record<string, unknown> | undefined;
  if (typeof request.projectId !== 'string') {
    throw new Error('Missing projectId');
  }
  if (typeof args?.path !== 'string') throw new Error('Missing path');

  const { candidate: filePath } = await resolveWorkspacePath(
    config,
    request,
    args.path,
  );
  const content = await Deno.readTextFile(filePath);
  const lines = content.split('\n');
  const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 1;
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : undefined;
  if (offset > lines.length) {
    throw new Error(
      `Offset ${offset} is beyond end of file (${lines.length} lines total)`,
    );
  }

  const selected = lines.slice(offset - 1).join('\n');
  return {
    ok: true,
    content: truncateReadContent(selected, offset, lines.length, limit),
  };
};

const writeFileTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const args = request.args as Record<string, unknown> | undefined;
  if (typeof request.projectId !== 'string') {
    throw new Error('Missing projectId');
  }
  if (typeof args?.path !== 'string') throw new Error('Missing path');
  if (typeof args?.content !== 'string') throw new Error('Missing content');

  const { candidate: filePath } = await resolveWorkspacePath(
    config,
    request,
    args.path,
    false,
  );
  return await withFileMutationQueue(filePath, async () => {
    await ensureParentDir(filePath);
    await Deno.writeTextFile(filePath, args.content as string);
    return {
      ok: true,
      bytes: new TextEncoder().encode(args.content as string).byteLength,
    };
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

type DiffOp = {
  type: 'equal' | 'delete' | 'insert';
  line: string;
  oldStart: number;
  newStart: number;
};

const unifiedDiffContextLines = 3;
const unifiedDiffSyncLookahead = 500;

const findSyncLine = (
  oldLines: string[],
  newLines: string[],
  oldIndex: number,
  newIndex: number,
) => {
  const maxOldOffset = Math.min(
    unifiedDiffSyncLookahead,
    oldLines.length - oldIndex - 1,
  );
  const maxNewOffset = Math.min(
    unifiedDiffSyncLookahead,
    newLines.length - newIndex - 1,
  );

  for (
    let distance = 1;
    distance <= maxOldOffset + maxNewOffset;
    distance += 1
  ) {
    const minOldOffset = Math.max(0, distance - maxNewOffset);
    const maxOldOffsetForDistance = Math.min(maxOldOffset, distance);
    for (
      let oldOffset = minOldOffset;
      oldOffset <= maxOldOffsetForDistance;
      oldOffset += 1
    ) {
      const newOffset = distance - oldOffset;
      if (newOffset < 0 || newOffset > maxNewOffset) continue;
      if (oldLines[oldIndex + oldOffset] === newLines[newIndex + newOffset]) {
        return {
          oldIndex: oldIndex + oldOffset,
          newIndex: newIndex + newOffset,
        };
      }
    }
  }

  return null;
};

const buildLineDiff = (oldLines: string[], newLines: string[]) => {
  const ops: DiffOp[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  const pushEqual = () => {
    ops.push({
      type: 'equal',
      line: oldLines[oldIndex],
      oldStart: oldIndex,
      newStart: newIndex,
    });
    oldIndex += 1;
    newIndex += 1;
  };

  const pushDelete = () => {
    ops.push({
      type: 'delete',
      line: oldLines[oldIndex],
      oldStart: oldIndex,
      newStart: newIndex,
    });
    oldIndex += 1;
  };

  const pushInsert = () => {
    ops.push({
      type: 'insert',
      line: newLines[newIndex],
      oldStart: oldIndex,
      newStart: newIndex,
    });
    newIndex += 1;
  };

  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex >= oldLines.length) {
      pushInsert();
      continue;
    }
    if (newIndex >= newLines.length) {
      pushDelete();
      continue;
    }
    if (oldLines[oldIndex] === newLines[newIndex]) {
      pushEqual();
      continue;
    }

    const sync = findSyncLine(oldLines, newLines, oldIndex, newIndex);
    if (!sync) {
      while (oldIndex < oldLines.length) pushDelete();
      while (newIndex < newLines.length) pushInsert();
      break;
    }

    while (oldIndex < sync.oldIndex) pushDelete();
    while (newIndex < sync.newIndex) pushInsert();
  }

  return ops;
};

const formatUnifiedHunk = (ops: DiffOp[]) => {
  const oldRangeLength = ops.filter((op) => op.type !== 'insert').length;
  const newRangeLength = ops.filter((op) => op.type !== 'delete').length;
  const output = [
    `@@ -${formatUnifiedRange(ops[0].oldStart, oldRangeLength)} +${
      formatUnifiedRange(ops[0].newStart, newRangeLength)
    } @@`,
  ];

  ops.forEach((op) => {
    const prefix = op.type === 'insert' ? '+' : op.type === 'delete' ? '-' : ' ';
    output.push(`${prefix}${op.line}`);
  });

  return output.join('\n');
};

export const generateUnifiedDiff = (oldContent: string, newContent: string) => {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const ops = buildLineDiff(oldLines, newLines);
  const changeIndexes = ops.flatMap((op, index) => op.type === 'equal' ? [] : [index]);
  const hunks: string[] = [];
  let changeCursor = 0;

  while (changeCursor < changeIndexes.length) {
    let start = Math.max(
      0,
      changeIndexes[changeCursor] - unifiedDiffContextLines,
    );
    let end = Math.min(
      ops.length - 1,
      changeIndexes[changeCursor] + unifiedDiffContextLines,
    );
    changeCursor += 1;

    while (
      changeCursor < changeIndexes.length &&
      changeIndexes[changeCursor] <= end + unifiedDiffContextLines
    ) {
      end = Math.min(
        ops.length - 1,
        changeIndexes[changeCursor] + unifiedDiffContextLines,
      );
      changeCursor += 1;
    }

    hunks.push(formatUnifiedHunk(ops.slice(start, end + 1)));
  }

  return hunks.join('\n');
};

const editFileTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const args = request.args as Record<string, unknown> | undefined;
  if (typeof request.projectId !== 'string') {
    throw new Error('Missing projectId');
  }
  if (typeof args?.path !== 'string') throw new Error('Missing path');
  if (!Array.isArray(args?.edits) || args.edits.length === 0) {
    throw new Error('Missing edits');
  }
  const requestedEdits = args.edits;

  const { candidate: filePath } = await resolveWorkspacePath(
    config,
    request,
    args.path,
  );
  return await withFileMutationQueue(filePath, async () => {
    const rawContent = await Deno.readTextFile(filePath);
    const { bom, text } = stripBom(rawContent);
    const lineEnding = detectLineEnding(text);
    const content = normalizeLineEndings(text);
    const matchedEdits: Array<
      { index: number; length: number; newText: string; editIndex: number }
    > = [];

    requestedEdits.forEach((edit: unknown, editIndex: number) => {
      if (!edit || typeof edit !== 'object') {
        throw new Error(`Invalid edits[${editIndex}]`);
      }
      const oldText = (edit as Record<string, unknown>).oldText;
      const newText = (edit as Record<string, unknown>).newText;
      if (typeof oldText !== 'string' || typeof newText !== 'string') {
        throw new Error(`Invalid edits[${editIndex}]`);
      }
      if (!oldText) {
        throw new Error(`edits[${editIndex}].oldText must not be empty`);
      }

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
      throw new Error(
        `No changes made to ${args.path}. The replacements produced identical content.`,
      );
    }

    await Deno.writeTextFile(
      filePath,
      bom + restoreLineEndings(nextContent, lineEnding),
    );
    return {
      ok: true,
      replacements: matchedEdits.length,
      diff: generateUnifiedDiff(content, nextContent),
    };
  });
};

const bashTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
) => {
  const args = request.args as Record<string, unknown> | undefined;
  if (typeof request.projectId !== 'string') {
    throw new Error('Missing projectId');
  }
  if (typeof args?.command !== 'string' || !args.command.trim()) {
    throw new Error('Missing command');
  }

  const root = await resolveWorkspaceRoot(config, request);
  const profile = normalizeExecutionProfile(request.executionProfile);
  const timeoutMs = typeof args.timeout === 'number' && args.timeout > 0 ? Math.floor(args.timeout * 1000) : 30_000;
  const started = await commandSessions.start({
    workspaceRoot: root,
    cwd: root,
    command: args.command,
    profile,
    timeoutMs,
    yieldMs: 0,
    validation: args.validation === 'test' || args.validation === 'typecheck' ||
        args.validation === 'lint' ||
        args.validation === 'build' || args.validation === 'other'
      ? args.validation
      : undefined,
  });
  const output = started.status === 'running' ? await commandSessions.wait(root, started.id) : started;
  return {
    ok: output.status === 'completed',
    stdout: output.events.filter((event) => event.stream === 'stdout').map((
      event,
    ) => event.text).join(''),
    stderr: output.events.filter((event) => event.stream !== 'stdout').map((
      event,
    ) => event.text).join(''),
    exitCode: output.exitCode,
    timedOut: output.timedOut,
    sandboxed: output.sandboxed,
    network: output.network,
    artifactHandle: output.artifactHandle,
    omittedRanges: output.omittedRanges,
    nextOffset: output.nextOffset,
    outputChars: output.outputChars,
    outputBytes: output.outputBytes,
    outputLines: output.outputLines,
    ...(output.validation ? { validation: output.validation } : {}),
    ...(output.timedOut ? { error: `Command timed out after ${timeoutMs}ms` } : {}),
  };
};

const commandSessionTool = async (
  config: ResolvedPortalConfig,
  request: Record<string, unknown>,
  action: 'start' | 'poll' | 'write' | 'stop',
) => {
  const args = isRecord(request.args) ? request.args : {};
  const root = await resolveWorkspaceRoot(config, request);
  if (action === 'start') {
    if (typeof args.command !== 'string' || !args.command.trim()) {
      throw new Error('command is required');
    }
    const cwd = typeof args.cwd === 'string' && args.cwd.trim()
      ? (await resolveWorkspacePath(config, request, args.cwd.trim())).candidate
      : root;
    return {
      ok: true,
      ...await commandSessions.start({
        workspaceRoot: root,
        cwd,
        command: args.command,
        profile: normalizeExecutionProfile(request.executionProfile),
        timeoutMs: typeof args.timeout === 'number' && args.timeout > 0 ? Math.floor(args.timeout * 1000) : undefined,
        yieldMs: typeof args.yieldMs === 'number' && args.yieldMs >= 0 ? Math.floor(args.yieldMs) : undefined,
        pty: args.pty === true,
        validation: args.validation === 'test' || args.validation === 'typecheck' ||
            args.validation === 'lint' ||
            args.validation === 'build' || args.validation === 'other'
          ? args.validation
          : undefined,
      }),
    };
  }
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
  if (!sessionId) throw new Error('sessionId is required');
  if (action === 'poll') {
    return {
      ok: true,
      ...await commandSessions.poll(
        root,
        sessionId,
        typeof args.afterOffset === 'number' ? args.afterOffset : undefined,
        typeof args.limit === 'number' ? args.limit : undefined,
      ),
    };
  }
  if (action === 'write') {
    return {
      ok: true,
      ...await commandSessions.write(
        root,
        sessionId,
        typeof args.data === 'string' ? args.data : '',
        args.close === true,
      ),
    };
  }
  return { ok: true, ...commandSessions.stop(root, sessionId) };
};

export const workspaceFileTargetFromRequest = (
  value: unknown,
): PortalWorkspaceFileTarget => {
  const request = isRecord(value) ? value : {};
  return ({
    projectId: typeof request.projectId === 'string' ? request.projectId : undefined,
    workspaceId: typeof request.workspaceId === 'string' ? request.workspaceId : undefined,
    rootId: typeof request.rootId === 'string' ? request.rootId : undefined,
    repoPath: typeof request.repoPath === 'string' ? request.repoPath : undefined,
    workspacePath: typeof request.workspacePath === 'string' ? request.workspacePath : undefined,
  });
};

const executePortalToolCall = async (
  config: ResolvedPortalConfig,
  workspaceFileHost: PortalWorkspaceFileHost,
  lspHost: PortalLspHost,
  jupyterHost: PortalJupyterHost,
  requestInput: unknown,
) => {
  try {
    const request = parseRpcRequestParams(
      'server',
      'portal',
      'portal.tool.call',
      requestInput,
    );
    const tool = portalToolNameSchema.parse(request.tool);
    parsePortalToolArgs(tool, request.args);
    const executionProfile = normalizeExecutionProfile(
      request.executionProfile,
    );
    assertToolAllowed(tool, executionProfile);
    const idempotencyKey = typeof request.idempotencyKey === 'string' &&
        request.idempotencyKey.length <= 512
      ? request.idempotencyKey
      : undefined;
    const portalHandler = <Name extends PortalToolName>(
      name: Name,
      handler: (args: PortalToolArgs<Name>) => Promise<unknown>,
    ) =>
    async () =>
      parsePortalToolResult(
        name,
        await handler(parsePortalToolArgs(name, request.args)),
      );
    const withArgs = <Args extends Record<string, unknown>>(
      args: Args,
    ): Record<string, unknown> => ({
      ...request,
      tool,
      args,
    });
    const target = workspaceFileTargetFromRequest(request);
    const workspaceInput = <Args extends Record<string, unknown>>(
      args: Args,
    ) => ({ target, ...target, ...args });
    const handlers: {
      [Name in PortalToolName]: () => Promise<PortalToolResult<Name>>;
    } = {
      read: portalHandler(
        'read',
        (args) => readFileTool(config, withArgs(args)),
      ),
      write: portalHandler(
        'write',
        (args) => writeFileTool(config, withArgs(args)),
      ),
      edit: portalHandler(
        'edit',
        (args) => editFileTool(config, withArgs(args)),
      ),
      bash: portalHandler('bash', (args) => bashTool(config, withArgs(args))),
      exec_start: portalHandler(
        'exec_start',
        (args) => commandSessionTool(config, withArgs(args), 'start'),
      ),
      exec_poll: portalHandler(
        'exec_poll',
        (args) => commandSessionTool(config, withArgs(args), 'poll'),
      ),
      exec_write: portalHandler(
        'exec_write',
        (args) => commandSessionTool(config, withArgs(args), 'write'),
      ),
      exec_stop: portalHandler(
        'exec_stop',
        (args) => commandSessionTool(config, withArgs(args), 'stop'),
      ),
      'portal.context.discover': portalHandler(
        'portal.context.discover',
        (args) => discoverWeaveContextTool(config, withArgs(args)),
      ),
      'portal.git.status': portalHandler(
        'portal.git.status',
        (args) => gitStatusTool(config, withArgs(args)),
      ),
      'portal.git.diff': portalHandler(
        'portal.git.diff',
        (args) => gitDiffTool(config, withArgs(args)),
      ),
      'portal.git.log': portalHandler(
        'portal.git.log',
        (args) => gitLogTool(config, withArgs(args)),
      ),
      'portal.git.show': portalHandler(
        'portal.git.show',
        (args) => gitShowTool(config, withArgs(args)),
      ),
      'portal.git.fetch': portalHandler(
        'portal.git.fetch',
        (args) => gitFetchTool(config, withArgs(args)),
      ),
      'portal.git.pull': portalHandler(
        'portal.git.pull',
        (args) => gitPullTool(config, withArgs(args)),
      ),
      'portal.fs.list': portalHandler(
        'portal.fs.list',
        (args) => workspaceFileHost.list(workspaceInput(args)),
      ),
      'portal.fs.read': portalHandler(
        'portal.fs.read',
        (args) => workspaceFileHost.read(workspaceInput(args)),
      ),
      'portal.fs.hash': portalHandler(
        'portal.fs.hash',
        (args) => workspaceFileHost.hash(workspaceInput(args)),
      ),
      'portal.fs.diffPreview': portalHandler(
        'portal.fs.diffPreview',
        (args) => workspaceFileHost.diffPreview(workspaceInput(args)),
      ),
      'portal.fs.write': portalHandler(
        'portal.fs.write',
        (args) => workspaceFileHost.write(workspaceInput(args)),
      ),
      'portal.fs.mkdir': portalHandler(
        'portal.fs.mkdir',
        (args) => workspaceFileHost.mkdir(workspaceInput(args)),
      ),
      'portal.fs.move': portalHandler(
        'portal.fs.move',
        (args) => workspaceFileHost.move(workspaceInput(args)),
      ),
      'portal.fs.delete': portalHandler(
        'portal.fs.delete',
        (args) => workspaceFileHost.delete(workspaceInput(args)),
      ),
      'portal.fs.index': portalHandler(
        'portal.fs.index',
        (args) => workspaceFileHost.index(workspaceInput(args)),
      ),
      'portal.fs.upload': portalHandler(
        'portal.fs.upload',
        (args) => workspaceFileHost.upload(workspaceInput(args)),
      ),
      'portal.lsp.session': portalHandler(
        'portal.lsp.session',
        (args) => lspHost.createSession(workspaceInput(args)),
      ),
      'portal.lsp.query': portalHandler(
        'portal.lsp.query',
        (args) => lspHost.query(workspaceInput(args)),
      ),
      'portal.jupyter.status': portalHandler(
        'portal.jupyter.status',
        (args) => jupyterHost.status(workspaceInput(args)),
      ),
      'portal.jupyter.kernelspecs': portalHandler(
        'portal.jupyter.kernelspecs',
        (args) => jupyterHost.kernelspecs(workspaceInput(args)),
      ),
      'portal.jupyter.session': portalHandler(
        'portal.jupyter.session',
        (args) => jupyterHost.createSession(workspaceInput(args)),
      ),
      'portal.fs.browse': portalHandler(
        'portal.fs.browse',
        (args) => listRootTool(config, withArgs(args)),
      ),
      'portal.fs.pathStat': portalHandler(
        'portal.fs.pathStat',
        (args) => pathStatTool(config, withArgs(args)),
      ),
      'portal.git.inspect': portalHandler(
        'portal.git.inspect',
        (args) => inspectGitTool(config, withArgs(args)),
      ),
      'portal.agentInstructions.read': portalHandler(
        'portal.agentInstructions.read',
        (args) => readAgentInstructionsTool(config, withArgs(args)),
      ),
      'portal.git.worktree.create': portalHandler(
        'portal.git.worktree.create',
        (args) => gitWorktreeCreateTool(config, withArgs(args)),
      ),
      'portal.git.worktree.list': portalHandler(
        'portal.git.worktree.list',
        (args) => gitWorktreeListTool(config, withArgs(args)),
      ),
      'portal.git.branches.list': portalHandler(
        'portal.git.branches.list',
        (args) => listGitBranchesTool(config, withArgs(args)),
      ),
      'portal.git.worktree.switch': portalHandler(
        'portal.git.worktree.switch',
        (args) => gitWorktreeSwitchTool(config, withArgs(args)),
      ),
      'portal.git.worktree.remove': portalHandler(
        'portal.git.worktree.remove',
        (args) => gitWorktreeRemoveTool(config, withArgs(args)),
      ),
      'portal.git.worktree.branch-cleanup': portalHandler(
        'portal.git.worktree.branch-cleanup',
        (args) => gitWorktreeBranchCleanupTool(config, withArgs(args)),
      ),
      'portal.git.worktree.validate': portalHandler(
        'portal.git.worktree.validate',
        (args) => gitWorktreeValidateTool(config, withArgs(args)),
      ),
    };
    const result = await portalToolExecutions.execute(
      idempotencyKey,
      handlers[tool],
    );
    return parsePortalToolResult(tool, result);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const getPortalCapabilities = async (_config: ResolvedPortalConfig) => [
  ...new Set([...portalToolNames, ...rpcRequestMethods('server', 'portal')]),
];

type PortalRemoteConnectionUpdate = {
  state: 'connecting' | 'connected' | 'reconnecting' | 'rejected';
  error?: string;
  connectedAt?: string;
};

const rpcClientInput = (params: unknown) => {
  const input = isRecord(params) ? params : {};
  const clientId = optionalString(input.clientId);
  if (!clientId) throw new Error('clientId is required.');
  return { clientId, input };
};

const connectOnce = async (
  config: ResolvedPortalConfig,
  instanceId: string,
  terminalHost: PortalTerminalHost,
  workspaceFileHost: PortalWorkspaceFileHost,
  lspHost: PortalLspHost,
  jupyterHost: PortalJupyterHost,
  onConnection?: (connection: RpcConnection<'portal'>) => void,
  onConnectionUpdate?: (update: PortalRemoteConnectionUpdate) => void,
) => {
  const binaryTransfers = new PortalBinaryTransfers();
  const capabilities = await getPortalCapabilities(config);
  const connection = new RpcConnection<'portal'>({
    serverUrl: config.serverUrl,
    reconnect: false,
    initialize: {
      protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
      role: 'portal',
      token: config.portalToken,
      capabilities,
      portal: {
        portalId: config.portalId,
        name: config.name,
        version,
        instanceId,
        mounts: config.mounts ?? [],
        roots: getRoots(config).map((root) => ({
          id: root.id,
          name: root.name,
          path: root.path,
        })),
      },
    },
  });
  onConnection?.(connection);

  connection.register(
    'portal.tool.call',
    (params) =>
      executePortalToolCall(
        config,
        workspaceFileHost,
        lspHost,
        jupyterHost,
        isRecord(params) ? params : {},
      ),
  );
  connection.register(
    'binary.begin',
    (params) => binaryTransfers.begin(params),
  );
  connection.register(
    'binary.chunk',
    (params) => binaryTransfers.chunk(params),
  );
  connection.register('binary.ack', () => ({ ok: true }));
  connection.register(
    'binary.complete',
    (params) => binaryTransfers.complete(params),
  );
  connection.register(
    'binary.abort',
    (params) => binaryTransfers.abort(params),
  );
  for (
    const action of [
      'list',
      'read',
      'hash',
      'diffPreview',
      'write',
      'mkdir',
      'move',
      'delete',
      'index',
      'upload',
    ] as const
  ) {
    connection.register(`portal.workspaceFile.${action}`, async (params) => {
      const portalMethod = `portal.workspaceFile.${action}` as const;
      const request = parseRpcRequestParams(
        'server',
        'portal',
        portalMethod,
        params,
      );
      const target = request.target;
      const toolTarget = workspaceFileTargetFromRequest(target);
      const args: Record<string, unknown> = { ...request.args };
      if (action === 'upload' || action === 'write') {
        const transferId = optionalString(args.transferId);
        if (!transferId) throw new Error('transferId is required.');
        const bytes = binaryTransfers.consume(
          transferId,
          `workspaceFile.${action}`,
        );
        if (action === 'upload') {
          args.base64Content = binaryTransfers.toBase64(bytes);
        } else {args.content = new TextDecoder('utf-8', { fatal: true }).decode(
            bytes,
          );}
        delete args.transferId;
      }
      const result = await executePortalToolCall(
        config,
        workspaceFileHost,
        lspHost,
        jupyterHost,
        {
          ...toolTarget,
          tool: action === 'diffPreview' ? 'portal.fs.diffPreview' : `portal.fs.${action}`,
          args,
        },
      );
      if ('ok' in result && result.ok === false) {
        throw new Error(
          optionalString(result.error) ??
            `Portal workspace file ${action} failed.`,
        );
      }
      if (
        action !== 'read' || !('content' in result) ||
        typeof result.content !== 'string'
      ) return parseRpcRequestResult('server', 'portal', portalMethod, result);
      const transfer = await binaryTransfers.createDownload(
        new TextEncoder().encode(result.content),
        'workspaceFile.read',
        'text/plain; charset=utf-8',
      );
      const { content: _content, ...metadata } = result;
      return parseRpcRequestResult('server', 'portal', portalMethod, {
        ...metadata,
        contentTransfer: transfer,
      });
    });
  }
  const terminalActions = {
    snapshot: 'snapshot',
    list: 'list',
    create: 'create',
    attach: 'start',
    input: 'input',
    resize: 'resize',
    close: 'close',
    detach: 'detach',
  } as const;
  for (
    const [action, type] of Object.entries(terminalActions) as Array<
      [
        keyof typeof terminalActions,
        (typeof terminalActions)[keyof typeof terminalActions],
      ]
    >
  ) {
    connection.register(`portal.terminal.${action}`, async (params) => {
      const { clientId, input } = rpcClientInput(params);
      const message = terminalClientMessageSchema.parse(
        action === 'snapshot' ? { type, requestId: input.requestId } : action === 'list' || action === 'create'
          ? {
            type,
            requestId: input.requestId,
            kind: input.kind,
            terminalId: input.terminalId,
            projectId: input.projectId,
            workspaceId: input.workspaceId,
            portalId: input.portalId,
            rootId: input.rootId,
            repoPath: input.repoPath,
            workspacePath: input.workspacePath,
            cwd: input.cwd,
            cols: input.cols,
            rows: input.rows,
          }
          : action === 'attach'
          ? {
            type,
            kind: input.kind,
            terminalId: input.terminalId,
            projectId: input.projectId,
            workspaceId: input.workspaceId,
            portalId: input.portalId,
            rootId: input.rootId,
            repoPath: input.repoPath,
            workspacePath: input.workspacePath,
            cwd: input.cwd,
            cols: input.cols,
            rows: input.rows,
          }
          : action === 'input'
          ? { type, terminalId: input.terminalId, data: input.data }
          : action === 'resize'
          ? {
            type,
            terminalId: input.terminalId,
            cols: input.cols,
            rows: input.rows,
          }
          : { type, terminalId: input.terminalId },
      );
      await terminalHost.handleClientMessage(
        `rpc:${clientId}`,
        message,
        (event) => {
          connection.notify('portal.terminal.event', { clientId, event }, 2);
        },
      );
      return { ok: true };
    });
  }
  const watchActions = {
    start: 'watch.start',
    update: 'watch.update',
    stop: 'watch.stop',
  } as const;
  for (
    const [action, type] of Object.entries(watchActions) as Array<
      [
        keyof typeof watchActions,
        (typeof watchActions)[keyof typeof watchActions],
      ]
    >
  ) {
    connection.register(
      `portal.workspaceFile.watch.${action}`,
      async (params) => {
        const { clientId, input } = rpcClientInput(params);
        const message = workspaceFileWatchClientMessageSchema.parse(
          action === 'start'
            ? {
              type,
              requestId: input.requestId,
              target: input.target,
              paths: input.paths,
            }
            : action === 'update'
            ? { type, requestId: input.requestId, paths: input.paths }
            : { type, requestId: input.requestId },
        );
        await workspaceFileHost.handleClientMessage(
          `rpc:${clientId}`,
          message,
          (event) =>
            connection.notify('portal.workspaceFile.watch.event', {
              clientId,
              event,
            }, 3),
        );
        return { ok: true };
      },
    );
  }
  const lspActions = {
    start: 'start',
    send: 'jsonrpc',
    close: 'detach',
  } as const;
  for (
    const [action, type] of Object.entries(lspActions) as Array<
      [keyof typeof lspActions, (typeof lspActions)[keyof typeof lspActions]]
    >
  ) {
    connection.register(`portal.lsp.${action}`, async (params) => {
      const { clientId, input } = rpcClientInput(params);
      const message = lspClientMessageSchema.parse(
        action === 'start'
          ? {
            type,
            sessionId: input.sessionId,
            target: input.target,
            path: input.path,
            languageId: input.languageId,
            serverId: input.serverId,
          }
          : action === 'send'
          ? { type, sessionId: input.sessionId, message: input.message }
          : { type, sessionId: input.sessionId },
      );
      await lspHost.handleClientMessage(
        `rpc:${clientId}`,
        message,
        (event) => {
          connection.notify('portal.lsp.event', { clientId, event }, 2);
        },
      );
      return { ok: true };
    });
  }
  const jupyterActions = { execute: 'execute', close: 'detach' } as const;
  for (
    const [action, type] of Object.entries(jupyterActions) as Array<
      [
        keyof typeof jupyterActions,
        (typeof jupyterActions)[keyof typeof jupyterActions],
      ]
    >
  ) {
    connection.register(`portal.jupyter.${action}`, async (params) => {
      const { clientId, input } = rpcClientInput(params);
      const message = jupyterClientMessageSchema.parse(
        action === 'execute'
          ? {
            type,
            sessionId: input.sessionId,
            requestId: input.requestId,
            cellId: input.cellId,
            code: input.code,
            silent: input.silent,
            storeHistory: input.storeHistory,
            allowStdin: input.allowStdin,
          }
          : { type, sessionId: input.sessionId },
      );
      await jupyterHost.handleClientMessage(
        `rpc:${clientId}`,
        message,
        (event) => {
          connection.notify('portal.jupyter.event', { clientId, event }, 2);
        },
      );
      return { ok: true };
    });
  }

  let stopRequested = false;
  connection.register('portal.shutdown', () => {
    stopRequested = true;
    setTimeout(() => connection.close('Portal shutdown requested.'), 25);
    return { ok: true };
  });

  onConnectionUpdate?.({ state: 'connecting' });
  try {
    await connection.connect();
    const connectedAt = new Date().toISOString();
    onConnectionUpdate?.({ state: 'connected', connectedAt });
    logPortalPerfEvent('rpc_connected', { serverUrl: config.serverUrl });
    await new Promise<void>((resolve) => {
      const detach = connection.onState((state) => {
        if (state !== 'idle' && state !== 'closed') return;
        detach();
        resolve();
      });
    });
  } finally {
    binaryTransfers.clear();
    terminalHost.detachClientsByPrefix('rpc:');
    workspaceFileHost.detachClientsByPrefix('rpc:');
    lspHost.detachClientsByPrefix('rpc:');
    jupyterHost.detachClientsByPrefix('rpc:');
    connection.close();
  }
  return { stopRequested };
};

const daemon = async (flags: Record<string, string | boolean>) => {
  const configPath = stringFlag(flags, 'config') ?? defaultConfigPath;
  const runtimePath = stringFlag(flags, 'runtime') ?? defaultRuntimePath;
  const config = resolvePortalConfig(await readConfig(configPath));
  config.serverUrl = normalizeHttpUrl(
    stringFlag(flags, 'server') ?? config.serverUrl,
  );
  config.name = stringFlag(flags, 'name') ?? config.name;
  const instanceId = stringFlag(flags, 'instance-id') ?? crypto.randomUUID();
  const runtimeLock = await tryAcquirePortalRuntimeLock(runtimePath);
  if (!runtimeLock) {
    const existing = await readPortalRuntime(runtimePath);
    const health = await checkPortalRuntimeHealth(existing);
    if (existing && health.ok && existing.serverUrl === config.serverUrl) {
      console.log(`Portal daemon already running: ${existing.portalId}`);
      return;
    }
    throw new Error(`Portal runtime is locked: ${runtimePath}.lock`);
  }

  const terminalHost = new PortalTerminalHost({ config });
  const workspaceFileHost = new PortalWorkspaceFileHost({ config });
  const lspHost = new PortalLspHost({ config });
  const jupyterHost = new PortalJupyterHost({ config });
  const startedAt = new Date().toISOString();
  let stopping = false;
  let activeConnection: RpcConnection<'portal'> | undefined;
  let connectionState: PortalRuntimeFile['connectionState'] = 'connecting';
  let connectedAt: string | undefined;
  let connectionError: string | undefined;
  let retryMs = 1_000;
  let runtimeWritePromise = Promise.resolve();

  const writeHeartbeat = () => {
    const runtime: PortalRuntimeFile = {
      version: 2,
      pid: Deno.pid,
      instanceId,
      portalId: config.portalId,
      configPath,
      serverUrl: config.serverUrl,
      connectionState,
      ...(connectedAt ? { connectedAt } : {}),
      ...(connectionError ? { error: connectionError } : {}),
      startedAt,
      updatedAt: new Date().toISOString(),
    };
    runtimeWritePromise = runtimeWritePromise.then(() => writePortalRuntime(runtimePath, runtime));
    return runtime;
  };
  let runtime = writeHeartbeat();
  await runtimeWritePromise;
  const runtimeInterval = setInterval(() => {
    runtime = writeHeartbeat();
  }, 5_000);

  const requestStop = () => {
    stopping = true;
    activeConnection?.close('Portal stopping.');
  };
  try {
    Deno.addSignalListener('SIGINT', requestStop);
    Deno.addSignalListener('SIGTERM', requestStop);
  } catch {
    // Signal listeners are best-effort on non-POSIX systems.
  }

  const perfSampler = startPortalPerfSampler({
    sample: () => ({
      portal: {
        portalId: config.portalId,
        instanceId,
        stopping,
        retryMs,
        connectionState,
        connectedAt,
      },
      terminal: terminalHost.getPerfSnapshot(),
      lsp: lspHost.getPerfSnapshot(),
    }),
  });
  console.log(`Portal daemon: ${config.portalId}`);
  console.log(`Server: ${config.serverUrl}`);
  console.log(`Runtime: ${runtimePath}`);

  try {
    while (!stopping) {
      try {
        const result = await connectOnce(
          config,
          instanceId,
          terminalHost,
          workspaceFileHost,
          lspHost,
          jupyterHost,
          (connection) => {
            activeConnection = connection;
          },
          (update) => {
            connectionState = update.state;
            connectionError = update.error;
            if (update.connectedAt) connectedAt = update.connectedAt;
            runtime = writeHeartbeat();
          },
        );
        if (result.stopRequested) stopping = true;
        retryMs = 1_000;
      } catch (error) {
        connectionError = error instanceof Error ? error.message : String(error);
        connectionState = /auth|token|reject/i.test(connectionError) ? 'rejected' : 'reconnecting';
        runtime = writeHeartbeat();
        console.error(connectionError);
      }
      if (stopping) break;
      await sleep(retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    }
  } finally {
    clearInterval(runtimeInterval);
    connectionState = 'stopped';
    runtime = writeHeartbeat();
    await runtimeWritePromise.catch(() => undefined);
    perfSampler.stop();
    terminalHost.dispose();
    workspaceFileHost.dispose();
    await lspHost.dispose();
    await jupyterHost.dispose();
    await removePortalRuntime(runtimePath, runtime).catch(() => undefined);
    await runtimeLock.release();
  }
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
  config.portal = {
    ...portal,
    roots: [...roots, { id, name, path: realPath }],
  };
  await writeConfig(configPath, config);
  console.log(`Root ${id}: ${realPath}`);
};

const mountProject = async (flags: Record<string, string | boolean>) => {
  const configPath = stringFlag(flags, 'config') ?? defaultConfigPath;
  const projectId = stringFlag(flags, 'project');
  const path = stringFlag(flags, 'path');
  if (!projectId || !path) {
    throw new Error('mount requires --project and --path');
  }

  const config = await readConfig(configPath);
  const realPath = await Deno.realPath(path);
  const portal = config.portal ?? {};
  const mounts = (portal.mounts ?? []).filter((mount) => mount.projectId !== projectId);
  config.portal = {
    ...portal,
    mounts: [...mounts, { projectId, localPath: realPath }],
  };
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
  if (!runtime) {
    console.log(`No local Portal runtime found at ${runtimePath}`);
    return;
  }
  if (!await verifyPortalProcessInstance(runtime, runtimePath)) {
    throw new Error(
      'Refusing to terminate Portal: runtime path and instance id do not match the process command line.',
    );
  }
  Deno.kill(runtime.pid, 'SIGTERM');
  console.log(`Stopping Portal daemon: ${runtime.portalId}`);
};

const start = async (flags: Record<string, string | boolean>) => {
  const configPath = stringFlag(flags, 'config') ?? defaultConfigPath;
  const runtimePath = stringFlag(flags, 'runtime') ?? defaultRuntimePath;
  const instanceId = crypto.randomUUID();
  const serverUrl = stringFlag(flags, 'server');
  const logPath = stringFlag(flags, 'log-file') ??
    `${resolvePortalHome()}/portal.log`;
  await ensureParentDir(logPath);
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      'daemon',
      '--config',
      configPath,
      '--runtime',
      runtimePath,
      '--instance-id',
      instanceId,
      '--log-file',
      logPath,
      ...(serverUrl ? ['--server', serverUrl] : []),
    ],
    stdin: 'null',
    stdout: 'null',
    stderr: 'null',
  }).spawn();
  child.unref();
  console.log(`Starting Portal daemon (pid ${child.pid}).`);
  console.log(`Runtime: ${runtimePath}`);
};

const usage = () => {
  console.log(`mage-portal ${version}

Commands:
  login --server http://localhost:4111 --token <owner-token> [--name <name>]
  start [--config ~/.config/weave/portal/config.json] [--server http://localhost:4111]
  root --path /path/to/code [--id default] [--name Code] [--config ~/.config/weave/portal/config.json]
  mount --project project_x --path /path/to/repo [--config ~/.config/weave/portal/config.json]
  daemon [--config ~/.config/weave/portal/config.json] [--server http://localhost:4111]
         [--runtime ~/.config/weave/portal/runtime.json] [--instance-id <random-id>]
         [--log-file ~/.config/weave/portal/desktop-daemon.log] [--log-max-bytes 1000000]
  status [--config ~/.config/weave/portal/config.json]
  stop
`);
};

const main = async () => {
  const { command, flags } = parseArgs(Deno.args);

  if (!command || command === 'daemon') {
    const logPath = stringFlag(flags, 'log-file');
    if (logPath) {
      await ensureParentDir(logPath);
      installBoundedConsoleLog(
        logPath,
        numberFlag(flags, 'log-max-bytes') ?? 1_000_000,
      );
    }
  }

  if (command === 'login') return login(flags);
  if (command === 'start') return start(flags);
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
