import { TerminalServiceClient } from '../src/terminal-service/client.ts';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { pairPortalCredential, RpcSocket, waitFor as pollUntil } from './rpc-client.ts';

// Deliberately consumes distributable binaries; no source checkout or Bun CLI
// is needed when this harness is itself compiled for the destination platform.
const [hostPath, agentPath] = process.argv.slice(2).map((path) => resolve(path));
assert(hostPath && agentPath, 'Usage: packaged-acceptance <host binary> <fixture agent binary>');
const waitFor: typeof pollUntil = async (predicate, timeoutMs) => {
  const caller = new Error(`Packaged acceptance condition did not complete: ${predicate}`);
  try { await pollUntil(predicate, timeoutMs); } catch (error) { caller.cause = error; throw caller; }
};
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
  executionContexts: [{ executionContextId: 'workspace', name: 'Workspace', path: workspacePath }],
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
  host = Bun.spawn([hostPath, 'serve', '--config', configPath], { env: { ...process.env, HOME: root, SHELL: '/bin/bash' }, stdout: Bun.file(join(root, 'host.log')), stderr: Bun.file(join(root, 'host-error.log')) });
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
  const thread = (await rpc.request('thread.create', { executionContextId: 'workspace', agentId: 'fixture', title: 'Packaged runtime' }) as any).thread;
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
  terminalId = (await rpc.request('terminal.create', { executionContextId: 'workspace', cols: 90, rows: 28 }) as any).terminal.terminalId;
  const terminalArgs = { executionContextId: 'workspace', terminalId };
  const terminalText = (socket: RpcSocket) => socket.notifications.flatMap((message: any) => message.params?.event?.type === 'output' ? [new TextDecoder().decode(message.params.event.data)] : []).join('');
  let shellPid = '';
  const controller = await rpc.request('terminal.attach', { ...terminalArgs, mode: 'shared' }) as any;
  const observer = await RpcSocket.open(`${url}/rpc`, credential);
  try {
    await observer.request('terminal.attach', { ...terminalArgs, mode: 'observe' });
    const second = await observer.request('terminal.attach', { ...terminalArgs, mode: 'shared' }) as any;
    await rpc.request('terminal.input', { ...terminalArgs, attachmentId: controller.attachment.attachmentId, data: new TextEncoder().encode("printf 'PACKAGED_TERMINAL:%s\\n' $$\r") });
    await waitFor(() => observer.notifications.some((message: any) => message.params?.event?.type === 'output' && new TextDecoder().decode(message.params.event.data).includes('PACKAGED_TERMINAL:')));
    await waitFor(() => /PACKAGED_TERMINAL:(\d+)/.test(terminalText(observer)));
    shellPid = /PACKAGED_TERMINAL:(\d+)/.exec(terminalText(observer))![1];
    await rpc.request('terminal.resize', { ...terminalArgs, attachmentId: controller.attachment.attachmentId, cols: 101, rows: 31 });
    await observer.request('terminal.resize', { ...terminalArgs, attachmentId: second.attachment.attachmentId, cols: 60, rows: 18 });
    const queryPath = join(root, 'queries.py');
    await writeFile(queryPath, `import os, tty, termios, select, time, json
old=termios.tcgetattr(0)
results=[]
try:
 tty.setraw(0)
 for parts in [(b'\\x1b[', b'c'), (b'\\x1b[5n',), (b'\\x1b[6n',), (b'\\x1b[?25h\\x1b[?25$p',)]:
  for part in parts:
   os.write(1,part); time.sleep(0.01)
  data=b''
  while select.select([0],[],[],0.2)[0]: data+=os.read(0,4096)
  results.append(data.hex())
finally: termios.tcsetattr(0,termios.TCSANOW,old)
print('QUERY_RESULTS:'+json.dumps(results))
`);
    await rpc.request('terminal.input', { ...terminalArgs, attachmentId: controller.attachment.attachmentId, data: new TextEncoder().encode(`python3 '${queryPath}'\r`) });
    await waitFor(() => /QUERY_RESULTS:(\[[^\r\n]+\])/.test(terminalText(observer)));
    const replies = JSON.parse(/QUERY_RESULTS:(\[[^\r\n]+\])/.exec(terminalText(observer))![1]);
    assert.equal(replies[0], '1b5b3f36323b323263', 'One DA reply with multiple attachments');
    assert.equal(replies[1], '1b5b306e', 'One status reply');
    assert.match(Buffer.from(replies[2], 'hex').toString(), /^\x1b\[\d+;\d+R$/, 'One cursor reply');
    assert.equal(Buffer.from(replies[3], 'hex').toString(), '\x1b[?25;1$y', 'One mode reply');
    const afterQueries = await rpc.request('terminal.snapshot', terminalArgs) as any;
    assert.deepEqual([afterQueries.snapshot.terminal.cols, afterQueries.snapshot.terminal.rows], [101, 31], 'Replies and passive views cannot claim size');

  } finally { observer.close(); }
  const composition = await rpc.request('workspace.composition.replace', { hostId: initialHealth.hostId, expectedRevision: 1, workspaces: [
    { workspaceId: thread.workspaceId, name: 'Same directory', layout: { kind: 'terminal', nodeId: 'node', paneId: 'pane', terminalId, executionContextId: 'workspace' } },
    { workspaceId: 'second', name: 'Same directory', layout: { kind: 'terminal', nodeId: 'second-node', paneId: 'second-pane', terminalId: null, executionContextId: 'workspace' } },
  ] });
  await rpc.request('thread.assign', { hostId: initialHealth.hostId, threadId: thread.threadId, workspaceId: 'second', expectedRevision: 0 });
  await assert.rejects(rpc.request('workspace.composition.get', { hostId: 'another-host' }));
  await assert.rejects(rpc.request('workspace.composition.replace', { workspaceId: 'workspace', expectedRevision: 0, tabs: [] }));
  acp.close(); rpc.close();
  await stop();
  const secondHealth = await start();
  assert.equal(secondHealth.hostId, initialHealth.hostId);
  rpc = await RpcSocket.open(`${url}/rpc`, credential);
  assert.deepEqual(await rpc.request('workspace.composition.get', { hostId: initialHealth.hostId }), composition);
  const listedThreads = (await rpc.request('thread.list') as any).threads;
  assert.equal(listedThreads.find((item: any) => item.threadId === thread.threadId).workspaceId, 'second');
  assert.equal(listedThreads.find((item: any) => item.threadId === thread.threadId).executionContextId, 'workspace');
  let restored = await rpc.request('terminal.attach', { ...terminalArgs, mode: 'shared' }) as any;
  assert.equal(new TextDecoder().decode(restored.snapshot.data.subarray(0,8)), 'GHOSTSNP');
  assert(restored.snapshot.historyToken && restored.snapshot.historyPages > 0);
  for (let page = 0; page < restored.snapshot.historyPages; page++) { const history = await rpc.request('terminal.history', { ...terminalArgs, attachmentId: restored.attachment.attachmentId, token: restored.snapshot.historyToken, page }) as any; assert(history.data instanceof Uint8Array); }
  await rpc.request('terminal.input', { ...terminalArgs, attachmentId: restored.attachment.attachmentId, data: new TextEncoder().encode("printf 'PID_AFTER:%s\\n' $$\r") });
  await waitFor(() => terminalText(rpc!).includes(`PID_AFTER:${shellPid}`));
  rpc.close(); host!.kill('SIGKILL'); await host!.exited; host = undefined;
  await start(); rpc = await RpcSocket.open(`${url}/rpc`, credential);
  restored = await rpc.request('terminal.attach', { ...terminalArgs, mode: 'shared' }) as any;
  await rpc.request('terminal.input', { ...terminalArgs, attachmentId: restored.attachment.attachmentId, data: new TextEncoder().encode("printf 'PID_ABRUPT:%s\\n' $$\r") });
  await waitFor(() => terminalText(rpc!).includes(`PID_ABRUPT:${shellPid}`));
  acp = await connectAcp();
  assert(JSON.stringify(acp.notifications).includes('PACKAGED_BEFORE_RESTART'));
  await prompt('PACKAGED_AFTER_RESTART');
  const connector = Bun.spawn([hostPath, 'acp', 'connect', '--config', configPath, '--agent', 'fixture', '--context', 'workspace'], {
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
  const { plan } = await rpc.request('workspace.close.preview', { hostId: initialHealth.hostId, workspaceId: 'second' }) as any;
  await assert.rejects(rpc.request('workspace.close', { hostId: initialHealth.hostId, workspaceId: 'second', token: plan.token, confirmed: false }));
  await rpc.request('workspace.close', { hostId: initialHealth.hostId, workspaceId: 'second', token: plan.token, confirmed: true });
  assert.equal((await rpc.request('thread.list', { status: 'archived' }) as any).threads[0].acpSessionId, thread.acpSessionId);
  assert.deepEqual((await rpc.request('workspace.composition.get', { hostId: initialHealth.hostId }) as any).composition.workspaces, []);
  // Losing the PTY owner is a different event from restarting the Host. The
  // public API must preserve membership until deliberate loss maintenance.
  const doomed = (await rpc.request('terminal.create', { executionContextId: 'workspace' }) as any).terminal;
  const liveComposition = (await rpc.request('workspace.composition.get', { hostId: initialHealth.hostId }) as any).composition;
  await rpc.request('workspace.composition.replace', { hostId: initialHealth.hostId, expectedRevision: liveComposition.revision, workspaces: [{ workspaceId: 'owner-loss', name: 'Owner loss', layout: { kind: 'terminal', nodeId: 'loss-node', paneId: 'loss-pane', terminalId: doomed.terminalId, executionContextId: 'workspace' } }] });
  const compositionFiles = await readdir(join(root, 'state/compositions'));
  const durableComposition = await Promise.all(compositionFiles.map(file => readFile(join(root, 'state/compositions', file), 'utf8')));
  const owner = JSON.parse(await readFile(join(root, 'state/terminal-service.json'), 'utf8'));
  process.kill(owner.ownerPid, 'SIGKILL');
  await Bun.sleep(100);
  await assert.rejects(rpc.request('terminal.list', { executionContextId: 'workspace' }), /owner unavailable|disconnected|unavailable/i);
  await assert.rejects(rpc.request('workspace.composition.get', { hostId: initialHealth.hostId }), /owner unavailable|unavailable/i);
  assert.deepEqual(await Promise.all(compositionFiles.map(file => readFile(join(root, 'state/compositions', file), 'utf8'))), durableComposition, 'Unavailable registry must preserve durable Pane membership');
  const maintenance = Bun.spawn([hostPath, 'terminal', 'accept-owner-loss', '--config', configPath, '--confirm-loss'], { stdout: 'pipe', stderr: 'pipe' });
  const maintenanceError = await new Response(maintenance.stderr).text();
  assert.equal(await maintenance.exited, 0, maintenanceError);
  assert.deepEqual((await rpc.request('terminal.list', { executionContextId: 'workspace' }) as any).terminals, []);
  acp.close(); rpc.close();
  await stop();
  assert((await readFile(processLog, 'utf8')).includes('stop '), 'Host must signal its provider');
  succeeded = true;
  console.log(JSON.stringify({ passed: true, platform: process.platform, arch: process.arch, authenticated: true, providerRecovery: true, hostRestart: true, persistentTerminal: true, shellPid, abruptDaemonRestart: true, ownerLossMaintenance: true, singleQueryReplies: true, workspaceRestoration: true, threadAssignment: true, controllerObserver: true, localAcp: true, signalShutdown: true, workspaceClose: true }));
} catch (error) {
  await writeFile(join(root, 'terminal-output.json'), JSON.stringify(rpc?.notifications.filter((message: any) => message.params?.event?.type === 'output').map((message: any) => new TextDecoder().decode(message.params.event.data))), { mode: 0o600 });
  throw error;
} finally {
  acp?.close(); rpc?.close();
  await stop();
  const terminalService = new TerminalServiceClient(join(root, 'state'), join(resolve(hostPath, '..'), 'weave-terminal-service'));
  try { for (const terminal of await terminalService.list()) await terminalService.request({ method: 'close', terminalId: terminal.terminalId }); await terminalService.request({ method: 'shutdown' }); } catch (error) { console.error('Isolated service cleanup:', String(error)); } finally { terminalService.dispose(); }
  if (succeeded) await rm(root, { recursive: true });
  else console.error(`Acceptance artifacts retained at ${root}; terminal=${terminalId ?? 'none'}`);
}
