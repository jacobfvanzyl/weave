export type GitWorktreeMode = 'newBranch' | 'existingBranch' | 'detached';

export type GitBranchOption = {
  name: string;
  ref: string;
  kind: 'local' | 'remote';
  current?: boolean;
};

export type GitWorktreeInfo = {
  path?: string;
  branch?: string;
  commit?: string;
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  detached?: boolean;
  isCurrent?: boolean;
};

const textDecoder = new TextDecoder();

const decodeOutput = (bytes: Uint8Array) => textDecoder.decode(bytes).trim();

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

export const runGit = async (cwd: string, args: string[]) => {
  const command = new Deno.Command('git', { cwd, args, stdout: 'piped', stderr: 'piped' });
  const output = await command.output();
  if (!output.success) throw new Error(decodeOutput(output.stderr) || `git ${args.join(' ')} failed`);
  return decodeOutput(output.stdout);
};

export const runGitResult = async (cwd: string, args: string[]) => {
  const command = new Deno.Command('git', { cwd, args, stdout: 'piped', stderr: 'piped' });
  const output = await command.output();
  return {
    ok: output.success,
    stdout: textDecoder.decode(output.stdout),
    stderr: textDecoder.decode(output.stderr),
    exitCode: output.code,
  };
};

export const readAgentsMd = async (root: string) => {
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

export const inspectGit = async (path: string) => {
  const root = await runGit(path, ['rev-parse', '--show-toplevel']);
  const currentBranch = await runGit(root, ['branch', '--show-current']).catch(() => '');
  const defaultRef = await runGit(root, ['symbolic-ref', 'refs/remotes/origin/HEAD']).catch(() => '');
  const defaultBranch = defaultRef ? defaultRef.split('/').pop() : currentBranch || 'main';
  const remote = await runGit(root, ['config', '--get', 'remote.origin.url']).catch(() => undefined);
  const agentsMd = await readAgentsMd(root).catch(() => undefined);
  return { root, currentBranch, defaultBranch, remote, agentsMd };
};

export const normalizeGitWorktree = async (path: string): Promise<GitWorktreeInfo> => {
  const realPath = await Deno.realPath(path);
  const status = await getGitStatus(realPath).catch(() => undefined);
  if (status) {
    return {
      path: realPath,
      branch: status.branch,
      commit: status.head,
      head: status.head,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      detached: !status.branch,
    };
  }
  const branch = await runGit(realPath, ['branch', '--show-current']).catch(() => '');
  const commit = await runGit(realPath, ['rev-parse', 'HEAD']).catch(() => undefined);
  return { path: realPath, branch: branch || undefined, commit, head: commit, detached: !branch };
};

export const resolveNewGitWorkspacePath = async (
  root: string,
  args: Record<string, unknown>,
  label: string,
) => {
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

export const createGitWorktree = async (root: string, args: Record<string, unknown>) => {
  const mode: GitWorktreeMode = args.mode === 'existingBranch' || args.mode === 'detached'
    ? args.mode
    : 'newBranch';
  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
  const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined;
  const base = typeof args.base === 'string' && args.base.trim() ? args.base.trim() : undefined;
  if (mode !== 'detached' && !branch) throw new Error('Missing branch');

  const target = await resolveNewGitWorkspacePath(root, args, name ?? branch ?? base ?? 'detached');
  const gitArgs = mode === 'newBranch'
    ? ['worktree', 'add', '-b', branch!, target, base ?? 'HEAD']
    : mode === 'existingBranch'
    ? ['worktree', 'add', target, branch!]
    : ['worktree', 'add', '--detach', target, base ?? 'HEAD'];
  await runGit(root, gitArgs);
  return normalizeGitWorktree(target);
};

export const listGitWorktrees = async (root: string) => {
  const stdout = await runGit(root, ['worktree', 'list', '--porcelain']);
  const records = stdout.split(/\n{2,}/).map((record) => record.trim()).filter(Boolean);
  const worktrees: GitWorktreeInfo[] = records.map((record) => {
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
  return Promise.all(worktrees.map(async (worktree) => {
    if (!worktree.path) return worktree;
    const status = await getGitStatus(worktree.path).catch(() => undefined);
    if (!status) return worktree;
    return {
      ...worktree,
      branch: status.branch,
      commit: status.head,
      head: status.head,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      detached: !status.branch,
    };
  }));
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

export const listGitBranches = async (root: string) => {
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
  return [...localBranches, ...remoteBranches]
    .sort((a, b) => Number(b.current === true) - Number(a.current === true) || a.name.localeCompare(b.name));
};

export const switchGitWorktree = async (root: string, args: Record<string, unknown>) => {
  const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined;
  if (!branch) throw new Error('Missing branch');
  const base = typeof args.base === 'string' && args.base.trim() ? args.base.trim() : undefined;
  const gitArgs = args.create === true ? ['switch', '-c', branch, ...(base ? [base] : [])] : ['switch', branch];
  await runGit(root, gitArgs);
  return normalizeGitWorktree(root);
};

export const removeGitWorktree = async (
  root: string,
  args: Record<string, unknown>,
  fallbackPath?: string,
) => {
  const target = typeof args.path === 'string' && args.path.trim()
    ? args.path.trim()
    : typeof fallbackPath === 'string' && fallbackPath.trim()
    ? fallbackPath.trim()
    : undefined;
  if (!target) throw new Error('Missing path');
  const gitArgs = ['worktree', 'remove', target];
  if (args.force === true) gitArgs.push('--force');
  await runGit(root, gitArgs);
};

export const validateGitWorktree = async (primaryRoot: string, candidate: string) => {
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
  return normalizeGitWorktree(candidate);
};

type GitStatusEntry = {
  path: string;
  originalPath?: string;
  xy: string;
  staged: string;
  unstaged: string;
  kind: 'ordinary' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';
};

export const getGitStatus = async (root: string) => {
  const stdout = await runGit(root, ['status', '--porcelain=v2', '--branch', '-z']);
  const records = stdout.split('\0').filter(Boolean);
  const entries: GitStatusEntry[] = [];
  let branch: string | undefined;
  let head: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith('# branch.oid ')) {
      head = record.slice('# branch.oid '.length);
      continue;
    }
    if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length);
      branch = value === '(detached)' ? undefined : value;
      continue;
    }
    if (record.startsWith('# branch.upstream ')) {
      upstream = record.slice('# branch.upstream '.length);
      continue;
    }
    if (record.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(record);
      ahead = match ? Number(match[1]) : 0;
      behind = match ? Number(match[2]) : 0;
      continue;
    }
    if (record.startsWith('1 ')) {
      const fields = record.split(' ');
      const xy = fields[1] ?? '  ';
      entries.push({
        path: fields.slice(8).join(' '),
        xy,
        staged: xy[0] ?? ' ',
        unstaged: xy[1] ?? ' ',
        kind: 'ordinary',
      });
      continue;
    }
    if (record.startsWith('2 ')) {
      const fields = record.split(' ');
      const xy = fields[1] ?? '  ';
      const path = fields.slice(9).join(' ');
      const originalPath = records[index + 1];
      index += originalPath ? 1 : 0;
      entries.push({
        path,
        originalPath,
        xy,
        staged: xy[0] ?? ' ',
        unstaged: xy[1] ?? ' ',
        kind: 'renamed',
      });
      continue;
    }
    if (record.startsWith('u ')) {
      const fields = record.split(' ');
      const xy = fields[1] ?? 'UU';
      entries.push({
        path: fields.slice(10).join(' '),
        xy,
        staged: xy[0] ?? 'U',
        unstaged: xy[1] ?? 'U',
        kind: 'unmerged',
      });
      continue;
    }
    if (record.startsWith('? ')) {
      entries.push({ path: record.slice(2), xy: '??', staged: '?', unstaged: '?', kind: 'untracked' });
      continue;
    }
    if (record.startsWith('! ')) {
      entries.push({ path: record.slice(2), xy: '!!', staged: '!', unstaged: '!', kind: 'ignored' });
    }
  }

  return { branch, head, upstream, ahead, behind, entries, clean: entries.length === 0 };
};

const getGitUpstreamRemote = async (root: string) => {
  const status = await getGitStatus(root);
  if (!status.branch || !status.upstream) throw new Error('Current branch has no upstream');
  const remote = await runGit(root, ['config', '--get', `branch.${status.branch}.remote`]).catch(() => undefined);
  if (!remote || remote === '.') throw new Error('Current branch upstream is not a remote');
  return remote;
};

export const fetchGitUpstream = async (root: string) => {
  const remote = await getGitUpstreamRemote(root);
  await runGit(root, ['fetch', '--prune', remote]);
  return getGitStatus(root);
};

export const pullGitUpstream = async (root: string) => {
  await getGitUpstreamRemote(root);
  await runGit(root, ['pull', '--ff-only']);
  return getGitStatus(root);
};

export const getGitDiff = async (root: string, args: Record<string, unknown>) => {
  const staged = args.staged === true;
  const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
  const ref = typeof args.ref === 'string' && args.ref.trim() ? args.ref.trim() : undefined;
  const gitArgs = ['diff', '--no-ext-diff', '--find-renames', '--patch'];
  if (staged) gitArgs.push('--cached');
  if (ref) gitArgs.push(ref);
  if (path) gitArgs.push('--', path);
  return { diff: await runGit(root, gitArgs) };
};

export const getGitLog = async (root: string, args: Record<string, unknown>) => {
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 100) : 20;
  const ref = typeof args.ref === 'string' && args.ref.trim() ? args.ref.trim() : 'HEAD';
  const format = '%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1e';
  const stdout = await runGit(root, ['log', `--max-count=${limit}`, `--format=${format}`, ref]);
  const commits = stdout.split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
    const [sha = '', parents = '', authorName = '', authorEmail = '', authoredAt = '', refs = '', subject = ''] = record.split('\x1f');
    return {
      sha,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      authorName,
      authorEmail,
      authoredAt,
      refs,
      subject,
    };
  });
  return { commits };
};

export const getGitShow = async (root: string, args: Record<string, unknown>) => {
  const ref = typeof args.ref === 'string' && args.ref.trim() ? args.ref.trim() : 'HEAD';
  const output = await runGit(root, ['show', '--no-ext-diff', '--stat', '--patch', '--format=fuller', ref]);
  return { ref, output };
};
