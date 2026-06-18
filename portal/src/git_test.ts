import { assert, assertEquals, assertRejects, assertStringIncludes } from 'jsr:@std/assert@1.0.19';
import {
  createGitWorktree,
  fetchGitUpstream,
  getGitDiff,
  getGitLog,
  getGitStatus,
  inspectGitBranchCleanup,
  listGitWorktrees,
  pullGitUpstream,
  removeGitWorktree,
  validateGitWorktree,
  GitWorktreeRemoveDirtyError,
} from './git.ts';

const write = async (path: string, content: string) => {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(path, content);
};

const runGit = async (cwd: string, args: string[]) => {
  const result = await new Deno.Command('git', { cwd, args, stdout: 'null', stderr: 'null' }).output();
  if (!result.success) throw new Error(`git ${args.join(' ')} failed`);
};

const runGitOutput = async (cwd: string, args: string[]) => {
  const result = await new Deno.Command('git', { cwd, args, stdout: 'piped', stderr: 'piped' }).output();
  if (!result.success) throw new Error(`git ${args.join(' ')} failed`);
  return new TextDecoder().decode(result.stdout).trim();
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

Deno.test('Git module removes worktrees while preserving branches by default', async () => {
  const repo = await createRepo('weave-git-worktree-remove-preserve-');
  let worktreePath: string | undefined;
  try {
    const worktree = await createGitWorktree(repo, { mode: 'newBranch', branch: 'feature/preserve', name: 'preserve' });
    worktreePath = worktree.path;
    assert(worktreePath);

    const result = await removeGitWorktree(repo, { path: worktreePath, defaultBranch: 'main' });
    assertEquals(result.branchCleanup.requested, false);
    assertEquals(result.branchCleanup.status, 'not_requested');
    assertEquals(await runGitOutput(repo, ['branch', '--list', 'feature/preserve']), 'feature/preserve');
  } finally {
    if (worktreePath) await runGit(repo, ['worktree', 'remove', worktreePath, '--force']).catch(() => undefined);
    await runGit(repo, ['branch', '-D', 'feature/preserve']).catch(() => undefined);
    await Deno.remove(repo, { recursive: true }).catch(() => undefined);
    if (worktreePath) await Deno.remove(worktreePath, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Git module deletes a merged local branch only after removing its worktree', async () => {
  const repo = await createRepo('weave-git-worktree-remove-branch-');
  let worktreePath: string | undefined;
  try {
    const worktree = await createGitWorktree(repo, { mode: 'newBranch', branch: 'feature/delete-merged', name: 'delete-merged' });
    worktreePath = worktree.path;
    assert(worktreePath);

    const preview = await inspectGitBranchCleanup(repo, { path: worktreePath, defaultBranch: 'main' });
    assertEquals(preview.eligible, true);
    assertEquals(preview.branch, 'feature/delete-merged');
    assertEquals(preview.targetRef, 'main');
    assertEquals(preview.targetKind, 'default_branch');

    const result = await removeGitWorktree(repo, { path: worktreePath, defaultBranch: 'main', deleteLocalBranch: true });
    assertEquals(result.branchCleanup.status, 'deleted');
    assertEquals(await runGitOutput(repo, ['branch', '--list', 'feature/delete-merged']), '');
  } finally {
    if (worktreePath) await runGit(repo, ['worktree', 'remove', worktreePath, '--force']).catch(() => undefined);
    await runGit(repo, ['branch', '-D', 'feature/delete-merged']).catch(() => undefined);
    await Deno.remove(repo, { recursive: true }).catch(() => undefined);
    if (worktreePath) await Deno.remove(worktreePath, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Git module keeps unmerged local branches when branch deletion is requested', async () => {
  const repo = await createRepo('weave-git-worktree-remove-unmerged-');
  let worktreePath: string | undefined;
  try {
    const worktree = await createGitWorktree(repo, { mode: 'newBranch', branch: 'feature/unmerged', name: 'unmerged' });
    worktreePath = worktree.path;
    assert(worktreePath);
    await commitFile(worktreePath, 'feature.txt', 'feature\n', 'feature work');

    const result = await removeGitWorktree(repo, { path: worktreePath, defaultBranch: 'main', deleteLocalBranch: true });
    assertEquals(result.branchCleanup.status, 'not_merged');
    assertEquals(result.branchCleanup.targetKind, 'default_branch');
    assertEquals(await runGitOutput(repo, ['branch', '--list', 'feature/unmerged']), 'feature/unmerged');
  } finally {
    if (worktreePath) await runGit(repo, ['worktree', 'remove', worktreePath, '--force']).catch(() => undefined);
    await runGit(repo, ['branch', '-D', 'feature/unmerged']).catch(() => undefined);
    await Deno.remove(repo, { recursive: true }).catch(() => undefined);
    if (worktreePath) await Deno.remove(worktreePath, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Git module deletes a no-upstream branch when same-name remote contains it', async () => {
  const { repo, remote, peerParent } = await createRemoteBackedRepo('weave-git-worktree-remove-same-remote-');
  let worktreePath: string | undefined;
  try {
    const worktree = await createGitWorktree(repo, { mode: 'newBranch', branch: 'feature/pushed-pr', name: 'pushed-pr' });
    worktreePath = worktree.path;
    assert(worktreePath);
    await commitFile(worktreePath, 'feature.txt', 'feature\n', 'feature work');
    await runGit(worktreePath, ['push', 'origin', 'HEAD:refs/heads/feature/pushed-pr']);
    await runGit(repo, ['fetch', 'origin', 'feature/pushed-pr:refs/remotes/origin/feature/pushed-pr']);

    const preview = await inspectGitBranchCleanup(repo, { path: worktreePath, defaultBranch: 'main' });
    assertEquals(preview.eligible, true);
    assertEquals(preview.branch, 'feature/pushed-pr');
    assertEquals(preview.targetRef, 'origin/feature/pushed-pr');
    assertEquals(preview.targetKind, 'same_name_remote');

    const result = await removeGitWorktree(repo, { path: worktreePath, defaultBranch: 'main', deleteLocalBranch: true });
    assertEquals(result.branchCleanup.status, 'deleted');
    assertEquals(result.branchCleanup.targetKind, 'same_name_remote');
    assertEquals(await runGitOutput(repo, ['branch', '--list', 'feature/pushed-pr']), '');
  } finally {
    if (worktreePath) await runGit(repo, ['worktree', 'remove', worktreePath, '--force']).catch(() => undefined);
    await runGit(repo, ['branch', '-D', 'feature/pushed-pr']).catch(() => undefined);
    await Deno.remove(repo, { recursive: true }).catch(() => undefined);
    await Deno.remove(remote, { recursive: true }).catch(() => undefined);
    await Deno.remove(peerParent, { recursive: true }).catch(() => undefined);
    if (worktreePath) await Deno.remove(worktreePath, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Git module reports not pushed when same-name remote is behind the local branch', async () => {
  const { repo, remote, peerParent } = await createRemoteBackedRepo('weave-git-worktree-remove-not-pushed-');
  let worktreePath: string | undefined;
  try {
    const worktree = await createGitWorktree(repo, { mode: 'newBranch', branch: 'feature/not-pushed', name: 'not-pushed' });
    worktreePath = worktree.path;
    assert(worktreePath);
    await commitFile(worktreePath, 'feature.txt', 'feature\n', 'feature work');
    await runGit(worktreePath, ['push', 'origin', 'HEAD:refs/heads/feature/not-pushed']);
    await runGit(repo, ['fetch', 'origin', 'feature/not-pushed:refs/remotes/origin/feature/not-pushed']);
    await commitFile(worktreePath, 'local-only.txt', 'local\n', 'local-only work');

    const preview = await inspectGitBranchCleanup(repo, { path: worktreePath, defaultBranch: 'main' });
    assertEquals(preview.status, 'not_pushed');
    assertEquals(preview.targetRef, 'origin/feature/not-pushed');
    assertEquals(preview.targetKind, 'same_name_remote');
  } finally {
    if (worktreePath) await runGit(repo, ['worktree', 'remove', worktreePath, '--force']).catch(() => undefined);
    await runGit(repo, ['branch', '-D', 'feature/not-pushed']).catch(() => undefined);
    await Deno.remove(repo, { recursive: true }).catch(() => undefined);
    await Deno.remove(remote, { recursive: true }).catch(() => undefined);
    await Deno.remove(peerParent, { recursive: true }).catch(() => undefined);
    if (worktreePath) await Deno.remove(worktreePath, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Git module does not guess between ambiguous same-name remote branches', async () => {
  const repo = await createRepo('weave-git-worktree-remove-ambiguous-');
  const firstRemote = await Deno.realPath(await Deno.makeTempDir({ prefix: 'weave-git-first-remote-' }));
  const secondRemote = await Deno.realPath(await Deno.makeTempDir({ prefix: 'weave-git-second-remote-' }));
  let worktreePath: string | undefined;
  try {
    await runGit(firstRemote, ['init', '--bare']);
    await runGit(secondRemote, ['init', '--bare']);
    await runGit(repo, ['remote', 'add', 'first', firstRemote]);
    await runGit(repo, ['remote', 'add', 'second', secondRemote]);

    const worktree = await createGitWorktree(repo, { mode: 'newBranch', branch: 'feature/ambiguous', name: 'ambiguous' });
    worktreePath = worktree.path;
    assert(worktreePath);
    await commitFile(worktreePath, 'feature.txt', 'feature\n', 'feature work');
    await runGit(worktreePath, ['push', 'first', 'HEAD:refs/heads/feature/ambiguous']);
    await runGit(worktreePath, ['push', 'second', 'HEAD:refs/heads/feature/ambiguous']);
    await runGit(repo, ['fetch', 'first', 'feature/ambiguous:refs/remotes/first/feature/ambiguous']);
    await runGit(repo, ['fetch', 'second', 'feature/ambiguous:refs/remotes/second/feature/ambiguous']);

    const preview = await inspectGitBranchCleanup(repo, { path: worktreePath, defaultBranch: 'main' });
    assertEquals(preview.status, 'not_applicable');
    assertStringIncludes(preview.error ?? '', 'multiple remote branches match feature/ambiguous');
  } finally {
    if (worktreePath) await runGit(repo, ['worktree', 'remove', worktreePath, '--force']).catch(() => undefined);
    await runGit(repo, ['branch', '-D', 'feature/ambiguous']).catch(() => undefined);
    await Deno.remove(repo, { recursive: true }).catch(() => undefined);
    await Deno.remove(firstRemote, { recursive: true }).catch(() => undefined);
    await Deno.remove(secondRemote, { recursive: true }).catch(() => undefined);
    if (worktreePath) await Deno.remove(worktreePath, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Git module treats detached worktrees as not applicable for branch deletion', async () => {
  const repo = await createRepo('weave-git-worktree-remove-detached-');
  let worktreePath: string | undefined;
  try {
    const worktree = await createGitWorktree(repo, { mode: 'detached', name: 'detached', base: 'main' });
    worktreePath = worktree.path;
    assert(worktreePath);

    const result = await removeGitWorktree(repo, { path: worktreePath, defaultBranch: 'main', deleteLocalBranch: true });
    assertEquals(result.branchCleanup.status, 'not_applicable');
  } finally {
    if (worktreePath) await runGit(repo, ['worktree', 'remove', worktreePath, '--force']).catch(() => undefined);
    await Deno.remove(repo, { recursive: true }).catch(() => undefined);
    if (worktreePath) await Deno.remove(worktreePath, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Git module requires explicit force to remove dirty worktrees', async () => {
  const repo = await createRepo('weave-git-worktree-remove-dirty-');
  let worktreePath: string | undefined;
  try {
    const worktree = await createGitWorktree(repo, { mode: 'newBranch', branch: 'feature/dirty', name: 'dirty' });
    worktreePath = worktree.path;
    assert(worktreePath);
    await write(`${worktreePath}/scratch.txt`, 'dirty\n');

    await assertRejects(
      () => removeGitWorktree(repo, { path: worktreePath, defaultBranch: 'main' }),
      GitWorktreeRemoveDirtyError,
    );
    const result = await removeGitWorktree(repo, { path: worktreePath, defaultBranch: 'main', force: true });
    assertEquals(result.branchCleanup.status, 'not_requested');
    assertEquals(await runGitOutput(repo, ['branch', '--list', 'feature/dirty']), 'feature/dirty');
  } finally {
    if (worktreePath) await runGit(repo, ['worktree', 'remove', worktreePath, '--force']).catch(() => undefined);
    await runGit(repo, ['branch', '-D', 'feature/dirty']).catch(() => undefined);
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
