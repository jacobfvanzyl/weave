import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const host = resolve(process.argv[2] ?? 'product/portal/dist/weave-portal');
if (!Bun.which('tmux')) throw new Error('The one-time legacy cutover probe needs tmux; the new runtime does not.');
const root = await mkdtemp('/tmp/weave-cutover-');
const state = join(root, 'state'), socket = join(state, 'terminal/tmux.sock'), config = join(root, 'host.json');
await mkdir(join(state, 'terminal'), { recursive: true });
await writeFile(config, JSON.stringify({ listen: { hostname: '127.0.0.1', port: 0 }, stateDirectory: state, executionContexts: [{ executionContextId: 'fixture', name: 'Fixture', path: root }], agents: [{ agentId: 'fixture', name: 'Fixture', command: '/bin/false', args: [], env: {} }], allowedOrigins: [] }));
const run = async (command: string[]) => {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
};
const tmux = async (...args: string[]) => {
  const result = await run(['tmux', '-f', '/dev/null', '-S', socket, ...args]);
  assert.equal(result.code, 0, result.stderr); return result.stdout;
};
try {
  await tmux('new-session', '-d', '-s', '_weave_product', '/bin/sleep 120');
  await tmux('set-option', '-w', '-t', '_weave_product:0', '@weave_terminal_id', 'legacy-fixture');
  await tmux('new-session', '-d', '-s', 'unrelated', '/bin/sleep 120');
  const before = await tmux('list-panes', '-t', 'unrelated', '-F', '#{pane_pid}');
  const preflight = await run([host, 'terminal', 'preflight', '--config', config]);
  assert.equal(preflight.code, 0, preflight.stderr);
  assert.equal(JSON.parse(preflight.stdout).legacyTerminals[0].terminalId, 'legacy-fixture');
  const refusal = await run([host, 'terminal', 'cutover', '--config', config]);
  assert.notEqual(refusal.code, 0);
  await tmux('has-session', '-t', '_weave_product');
  const sentinel = join(state, 'preserved-test-credentials.json');
  await writeFile(sentinel, 'isolated credential preservation sentinel');
  const cutover = await run([host, 'terminal', 'cutover', '--config', config, '--confirm-stop']);
  assert.equal(cutover.code, 0, cutover.stderr);
  assert.equal(await tmux('list-panes', '-t', 'unrelated', '-F', '#{pane_pid}'), before);
  assert.equal(await readFile(sentinel, 'utf8'), 'isolated credential preservation sentinel');
  const after = await run([host, 'terminal', 'preflight', '--config', config]);
  assert.deepEqual(JSON.parse(after.stdout).legacyTerminals, []);
  console.log(JSON.stringify({ passed: true, refusalPreservesLegacyWork: true, confirmedStop: true, unrelatedTmuxPidPreserved: true, nonterminalStatePreserved: true }));
} finally {
  await run(['tmux', '-S', socket, 'kill-server']); // Dedicated fixture socket only.
  await rm(root, { recursive: true, force: true });
}
