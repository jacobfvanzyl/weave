import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { recoverStaleSocket } from './local-socket.ts';
import { AgentProcess } from './agent-process.ts';
import { diagnose } from './diagnostics.ts';

test('stale ACP recovery preserves files and live gateways, and recovers a killed listener', async () => {
  const root = await mkdtemp('/tmp/weave-socket-');
  const path = join(root, 'acp.sock');
  try {
    await writeFile(path, 'preserve');
    await expect(recoverStaleSocket(path)).rejects.toThrow('not an owned Unix socket');
    expect(await Bun.file(path).text()).toBe('preserve');
    await rm(path);
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(path, resolve));
    await expect(recoverStaleSocket(path)).rejects.toThrow('Another Host');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const child = Bun.spawn([process.execPath, '-e', "require('node:net').createServer().listen(process.argv[1],()=>console.log('ready'))", path], { stdout: 'pipe' });
    const reader = child.stdout.getReader();
    await reader.read();
    child.kill('SIGKILL');
    await child.exited;
    expect((await lstat(path)).isSocket()).toBe(true);
    await recoverStaleSocket(path);
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Host shutdown bounds a provider that ignores SIGTERM and reaps its descendants', async () => {
  const root = await mkdtemp('/tmp/weave-provider-stop-');
  const pidFile = join(root, 'pid');
  const source = `process.on('SIGTERM',()=>{}); const child=Bun.spawn([process.execPath,'-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdout:'ignore',stderr:'ignore'}); await Bun.write(process.argv[1],String(child.pid)); setInterval(()=>{},1000);`;
  const agent = new AgentProcess({ agentId: 'stubborn', name: 'Stubborn', command: process.execPath, args: ['-e', source, pidFile], env: {} }, root, () => undefined);
  try {
    for (let n = 0; n < 100 && !await Bun.file(pidFile).exists(); n++) await Bun.sleep(10);
    const pid = Number(await Bun.file(pidFile).text());
    const start = Date.now();
    await agent.close();
    expect(Date.now() - start).toBeLessThan(4000);
    for (let n = 0; n < 100; n++) {
      try { process.kill(pid, 0); await Bun.sleep(10); } catch { break; }
    }
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await agent.close(); await rm(root, { recursive: true, force: true }); }
}, 10000);

test('diagnostics separates filesystem, provider, trust and network failures', async () => {
  const root = await mkdtemp('/tmp/weave-diagnose-');
  try {
    const result = await diagnose({ displayName: 'Test', listen: { hostname: '127.0.0.1', port: 0 }, stateDirectory: root, allowedOrigins: [], workspaces: [{ workspaceId: 'missing', name: 'Missing', path: join(root, 'missing') }], agents: [{ agentId: 'missing', name: 'Missing', command: join(root, 'no-provider'), args: [], env: {} }] });
    expect(result.checks.find((check) => check.area === 'host')?.ok).toBe(true);
    expect(result.checks.find((check) => check.area === 'trust')?.ok).toBe(true);
    for (const area of ['filesystem', 'acp-provider', 'network']) expect(result.checks.find((check) => check.area === area)?.ok).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
