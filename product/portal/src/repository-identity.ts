import type { RepositoryIdentity } from '@weave/product-protocol';

type GitResult = { code: number; stdout: string };
type GitRunner = (cwd: string, args: string[]) => Promise<GitResult>;

const runGit: GitRunner = async (cwd, args) => {
  const result = await new Deno.Command('git', {
    args: ['-C', cwd, ...args],
    stdout: 'piped',
    stderr: 'null',
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
  };
};

export const normalizeGitRemoteUrl = (value: string) => {
  const normalized = value
    .trim()
    .replace(/\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase();

  if (/^(?:ssh|https?|git):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      const repositoryPath = url.pathname
        .split('/')
        .filter(Boolean)
        .join('/');
      if (url.hostname && repositoryPath.includes('/')) {
        return `${url.hostname}/${repositoryPath}`;
      }
    } catch {
      return normalized;
    }
  }

  const scpStyle = /^[a-zA-Z0-9._-]+@([^:/\s]+):([^/\s]+(?:\/[^/\s]+)+)$/i.exec(
    normalized,
  );
  return scpStyle?.[1] && scpStyle[2] ? `${scpStyle[1]}/${scpStyle[2]}` : normalized;
};

const parseFetchRemotes = (stdout: string) => {
  const remotes = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (match?.[1] && match[2] && match[3] === 'fetch') {
      remotes.set(match[1], match[2]);
    }
  }
  return remotes;
};

const primaryRemote = (remotes: ReadonlyMap<string, string>) => {
  for (const remoteName of ['upstream', 'origin']) {
    const remoteUrl = remotes.get(remoteName);
    if (remoteUrl) return { remoteName, remoteUrl };
  }
  const [remoteName, remoteUrl] = [...remotes.entries()].sort(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : undefined;
};

export const resolveRepositoryIdentity = async (
  cwd: string,
  git: GitRunner = runGit,
): Promise<RepositoryIdentity | undefined> => {
  const topLevel = await git(cwd, ['rev-parse', '--show-toplevel']).catch(() => undefined);
  const rootPath = topLevel?.code === 0 ? topLevel.stdout.trim() : '';
  if (!rootPath) return undefined;

  const remoteResult = await git(rootPath, ['remote', '-v']).catch(() => undefined);
  if (!remoteResult || remoteResult.code !== 0) return undefined;
  const remote = primaryRemote(parseFetchRemotes(remoteResult.stdout));
  if (!remote) return undefined;

  const canonicalKey = normalizeGitRemoteUrl(remote.remoteUrl);
  const repositoryPath = canonicalKey.split('/').slice(1).join('/');
  const name = repositoryPath.split('/').filter(Boolean).at(-1);
  return {
    canonicalKey,
    locator: { source: 'git-remote', ...remote },
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(name ? { name } : {}),
  };
};
