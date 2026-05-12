type PortalMount = {
  planeId: string;
  localPath: string;
};

type PortalRoot = {
  id: string;
  name: string;
  path: string;
};

type PortalConfig = {
  portalId: string;
  portalToken: string;
  httpServerUrl: string;
  wsServerUrl: string;
  name: string;
  mounts?: PortalMount[];
  roots?: PortalRoot[];
};

type ParsedArgs = {
  command?: string;
  flags: Record<string, string | boolean>;
};

const defaultConfigPath = `${Deno.env.get('HOME') ?? '.'}/.mage-hand/portal.json`;
const defaultHttpServerUrl = 'http://localhost:4111';
const defaultWsServerUrl = 'ws://localhost:4112';
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

const ensureParentDir = async (path: string) => {
  const slashIndex = path.lastIndexOf('/');
  if (slashIndex <= 0) return;
  await Deno.mkdir(path.slice(0, slashIndex), { recursive: true });
};

const readConfig = async (path: string): Promise<PortalConfig> => {
  const content = await Deno.readTextFile(path);
  return JSON.parse(content) as PortalConfig;
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

  const config: PortalConfig = {
    portalId: body.portalId,
    portalToken: body.token,
    httpServerUrl,
    wsServerUrl,
    name,
  };

  await writeConfig(configPath, config);
  console.log(`Portal logged in: ${config.portalId}`);
  console.log(`Config: ${configPath}`);
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const getRoots = (config: PortalConfig) => config.roots?.length
  ? config.roots
  : [{ id: 'default', name: 'Default', path: Deno.env.get('HOME') ?? '.' }];

const resolveRootPath = async (config: PortalConfig, rootId: string, path = '') => {
  const root = getRoots(config).find(item => item.id === rootId);
  if (!root) throw new Error(`Unknown root: ${rootId}`);
  const rootPath = await Deno.realPath(root.path);
  const target = path ? await Deno.realPath(`${rootPath}/${path}`) : rootPath;
  if (target !== rootPath && !target.startsWith(`${rootPath}/`)) throw new Error('Path escapes Portal root');
  return { rootPath, target };
};

const runGit = async (cwd: string, args: string[]) => {
  const command = new Deno.Command('git', { cwd, args, stdout: 'piped', stderr: 'piped' });
  const output = await command.output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr).trim() || `git ${args.join(' ')} failed`);
  return new TextDecoder().decode(output.stdout).trim();
};

const readAgentsMd = async (root: string) => {
  const path = `${root}/AGENTS.md`;
  const info = await Deno.stat(path).catch(() => undefined);
  if (!info?.isFile || info.size > 128_000) return undefined;
  const content = await Deno.readTextFile(path);
  return { path: 'AGENTS.md', content: content.slice(0, 32_000), size: info.size, updatedAt: info.mtime?.toISOString() };
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

const resolveWorkspaceRoot = async (config: PortalConfig, request: Record<string, unknown>) => {
  const mount = typeof request.planeId === 'string'
    ? (config.mounts ?? []).find(item => item.planeId === request.planeId)
    : undefined;

  const root = mount
    ? await Deno.realPath(mount.localPath)
    : typeof request.rootId === 'string' && typeof request.repoPath === 'string'
      ? (await resolveRootPath(config, request.rootId, request.repoPath)).target
      : undefined;

  if (!root) throw new Error(`Plane is not mounted: ${String(request.planeId)}`);
  return root;
};

const resolveWorkspacePath = async (config: PortalConfig, request: Record<string, unknown>, path: string, mustExist = true) => {
  const root = await resolveWorkspaceRoot(config, request);
  const candidatePath = path ? `${root}/${path}` : root;
  const candidate = mustExist ? await Deno.realPath(candidatePath) : candidatePath;
  if (candidate !== root && !candidate.startsWith(`${root}/`)) throw new Error('Path escapes Plane mount');
  return { root, candidate };
};

const listRootTool = async (config: PortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  const rootId = typeof args?.rootId === 'string' ? args.rootId : 'default';
  const path = typeof args?.path === 'string' ? args.path : '';
  const { rootPath, target } = await resolveRootPath(config, rootId, path);
  const entries = [];
  for await (const entry of Deno.readDir(target)) {
    entries.push({ name: entry.name, type: entry.isDirectory ? 'directory' : entry.isFile ? 'file' : 'other', hidden: entry.name.startsWith('.') });
  }
  const git = await inspectGit(target).catch(() => undefined);
  const relativePath = target === rootPath ? '' : target.slice(rootPath.length + 1);
  return { ok: true, rootId, path: relativePath, entries: entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1), isGitRepo: Boolean(git), git };
};

