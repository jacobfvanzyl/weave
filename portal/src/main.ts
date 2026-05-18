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

const homeDir = Deno.env.get('HOME') ?? '.';
const defaultConfigPath = `${homeDir}/.weave/portal.json`;
const legacyConfigPath = `${homeDir}/.mage-hand/portal.json`;
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
  const content = await Deno.readTextFile(path).catch(async error => {
    if (path !== defaultConfigPath || !(error instanceof Deno.errors.NotFound)) throw error;
    return await Deno.readTextFile(legacyConfigPath);
  });
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
  const [path = '', versionText = ''] = result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  return { ok: true, installed: true, path, version: versionText.replace(/^wt\s+/, '') };
};

const assertWorktrunkInstalled = async (cwd: string) => {
  const status = await getWorktrunkStatus(cwd);
  if (!status.installed) {
    const error = new Error('WT_MISSING: wt is not installed or not on Portal PATH. Install Worktrunk or add wt to PATH, then restart Portal.');
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
  if (typeof request.workspacePath === 'string' && request.workspacePath.trim()) {
    return await Deno.realPath(request.workspacePath.trim());
  }

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
  const candidatePath = normalizePath(path.startsWith('/') ? path : `${root}/${path}`);

  if (mustExist) {
    const candidate = await Deno.realPath(candidatePath);
    if (candidate !== root && !candidate.startsWith(`${root}/`)) throw new Error('Path escapes Plane mount');
    return { root, candidate };
  }

  const parentPath = getParentPath(candidatePath);
  const realParent = await Deno.realPath(parentPath).catch(async () => {
    await Deno.mkdir(parentPath, { recursive: true });
    return await Deno.realPath(parentPath);
  });
  const candidate = normalizePath(`${realParent}/${candidatePath.slice(parentPath.length + 1)}`);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) throw new Error('Path escapes Plane mount');
  return { root, candidate };
};

