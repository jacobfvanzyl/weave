import { test } from './test-support.ts';
import { assertEquals } from './test-support.ts';
import { normalizeGitRemoteUrl, resolveRepositoryIdentity } from './repository-identity.ts';

test('Git remote normalization matches cross-Host SSH and HTTPS repositories', () => {
  assertEquals(
    normalizeGitRemoteUrl('git@GitHub.com:VeeZee/Weave.git'),
    'github.com/veezee/weave',
  );
  assertEquals(
    normalizeGitRemoteUrl('https://github.com/veezee/weave.git/'),
    'github.com/veezee/weave',
  );
});

test('repository identity prefers upstream, then origin, then alphabetic fetch remotes', async () => {
  const commands: string[][] = [];
  const identity = await resolveRepositoryIdentity('/checkout', (_cwd, args) => {
    commands.push(args);
    return Promise.resolve(
      args[0] === 'rev-parse' ? { code: 0, stdout: '/repo\n' } : {
        code: 0,
        stdout: [
          'zeta git@example.com:zeta/repo.git (fetch)',
          'origin https://example.com/origin/repo.git (fetch)',
          'upstream git@example.com:upstream/repo.git (fetch)',
          'upstream git@example.com:upstream/repo.git (push)',
        ].join('\n'),
      },
    );
  });
  assertEquals(commands, [
    ['rev-parse', '--show-toplevel'],
    ['remote', '-v'],
  ]);
  assertEquals(identity, {
    canonicalKey: 'example.com/upstream/repo',
    locator: {
      source: 'git-remote',
      remoteName: 'upstream',
      remoteUrl: 'git@example.com:upstream/repo.git',
    },
    displayName: 'upstream/repo',
    name: 'repo',
  });
});