const inspectGitTool = async (config: PortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  const rootId = typeof args?.rootId === 'string' ? args.rootId : 'default';
  const path = typeof args?.path === 'string' ? args.path : '';
  const { rootPath, target } = await resolveRootPath(config, rootId, path);
  const git = await inspectGit(target);
  if (git.root !== target) throw new Error('Selected path is inside a git repo; select the repo root');
  return { ok: true, rootId, path: target === rootPath ? '' : target.slice(rootPath.length + 1), git };
};

const readAgentInstructionsTool = async (config: PortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  const rootId = typeof args?.rootId === 'string' ? args.rootId : 'default';
  const path = typeof args?.path === 'string' ? args.path : '';
  const { target } = await resolveRootPath(config, rootId, path);
  const root = await runGit(target, ['rev-parse', '--show-toplevel']);
  const agentInstructions = await readAgentsMd(root).catch(() => undefined);
  return { ok: true, agentInstructions };
};

const readFileTool = async (config: PortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  if (typeof request.planeId !== 'string') throw new Error('Missing planeId');
  if (typeof args?.path !== 'string') throw new Error('Missing path');

  const { candidate: filePath } = await resolveWorkspacePath(config, request, args.path);
  const content = await Deno.readTextFile(filePath);
  const lines = content.split('\n');
  const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) - 1 : 0;
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : undefined;
  const selected = lines.slice(offset, limit ? offset + limit : undefined).join('\n');
  return { ok: true, content: selected };
};

const writeFileTool = async (config: PortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  if (typeof request.planeId !== 'string') throw new Error('Missing planeId');
  if (typeof args?.path !== 'string') throw new Error('Missing path');
  if (typeof args?.content !== 'string') throw new Error('Missing content');

  const { candidate: filePath } = await resolveWorkspacePath(config, request, args.path, false);
  await ensureParentDir(filePath);
  await Deno.writeTextFile(filePath, args.content);
  return { ok: true, bytes: new TextEncoder().encode(args.content).byteLength };
};

const editFileTool = async (config: PortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  if (typeof request.planeId !== 'string') throw new Error('Missing planeId');
  if (typeof args?.path !== 'string') throw new Error('Missing path');
  if (!Array.isArray(args?.edits) || args.edits.length === 0) throw new Error('Missing edits');

  const { candidate: filePath } = await resolveWorkspacePath(config, request, args.path);
  let content = await Deno.readTextFile(filePath);
  let replacements = 0;

  for (const edit of args.edits) {
    if (!edit || typeof edit !== 'object') throw new Error('Invalid edit');
    const oldText = (edit as Record<string, unknown>).oldText;
    const newText = (edit as Record<string, unknown>).newText;
    if (typeof oldText !== 'string' || typeof newText !== 'string') throw new Error('Invalid edit');
    if (!oldText) throw new Error('oldText cannot be empty');

    const first = content.indexOf(oldText);
    if (first === -1) throw new Error('oldText not found');
    if (content.indexOf(oldText, first + oldText.length) !== -1) throw new Error('oldText is not unique');

    content = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
    replacements += 1;
  }

  await Deno.writeTextFile(filePath, content);
  return { ok: true, replacements };
};

