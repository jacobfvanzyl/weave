// @vitest-environment node
/// <reference types="bun" />
// The app's Host store making, using and removing a git worktree on a real dev Host
// (`testing/dev-host.ts`). Skipped unless the debug `weave` and fake agent are built.
import { mkdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostConnection, websocketConnector } from './connection';
import { type DeviceKey, webCryptoDeviceKey } from './device-key';
import { HostStore } from './host-store';
import { memoryStorage } from './storage';
import { devHostAvailable, startDevHost, unixConnector, type DevHost } from './testing/dev-host';

const waitFor = async <T,>(find: () => T | undefined, what: string, ms = 15_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await Bun.sleep(20);
  }
};

/** Git as the person runs it, away from the configuration of whoever runs the tests. */
const git = (dir: string, ...args: string[]) => {
  const run = Bun.spawnSync(['git', '-C', dir, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  if (!run.success) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
};

describe.skipIf(!devHostAvailable())('worktrees through the Host store with a dev Host', () => {
  let host: DevHost;
  let local: HostConnection;
  let store: HostStore;
  let repo: string;
  const keys = new Map<string, DeviceKey>();

  beforeAll(async () => {
    host = await startDevHost();
    const made = join(dirname(host.cwd), 'code', 'weave');
    await mkdir(made, { recursive: true });
    git(made, 'init', '-q', '-b', 'main');
    await Bun.write(join(made, 'README.md'), 'weave\n');
    git(made, 'add', 'README.md');
    git(made, 'commit', '-q', '-m', 'init');
    // As the Host gives it, symlinks resolved.
    repo = realpathSync(made);

    local = await HostConnection.connect({
      connector: unixConnector(host.socket),
      client: { name: 'weave-app-test', version: '0' },
      credentials: { method: 'local' },
      onEvent: () => {},
    });
    store = new HostStore({
      storage: memoryStorage(),
      keyFor: (keyId) => keys.get(keyId)!,
      async newKey() {
        const keyId = crypto.randomUUID();
        keys.set(keyId, await webCryptoDeviceKey());
        return { keyId, key: keys.get(keyId)! };
      },
      connectorFor: (url) => websocketConnector(url),
      client: { name: 'weave-app-test', version: '0' },
      deviceName: 'Test iPad',
      backoff: [50],
    });
    await store.start();
    const { code } = await local.request('devices/offer', {});
    await store.actions.pairHost({ url: host.url, code, name: 'Test iPad' });
  }, 60_000);

  afterAll(async () => {
    store?.stop();
    local?.close();
    await host?.stop();
  });

  it('makes a worktree beside the repository, starts a session in it, and removes it', async () => {
    const [paired] = store.snapshot().hosts;
    expect(paired).toMatchObject({ status: 'connected', canWorktree: true });
    const hostId = paired.id;
    expect(await store.actions.listWorktrees({ hostId, path: host.cwd })).toBeUndefined();
    const listed = await store.actions.listWorktrees({ hostId, path: repo });
    expect(listed).toEqual({
      repo,
      defaultBranch: 'main',
      worktrees: [{ path: repo, branch: 'main', primary: true, changes: false, sessions: [] }],
    });

    const path = await store.actions.createWorktree({ hostId, repo, branch: 'feature/auth' });
    expect(path).toBe(`${repo}.feature-auth`);
    await expect(store.actions.createWorktree({ hostId, repo, branch: 'feature/auth' })).rejects.toThrow(/checked out/);
    await store.actions.createSession({ hostId, cwd: path, agentId: 'fake' });
    const session = await waitFor(
      () => store.snapshot().sessions.find((summary) => summary.cwd === path),
      'the session in the worktree',
    );
    expect(session.git).toEqual({ repo, worktree: path, branch: 'feature/auth' });

    const removal = await store.actions.removeWorktree({ hostId, path });
    expect(removal).toEqual({ outcome: 'removed', branch: 'feature/auth', branchDeleted: true });
    expect(existsSync(path)).toBe(false);
    expect(git(repo, 'branch', '--list', 'feature/auth')).toBe('');
  });
});
