import { assert, assertEquals, assertRejects, assertStringIncludes } from 'jsr:@std/assert@1.0.19';
import {
  createGitWorktree,
  fetchGitUpstream,
  getGitDiff,
  getGitLog,
  getGitStatus,
  listGitWorktrees,
  pullGitUpstream,
  validateGitWorktree,
} from './git.ts';

const write = async (path: string, content: string) => {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(path, content);
};

const runGit = async (cwd: string, args: string[]) => {
  const result = await new Deno.Command('git', { cwd, args, stdout: 'null', stderr: 'null' }).output();
  if (!result.success) throw new Error(`git ${args.join(' ')} failed`);
};

const configureGitUser = async (repo: string) => {
  await runGit(repo, ['config', 'user.email', 'portal-test@example.com']);
  await runGit(repo, ['config', 'user.name', 'Portal Test']);
};

const createRepo = async (prefix: string) => {
  const repo = await Deno.realPath(await Deno.makeTempDir({ prefix }));
  await runGit(repo, ['init']);
  await runGit(repo, ['checkout', '-b', 'main']);
  await configureGitUser(repo);
  await write(`${repo}/README.md`, '# Test\n');
  await runGit(repo, ['add', 'README.md']);
  await runGit(repo, ['commit', '-m', 'initial']);
  return repo;
};

const commitFile = async (repo: string, path: string, content: string, message: string) => {
  await write(`${repo}/${path}`, content);
  await runGit(repo, ['add', path]);
  await runGit(repo, ['commit', '-m', message]);
};

const createRemoteBackedRepo = async (prefix: string) => {
  const repo = await createRepo(`${prefix}-local-`);
  const remote = await Deno.realPath(await Deno.makeTempDir({ prefix: `${prefix}-remote-` }));
  await runGit(remote, ['init', '--bare']);
  await runGit(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await runGit(repo, ['remote', 'add', 'origin', remote]);
  await runGit(repo, ['push', '-u', 'origin', 'main']);

  const peerParent = await Deno.realPath(await Deno.makeTempDir({ prefix: `${prefix}-peer-` }));
  const peer = `${peerParent}/peer`;
  await runGit(peerParent, ['clone', remote, peer]);
  await configureGitUser(peer);
  return { repo, remote, peerParent, peer };
};

Deno.test('Git module parses status, diff, and log output', async () => {
  const repo = await createRepo('weave-git-status-');
  try {
    await write(`${repo}/README.md`, '# Test\nchanged\n');
    await write(`${repo}/notes.txt`, 'new\n');

    const status = await getGitStatus(repo);
    assertEquals(status.branch, 'main');
    assert(status.entries.some(entry => entry.path === 'README.md' && entry.unstaged === 'M'));
    assert(status.entries.some(entry => entry.path === 'notes.txt' && entry.kind === 'untracked'));

    const diff = await getGitDiff(repo, {});
    assertStringIncludes(diff.diff, '+changed');

    const log = await getGitLog(repo, { limit: 1 });
    assertEquals(log.commits.length, 1);
    assertEquals(log.commits[0].subject, 'initial');
  } finally {
    await Deno.remove(repo, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Git module creates, lists, and validates worktrees without Worktrunk', async () => {
  const repo = await createRepo('weave-git-worktree-');
  let worktreePath: string | undefined;
  try {
    const worktree = await createGitWorktree(repo, { mode: 'newBranch', branch: 'feature/git-module', name: 'git-module' });
    worktreePath = worktree.path;
    assert(worktreePath);
    assertEquals(worktree.branch, 'feature/git-module');

    const worktrees = await listGitWorktrees(repo);
    assert(worktrees.some(item => item.path === worktreePath && item.branch === 'feature/git-module'));

    const validated = await validateGitWorktree(repo, worktreePath);
    assertEquals(validated.path, worktreePath);
    assertEquals(validated.branch, 'feature/git-module');
  } finally {
    if (worktreePath) await runGit(repo, ['worktree', 'remove', worktreePath, '--force']).catch(() => undefined);
    await Deno.remove(repo, { recursive: true }).catch(() => undefined);
    if (worktreePath) await Deno.remove(worktreePath, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Git module fetches upstream and parses ahead behind status', async () => {
  const { repo, remote, peerParent, peer } = await createRemoteBackedRepo('weave-git-upstream-');
  try {
    await commitFile(peer, 'remote.txt', 'remote\n', 'remote change');
    await runGit(peer, ['push']);
    await fetchGitUpstream(repo);
    await commitFile(repo, 'local.txt', 'local\n', 'local change');

    const status = await getGitStatus(repo);
    assertEquals(status.upstream, 'origin/main');
    assertEquals(status.ahead, 1);
    assertEquals(status.behind, 1);
  } finally {
    await Deno.remove(repo, { recursive: true }).catch(() => undefined);
    await Deno.remove(remote, { recursive: true }).catch(() => undefined);
    await Deno.remove(peerParent, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Git module pulls fast-forward only and rejects diverged history', async () => {
  const { repo, remote, peerParent, peer } = await createRemoteBackedRepo('weave-git-pull-');
  try {
    await commitFile(peer, 'remote-1.txt', 'remote\n', 'remote change');
    await runGit(peer, ['push']);

    const pulled = await pullGitUpstream(repo);
    assertEquals(pulled.behind, 0);
    assertEquals(pulled.ahead, 0);

    await commitFile(peer, 'remote-2.txt', 'remote 2\n', 'second remote change');
    await runGit(peer, ['push']);
    await commitFile(repo, 'local.txt', 'local\n', 'local change');
    await fetchGitUpstream(repo);

    await assertRejects(() => pullGitUpstream(repo), Error);
  } finally {
    await Deno.remove(repo, { recursive: true }).catch(() => undefined);
    await Deno.remove(remote, { recursive: true }).catch(() => undefined);
    await Deno.remove(peerParent, { recursive: true }).catch(() => undefined);
  }
});