const bashTool = async (config: PortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  if (typeof request.planeId !== 'string') throw new Error('Missing planeId');
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

const handleToolCall = async (config: PortalConfig, ws: WebSocket, request: Record<string, unknown>) => {
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
            : request.tool === 'portal.fs.list'
              ? await listRootTool(config, request)
              : request.tool === 'portal.git.inspect'
                ? await inspectGitTool(config, request)
                : request.tool === 'portal.agentInstructions.read'
                  ? await readAgentInstructionsTool(config, request)
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

const connectOnce = (config: PortalConfig) => new Promise<void>((resolve, reject) => {
  const url = new URL('/portals/connect', config.wsServerUrl);
  url.searchParams.set('portalId', config.portalId);
  url.searchParams.set('token', config.portalToken);

  const ws = new WebSocket(url);
  let accepted = false;
  let heartbeat: number | undefined;

  const cleanup = () => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
  };

  ws.onopen = () => {
    console.log(`Connected socket: ${url.origin}`);
  };

  ws.onmessage = event => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    console.log('<-', JSON.stringify(message));

    if (message.type === 'portal.accepted') {
      accepted = true;
      ws.send(JSON.stringify({
        type: 'portal.hello',
        name: config.name,
        version,
        capabilities: ['read', 'write', 'edit', 'bash', 'portal.fs.list', 'portal.git.inspect', 'portal.agentInstructions.read'],
        mounts: config.mounts ?? [],
        roots: getRoots(config).map(root => ({ id: root.id, name: root.name })),
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

    if (message.type === 'tool.call') void handleToolCall(config, ws, message);
  };

  ws.onerror = () => {
    cleanup();
    if (!accepted) reject(new Error('WebSocket connection failed'));
  };

  ws.onclose = event => {
    cleanup();
    console.log(`Socket closed: ${event.code} ${event.reason}`.trim());
    resolve();
  };
});

const daemon = async (flags: Record<string, string | boolean>) => {
  const configPath = stringFlag(flags, 'config') ?? defaultConfigPath;
  const config = await readConfig(configPath);
  config.wsServerUrl = normalizeWsUrl(stringFlag(flags, 'ws-server') ?? config.wsServerUrl);
  config.name = stringFlag(flags, 'name') ?? config.name;

  console.log(`Portal daemon: ${config.portalId}`);
  console.log(`WebSocket: ${config.wsServerUrl}`);

  let retryMs = 1_000;
  while (true) {
    try {
      await connectOnce(config);
      retryMs = 1_000;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }

    console.log(`Reconnecting in ${retryMs}ms`);
    await sleep(retryMs);
    retryMs = Math.min(retryMs * 2, 30_000);
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
  const roots = (config.roots ?? []).filter(root => root.id !== id);
  config.roots = [...roots, { id, name, path: realPath }];
  await writeConfig(configPath, config);
  console.log(`Root ${id}: ${realPath}`);
};

const mountPlane = async (flags: Record<string, string | boolean>) => {
  const configPath = stringFlag(flags, 'config') ?? defaultConfigPath;
  const planeId = stringFlag(flags, 'plane');
  const path = stringFlag(flags, 'path');
  if (!planeId || !path) throw new Error('mount requires --plane and --path');

  const config = await readConfig(configPath);
  const realPath = await Deno.realPath(path);
  const mounts = (config.mounts ?? []).filter(mount => mount.planeId !== planeId);
  config.mounts = [...mounts, { planeId, localPath: realPath }];
  await writeConfig(configPath, config);
  console.log(`Mounted ${planeId}: ${realPath}`);
};

const status = async (flags: Record<string, string | boolean>) => {
  const configPath = stringFlag(flags, 'config') ?? defaultConfigPath;
  const config = await readConfig(configPath);
  console.log(JSON.stringify({ ...config, portalToken: `${config.portalToken.slice(0, 8)}...` }, null, 2));
};

const usage = () => {
  console.log(`mage-portal ${version}

Commands:
  login --server http://localhost:4111 --token <auth-token> [--ws-server ws://localhost:4112] [--name <name>]
  root --path /path/to/code [--id default] [--name Code] [--config ~/.mage-hand/portal.json]
  mount --plane plane_x --path /path/to/repo [--config ~/.mage-hand/portal.json]
  daemon [--config ~/.mage-hand/portal.json] [--ws-server ws://localhost:4112]
  status [--config ~/.mage-hand/portal.json]
`);
};

const main = async () => {
  const { command, flags } = parseArgs(Deno.args);

  if (command === 'login') return login(flags);
  if (command === 'daemon') return daemon(flags);
  if (command === 'root') return addRoot(flags);
  if (command === 'mount') return mountPlane(flags);
  if (command === 'status') return status(flags);

  usage();
  if (command) Deno.exit(1);
};

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  });
}
