import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { chmod, readText, removePath, stat, temporaryDirectory, writeText } from './host-files.ts';
import { runProcess } from './host-process.ts';
import { Portal } from './portal.ts';
import { startPortalServer } from './server.ts';
import { serveLocalAcpGateway } from './local-acp.ts';
import { InMemoryTerminalBackend } from './terminals.ts';
import { PORTAL_WEBSOCKET_PROTOCOL } from '@weave/product-protocol';

test('Bun subprocesses replace the environment, report exits, and drain both streams', async () => {
  process.env.WEAVE_RUNTIME_TEST_PRIVATE = 'must-not-inherit';
  try {
    const result = await runProcess(process.execPath, {
      args: ['-e', 'console.log(process.env.WEAVE_RUNTIME_TEST_PRIVATE ?? "absent"); console.error(process.env.ALLOWED); process.exit(7)'],
      env: { ALLOWED: 'present' },
    });
    expect(new TextDecoder().decode(result.stdout).trim()).toBe('absent');
    expect(new TextDecoder().decode(result.stderr).trim()).toBe('present');
    expect(result.code).toBe(7);
    expect(result.success).toBe(false);
    await expect(runProcess('/no/such/weave-executable')).rejects.toThrow();
  } finally { delete process.env.WEAVE_RUNTIME_TEST_PRIVATE; }
});

test('Host files preserve exclusive creation, append and private permissions', async () => {
  const root = await temporaryDirectory();
  try {
    const path = join(root, 'private');
    await writeText(path, 'one', { createNew: true, mode: 0o600 });
    await expect(writeText(path, 'replace', { createNew: true })).rejects.toHaveProperty('code', 'EEXIST');
    await writeText(path, 'two', { append: true });
    expect(await readText(path)).toBe('onetwo');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await chmod(root, 0o700);
  } finally { await removePath(root, { recursive: true }); }
});

test('Host shuts down open WebSockets and removes its private ACP socket before rebinding', async () => {
  const root = await temporaryDirectory({ dir: '/tmp', prefix: 'wve-runtime-' });
  const portal = await Portal.open({
    listen: { hostname: '127.0.0.1', port: 0 }, displayName: 'Runtime test', allowedOrigins: [],
    stateDirectory: root, workspaces: [{ workspaceId: 'test', name: 'Test', path: root }],
    agents: [{ agentId: 'test', name: 'Test', command: 'false', args: [], env: {} }],
  }, { terminalBackend: new InMemoryTerminalBackend() });
  const server = startPortalServer(portal);
  const gateway = await serveLocalAcpGateway(portal);
  try {
    expect((await stat(gateway.path)).mode & 0o777).toBe(0o600);
    const client = new WebSocket(`ws://127.0.0.1:${server.addr.port}/rpc`, PORTAL_WEBSOCKET_PROTOCOL);
    await new Promise((resolve, reject) => { client.onmessage = resolve; client.onerror = reject; });
    const closed = new Promise((resolve) => { client.onclose = resolve; });
    await server.shutdown();
    await closed;
    await gateway.close();
    await expect(stat(gateway.path)).rejects.toHaveProperty('code', 'ENOENT');
    const replacement = Bun.serve({ hostname: '127.0.0.1', port: server.addr.port, fetch: () => new Response('replacement') });
    expect(await (await fetch(`http://127.0.0.1:${replacement.port}`)).text()).toBe('replacement');
    await replacement.stop(true);
  } finally {
    await gateway.close();
    await server.shutdown();
    await portal.close();
    await removePath(root, { recursive: true });
  }
}, 5000);
