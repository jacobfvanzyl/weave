import { assertEquals, assertMatch } from 'jsr:@std/assert@1.0.19';
import {
  checkPortalRuntimeHealth,
  getPortalConfigPath,
  getPortalRuntimePath,
  maskPortalRuntime,
  type PortalRuntimeFile,
  readPortalRuntime,
  removePortalRuntime,
  resolvePortalHome,
  runtimeMatchesServer,
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
