import { assertEquals, assertMatch } from 'jsr:@std/assert@1.0.19';
import {
  checkPortalRuntimeHealth,
  getPortalConfigPath,
  getPortalRuntimeLockPath,
  getPortalRuntimePath,
  maskPortalRuntime,
  type PortalRuntimeFile,
  readPortalRuntime,
  removePortalRuntime,
  resolvePortalHome,
  runtimeMatchesServer,
  tryAcquirePortalRuntimeLock,
  writePortalRuntime,
} from './lifecycle.ts';

Deno.test('Portal home resolves to WEAVE_PORTAL_HOME first', () => {
  const home = resolvePortalHome({
    WEAVE_PORTAL_HOME: '/tmp/custom-portal',
    HOME: '/Users/example',
    XDG_CONFIG_HOME: '/tmp/config',
  });
  assertEquals(home, '/tmp/custom-portal');
});

Deno.test('Portal home defaults to ~/.config on macOS and Linux', () => {
  const env = { HOME: '/Users/example' };
  assertEquals(resolvePortalHome(env), '/Users/example/.config/weave/portal');
  assertEquals(getPortalConfigPath(env), '/Users/example/.config/weave/portal/config.json');
  assertEquals(getPortalRuntimePath(env), '/Users/example/.config/weave/portal/runtime.json');
});

Deno.test('Portal runtime writes 0600, masks token, and can be removed', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'weave-runtime-' });
  const path = `${directory}/runtime.json`;
  const runtime: PortalRuntimeFile = {
    version: 1,
    pid: 123,
    portalId: 'portal_123',
    configPath: `${directory}/config.json`,
    httpServerUrl: 'http://localhost:4111',
    wsServerUrl: 'ws://localhost:4112',
    controlHost: '127.0.0.1',
    controlPort: 49321,
    controlToken: 'abcdefghijklmnopqrstuvwxyz',
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };

  try {
    await writePortalRuntime(path, runtime);
    assertEquals(await readPortalRuntime(path), runtime);
    const stat = await Deno.stat(path);
    if (stat.mode !== null) assertEquals(stat.mode & 0o777, 0o600);
    assertEquals(maskPortalRuntime(runtime)?.controlToken, 'abcd...wxyz');
    assertEquals(runtimeMatchesServer(runtime, 'http://localhost:4111/', 'ws://localhost:4112/'), true);
    assertEquals((await checkPortalRuntimeHealth(runtime)).ok, false);
    await removePortalRuntime(path);
    assertEquals(await readPortalRuntime(path), undefined);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Portal runtime ignores malformed files', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'weave-runtime-bad-' });
  const path = `${directory}/runtime.json`;
  try {
    await Deno.writeTextFile(path, '{"version":1}');
    assertEquals(await readPortalRuntime(path), undefined);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('Portal runtime preserves XDG_CONFIG_HOME', () => {
  assertMatch(
    resolvePortalHome({ HOME: '/home/example', XDG_CONFIG_HOME: '/state/config' }),
    /^\/state\/config\/weave\/portal$/,
  );
});

Deno.test('Portal runtime writes remain atomic under replacement races', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'weave-runtime-atomic-' });
  const path = `${directory}/runtime.json`;
  const runtime = (pid: number): PortalRuntimeFile => ({
    version: 1,
    pid,
    portalId: `portal_${pid}`,
    configPath: `${directory}/config.json`,
    httpServerUrl: 'http://localhost:4111',
    wsServerUrl: 'ws://localhost:4112',
    controlHost: '127.0.0.1',
    controlPort: 49000 + pid,
    controlToken: `token-${pid}`,
    startedAt: new Date(pid).toISOString(),
    updatedAt: new Date(pid).toISOString(),
  });

  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) => writePortalRuntime(path, runtime(index))));
    const written = await readPortalRuntime(path);
    assertEquals(typeof written?.pid, 'number');
    assertEquals(written?.portalId, `portal_${written?.pid}`);
    const entries = await Array.fromAsync(Deno.readDir(directory));
    assertEquals(entries.map((entry) => entry.name), ['runtime.json']);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Portal runtime cleanup only removes the owning daemon runtime', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'weave-runtime-owner-' });
  const path = `${directory}/runtime.json`;
  const older: PortalRuntimeFile = {
    version: 1,
    pid: 100,
    portalId: 'portal_old',
    configPath: `${directory}/config.json`,
    httpServerUrl: 'http://localhost:4111',
    wsServerUrl: 'ws://localhost:4112',
    controlHost: '127.0.0.1',
    controlPort: 49100,
    controlToken: 'old-token',
    startedAt: new Date(100).toISOString(),
    updatedAt: new Date(100).toISOString(),
  };
  const replacement: PortalRuntimeFile = {
    ...older,
    pid: 200,
    portalId: 'portal_new',
    controlPort: 49200,
    controlToken: 'new-token',
    startedAt: new Date(200).toISOString(),
    updatedAt: new Date(200).toISOString(),
  };

  try {
    await writePortalRuntime(path, replacement);
    assertEquals(await removePortalRuntime(path, older), false);
    assertEquals(await readPortalRuntime(path), replacement);
    assertEquals(await removePortalRuntime(path, replacement), true);
    assertEquals(await readPortalRuntime(path), undefined);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Portal runtime lock is exclusive for the daemon lifetime', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'weave-runtime-lock-' });
  const runtimePath = `${directory}/runtime.json`;
  try {
    const first = await tryAcquirePortalRuntimeLock(runtimePath);
    assertEquals(Boolean(first), true);
    assertEquals(await tryAcquirePortalRuntimeLock(runtimePath), undefined);
    const lockStat = await Deno.stat(getPortalRuntimeLockPath(runtimePath));
    if (lockStat.mode !== null) assertEquals(lockStat.mode & 0o777, 0o600);

    await first?.release();
    const replacement = await tryAcquirePortalRuntimeLock(runtimePath);
    assertEquals(Boolean(replacement), true);
    await replacement?.release();
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
