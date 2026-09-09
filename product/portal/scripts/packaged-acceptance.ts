import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { pairPortalCredential, RpcSocket, waitFor } from './rpc-client.ts';

// Deliberately consumes distributable binaries; no source checkout or Bun CLI
// is needed when this harness is itself compiled for the destination platform.
const [hostPath, agentPath] = process.argv.slice(2).map((path) => resolve(path));
assert(hostPath && agentPath, 'Usage: packaged-acceptance <host binary> <fixture agent binary>');
const root = await mkdtemp('/tmp/weave-packaged-');
const workspacePath = join(root, 'workspace');
await mkdir(workspacePath);
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
const port = reservation.port!;
await reservation.stop(true);
const url = `ws://127.0.0.1:${port}`;
const configPath = join(root, 'config.json');
const processLog = join(root, 'provider.log');
await writeFile(configPath, JSON.stringify({
  listen: { hostname: '127.0.0.1', port }, displayName: 'Packaged acceptance', allowedOrigins: [],
  stateDirectory: join(root, 'state'),
  workspaces: [{ workspaceId: 'workspace', name: 'Workspace', path: workspacePath }],
  agents: [{ agentId: 'fixture', name: 'Fixture', command: agentPath, args: [`--process-log=${processLog}`], env: {} }],
}), { mode: 0o600 });
let host: ReturnType<typeof Bun.spawn> | undefined;
let rpc: RpcSocket | undefined;
let acp: RpcSocket | undefined;
let terminalId: string | undefined;
let succeeded = false;
const stop = async () => {
  if (!host) return;
  host.kill('SIGTERM');
  const timer = setTimeout(() => host?.kill('SIGKILL'), 5000);
  const code = await host.exited;
  clearTimeout(timer);
  host = undefined;
  assert.equal(code, 0, 'SIGTERM must drain Host and ACP without force-killing');
};
const start = async () => {
  host = Bun.spawn([hostPath, 'serve', '--config', configPath], { stdout: Bun.file(join(root, 'host.log')), stderr: Bun.file(join(root, 'host-error.log')) });
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; }
  });
  return await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { hostId: string };
};
try {
  const initialHealth = await start();
  const pairing = Bun.spawn([hostPath, 'pairing', 'create', '--config', configPath], { stdout: 'pipe', stderr: 'pipe' });
  const token = (await new Response(pairing.stdout).text()).trim();
  assert.equal(await pairing.exited, 0);
  const credential = await pairPortalCredential(url, token, 'Packaged acceptance');
  rpc = await RpcSocket.open(`${url}/rpc`, credential);
  const thread = (await rpc.request('thread.create', { workspaceId: 'workspace', agentId: 'fixture', title: 'Packaged runtime' }) as any).thread;
  const connectAcp = async () => {
    const attachment = await rpc!.request('thread.attach', { threadId: thread.threadId }) as any;
    const socket = await RpcSocket.open(`${url}${attachment.connection.path}?threadId=${encodeURIComponent(thread.threadId)}`, credential);
    await socket.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await socket.request('session/load', { sessionId: thread.acpSessionId, cwd: workspacePath, mcpServers: [], _meta: { 'weave.dev/threadEvents': { afterSequence: 0 } } });
    return socket;
  };
  acp = await connectAcp();
  const prompt = (text: string) => acp!.request('session/prompt', { sessionId: thread.acpSessionId, prompt: [{ type: 'text', text }] });
  await prompt('PACKAGED_BEFORE_RESTART');
  assert(JSON.stringify(acp.notifications).includes('PACKAGED_BEFORE_RESTART'));
  await assert.rejects(prompt('CRASH_WITH_STALE'), (error: any) => error.data?.code === 'PROMPT_UNCERTAIN');
  await waitFor(() => acp!.notifications.some((message: any) => message.params?.code === 'RECOVERED'));
  await Bun.sleep(150);
  assert(!JSON.stringify(acp.notifications).includes('OBSOLETE_PROVIDER_EVENT'));
  await prompt('PACKAGED_RECOVERED');
  terminalId = (await rpc.request('terminal.create', { workspaceId: 'workspace', cols: 90, rows: 28 }) as any).terminal.terminalId;
  const terminalArgs = { workspaceId: 'workspace', terminalId };
  const controller = await rpc.request('terminal.attach', { ...terminalArgs, mode: 'control' }) as any;
  const observer = await RpcSocket.open(`${url}/rpc`, credential);
  try {
    await observer.request('terminal.attach', { ...terminalArgs, mode: 'observe' });
    await assert.rejects(observer.request('terminal.attach', { ...terminalArgs, mode: 'control' }), (error: any) => error.data?.code === 'TERMINAL_CONTROLLED');
    await rpc.request('terminal.input', { ...terminalArgs, attachmentId: controller.attachment.attachmentId, data: "printf 'PACKAGED_TERMINAL\\n'\r" });
    await waitFor(() => JSON.stringify(observer.notifications).includes('PACKAGED_TERMINAL'));
    await rpc.request('terminal.resize', { ...terminalArgs, attachmentId: controller.attachment.attachmentId, cols: 101, rows: 31 });
  } finally { observer.close(); }
  acp.close(); rpc.close();
  await stop();
  const secondHealth = await start();
  assert.equal(secondHealth.hostId, initialHealth.hostId);
  rpc = await RpcSocket.open(`${url}/rpc`, credential);
  assert(JSON.stringify(await rpc.request('thread.list')).includes(thread.threadId));
  const restored = await rpc.request('terminal.attach', { ...terminalArgs, mode: 'control' }) as any;
  assert(restored.snapshot.data.includes('PACKAGED_TERMINAL'));
  acp = await connectAcp();
  assert(JSON.stringify(acp.notifications).includes('PACKAGED_BEFORE_RESTART'));
  await prompt('PACKAGED_AFTER_RESTART');
  const connector = Bun.spawn([hostPath, 'acp', 'connect', '--config', configPath, '--agent', 'fixture', '--workspace', 'workspace'], {
    stdin: new Blob(['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}\n{"jsonrpc":"2.0","id":2,"method":"session/list","params":{}}\n']), stdout: 'pipe', stderr: 'pipe',
  });
  const connected = await new Response(connector.stdout).text();
  assert.equal(await connector.exited, 0);
  const listed = connected.trim().split('\n').map((line) => JSON.parse(line)).find((message) => message.id === 2).result.sessions;
  assert.equal(listed.length, 1);
  assert.deepEqual(JSON.parse(Buffer.from(listed[0].sessionId.slice('weave-v1:'.length), 'base64url').toString()), [initialHealth.hostId, thread.threadId]);
  assert.equal((await stat(join(root, 'state', 'security.json'))).mode & 0o777, 0o600);
  await rpc.request('terminal.close', { ...terminalArgs, attachmentId: restored.attachment.attachmentId });
  terminalId = undefined;
  acp.close(); rpc.close();
  await stop();
  assert((await readFile(processLog, 'utf8')).includes('stop '), 'Host must signal its provider');
  succeeded = true;
  console.log(JSON.stringify({ passed: true, platform: process.platform, arch: process.arch, authenticated: true, providerRecovery: true, hostRestart: true, persistentTerminal: true, controllerObserver: true, localAcp: true, signalShutdown: true }));
} finally {
  acp?.close(); rpc?.close();
  await stop();
  if (succeeded) await rm(root, { recursive: true });
  else console.error(`Acceptance artifacts retained at ${root}; terminal=${terminalId ?? 'none'}`);
}