const pathStatTool = async (_config: PortalConfig, request: Record<string, unknown>) => {
  const args = (request.args ?? {}) as Record<string, unknown>;
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  if (!path) return { ok: false, error: 'path is required' };
  const realPath = await Deno.realPath(path);
  const stat = await Deno.stat(realPath);
  return { ok: true, path: realPath, isDirectory: stat.isDirectory, isFile: stat.isFile, isSymlink: stat.isSymlink };
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

const normalizeWtWorktree = (item: unknown) => {
  const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
  const commit = record.commit && typeof record.commit === 'object' ? record.commit as Record<string, unknown> : undefined;
  const worktree = record.worktree && typeof record.worktree === 'object' ? record.worktree as Record<string, unknown> : undefined;
  return {
    branch: typeof record.branch === 'string' ? record.branch : undefined,
    path: typeof record.path === 'string' ? normalizePath(record.path) : undefined,
    commit: typeof commit?.sha === 'string' ? commit.sha : undefined,
    shortCommit: typeof commit?.short_sha === 'string' ? commit.short_sha : undefined,
    message: typeof commit?.message === 'string' ? commit.message : undefined,
    isMain: record.is_main === true,
    isCurrent: record.is_current === true,
    detached: worktree?.detached === true,
    statusline: typeof record.statusline === 'string' ? record.statusline.replace(/\u001b\[[0-9;]*m/g, '') : undefined,
  };
};

const worktrunkStatusTool = async () => getWorktrunkStatus();

const worktrunkListTool = async (config: PortalConfig, request: Record<string, unknown>) => {
  const root = await resolveWorkspaceRoot(config, request);
  const result = await runWtJson(root, ['-C', root, 'list', '--format', 'json']);
  const worktrees = Array.isArray(result) ? result.map(normalizeWtWorktree) : [];
  return { ok: true, worktrees };
};

const worktrunkCreateTool = async (config: PortalConfig, request: Record<string, unknown>) => {
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

const worktrunkRemoveTool = async (config: PortalConfig, request: Record<string, unknown>) => {
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

const gitWorktreeValidateTool = async (config: PortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  const path = typeof args?.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
  if (!path) throw new Error('Missing path');

  const primaryRoot = await resolveWorkspaceRoot(config, request);
  const candidate = path.startsWith('/') ? await Deno.realPath(path) : (await resolveRootPath(config, typeof args?.rootId === 'string' ? args.rootId : 'default', path)).target;
  const primaryCommonDir = await runGit(primaryRoot, ['rev-parse', '--git-common-dir']);
  const candidateCommonDir = await runGit(candidate, ['rev-parse', '--git-common-dir']);
  const normalizedPrimaryCommonDir = primaryCommonDir.startsWith('/') ? await Deno.realPath(primaryCommonDir) : await Deno.realPath(`${primaryRoot}/${primaryCommonDir}`);
  const normalizedCandidateCommonDir = candidateCommonDir.startsWith('/') ? await Deno.realPath(candidateCommonDir) : await Deno.realPath(`${candidate}/${candidateCommonDir}`);
  if (normalizedPrimaryCommonDir !== normalizedCandidateCommonDir) throw new Error('Selected path is not a worktree for this Plane repo');

  const branch = await runGit(candidate, ['branch', '--show-current']).catch(() => '');
  const commit = await runGit(candidate, ['rev-parse', 'HEAD']).catch(() => undefined);
  return { ok: true, worktree: { path: candidate, branch: branch || undefined, commit, detached: !branch } };
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

const readFileTool = async (config: PortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  if (typeof request.planeId !== 'string') throw new Error('Missing planeId');
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

const writeFileTool = async (config: PortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  if (typeof request.planeId !== 'string') throw new Error('Missing planeId');
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
const restoreLineEndings = (content: string, lineEnding: string) => lineEnding === '\r\n' ? content.replace(/\n/g, '\r\n') : content;
const stripBom = (content: string) => content.startsWith('\uFEFF') ? { bom: '\uFEFF', text: content.slice(1) } : { bom: '', text: content };

const countOccurrences = (content: string, text: string) => {
  let count = 0;
  let index = content.indexOf(text);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(text, index + text.length);
  }
  return count;
};

const generateSimpleDiff = (oldContent: string, newContent: string) => {
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
  const output: string[] = [];
  for (let i = start; i <= endOld; i += 1) {
    if (i < prefix || i > oldSuffix) output.push(` ${i + 1} ${oldLines[i]}`);
    else output.push(`-${i + 1} ${oldLines[i]}`);
  }
  for (let i = prefix; i <= newSuffix; i += 1) output.push(`+${i + 1} ${newLines[i]}`);
  if (endNew > newSuffix) {
    for (let i = Math.max(prefix, newSuffix + 1); i <= endNew; i += 1) output.push(` ${i + 1} ${newLines[i]}`);
  }
  return output.join('\n');
};

const editFileTool = async (config: PortalConfig, request: Record<string, unknown>) => {
  const args = request.args as Record<string, unknown> | undefined;
  if (typeof request.planeId !== 'string') throw new Error('Missing planeId');
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
      if (matchIndex === -1) throw new Error(`Could not find edits[${editIndex}] in ${args.path}. The oldText must match exactly including all whitespace and newlines.`);
      const occurrences = countOccurrences(content, normalizedOldText);
      if (occurrences > 1) throw new Error(`Found ${occurrences} occurrences of edits[${editIndex}] in ${args.path}. Each oldText must be unique.`);
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
        throw new Error(`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${args.path}. Merge them into one edit or target disjoint regions.`);
      }
    }

    let nextContent = content;
    for (let i = matchedEdits.length - 1; i >= 0; i -= 1) {
      const edit = matchedEdits[i];
      nextContent = `${nextContent.slice(0, edit.index)}${edit.newText}${nextContent.slice(edit.index + edit.length)}`;
    }
    if (nextContent === content) throw new Error(`No changes made to ${args.path}. The replacements produced identical content.`);

    await Deno.writeTextFile(filePath, bom + restoreLineEndings(nextContent, lineEnding));
    return { ok: true, replacements: matchedEdits.length, diff: generateSimpleDiff(content, nextContent) };
  });
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
              : request.tool === 'portal.fs.stat'
                ? await pathStatTool(config, request)
                : request.tool === 'portal.git.inspect'
                ? await inspectGitTool(config, request)
                : request.tool === 'portal.agentInstructions.read'
                  ? await readAgentInstructionsTool(config, request)
                  : request.tool === 'portal.worktrunk.status'
                    ? await worktrunkStatusTool()
                    : request.tool === 'portal.worktrunk.list'
                      ? await worktrunkListTool(config, request)
                      : request.tool === 'portal.worktrunk.create'
                        ? await worktrunkCreateTool(config, request)
                        : request.tool === 'portal.worktrunk.remove'
                          ? await worktrunkRemoveTool(config, request)
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

const getPortalCapabilities = async () => {
  const baseCapabilities = ['read', 'write', 'edit', 'bash', 'portal.fs.list', 'portal.fs.stat', 'portal.git.inspect', 'portal.agentInstructions.read', 'portal.git.worktree.validate', 'portal.worktrunk.status'];
  const status = await getWorktrunkStatus().catch(() => ({ installed: false }));
  return status.installed
    ? [...baseCapabilities, 'portal.worktrunk.list', 'portal.worktrunk.create', 'portal.worktrunk.remove']
    : baseCapabilities;
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

  ws.onmessage = async event => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    console.log('<-', JSON.stringify(message));

    if (message.type === 'portal.accepted') {
      accepted = true;
      ws.send(JSON.stringify({
        type: 'portal.hello',
        name: config.name,
        version,
        capabilities: await getPortalCapabilities(),
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
  root --path /path/to/code [--id default] [--name Code] [--config ~/.weave/portal.json]
  mount --plane plane_x --path /path/to/repo [--config ~/.weave/portal.json]
  daemon [--config ~/.weave/portal.json] [--ws-server ws://localhost:4112]
  status [--config ~/.weave/portal.json]
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
