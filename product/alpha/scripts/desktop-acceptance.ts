import { TerminalServiceClient } from '../../portal/src/terminal-service/client.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const [hostArg, agentArg] = process.argv.slice(2);
assert(hostArg && agentArg, 'Usage: desktop-acceptance <compiled Host> <compiled fixture agent>');
const hostPath = resolve(hostArg);
const agentPath = resolve(agentArg);
const providerConfig = process.env.WEAVE_ACCEPTANCE_PROVIDER_CONFIG;
const provider = providerConfig ? JSON.parse(await readFile(providerConfig, 'utf8')) : { command: agentPath, args: [] };
const root = await mkdtemp('/tmp/weave-desktop-');
const workspace = join(root, 'workspace');
await mkdir(workspace);
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
const port = reservation.port!;
await reservation.stop(true);
const config = join(root, 'host.json');
await writeFile(config, JSON.stringify({ listen: { hostname: '127.0.0.1', port }, displayName: 'Desktop acceptance', allowedOrigins: ['weave://app'], stateDirectory: join(root, 'state'), executionContexts: [{ executionContextId: 'desktop', name: 'Desktop acceptance', path: workspace }], agents: [{ agentId: 'fixture', name: 'Acceptance', command: provider.command, args: provider.args ?? [], env: {} }] }), { mode: 0o600 });
const host = Bun.spawn([hostPath, 'serve', '--config', config], { stdout: Bun.file(join(root, 'host.log')), stderr: Bun.file(join(root, 'host-error.log')) });
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* Starting */ }
    await Bun.sleep(50);
  }
  const pairing = Bun.spawn([hostPath, 'pairing', 'create', '--config', config], { stdout: 'pipe', stderr: 'pipe' });
  const token = (await new Response(pairing.stdout).text()).trim();
  assert.equal(await pairing.exited, 0);
  for (const phase of (providerConfig ? ['pair'] : ['pair', 'reconnect'])) {
    await writeFile(join(root, 'input.json'), JSON.stringify({ hostUrl: `ws://127.0.0.1:${port}`, ...(phase === 'pair' ? { pairingToken: token } : {}), workspaceName: 'Desktop acceptance', directory: await realpath(workspace), permission: !providerConfig }), { mode: 0o600 });
    const app = Bun.spawn([resolve(import.meta.dir, `../release/Weave Alpha-darwin-${process.arch}/Weave Alpha.app/Contents/MacOS/Weave Alpha`), '--host-acceptance'], { env: { ...process.env, WEAVE_ALPHA_ACCEPTANCE_DIR: root }, stdout: Bun.file(join(root, `electron-${phase}.log`)), stderr: Bun.file(join(root, `electron-${phase}-error.log`)) });
    assert.equal(await app.exited, 0, `Desktop ${phase} acceptance failed; evidence at ${root}`);
    const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'));
    assert.equal(result.passed, true);
    await writeFile(join(root, `${phase}.json`), JSON.stringify(result));
    await Bun.write(join(root, `${phase}.png`), Bun.file(join(root, 'shell.png')));
    console.log(JSON.stringify({ phase, ...result }));
  }
} finally {
  host.kill('SIGTERM');
  const timer = setTimeout(() => host.kill('SIGKILL'), 5000);
  await host.exited;
  clearTimeout(timer);
  const terminals = new TerminalServiceClient(join(root, 'state'), join(resolve(hostPath, '..'), 'weave-terminal-service'));
  try { for (const terminal of await terminals.list()) await terminals.request({ method: 'close', terminalId: terminal.terminalId }); await terminals.request({ method: 'shutdown' }); } finally { terminals.dispose(); }
  await rm(join(root, 'input.json'), { force: true });
  console.log(`Evidence: ${root}`);
}
