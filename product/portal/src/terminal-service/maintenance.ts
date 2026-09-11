import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TerminalServiceClient } from './client.ts';
import { TERMINAL_SERVICE_VERSION, TERMINAL_CODEC } from './contract.ts';

const exists = async (path: string) => { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } };
// One-time preflight for the retired installation. No legacy runtime operations
// are dispatched through the live Terminal Service contract.
const legacySockets = (stateDirectory: string) => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(stateDirectory)) { hash ^= BigInt(byte); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return [join(stateDirectory, 'terminal/tmux.sock'), `/tmp/weave-product-tmux-${hash.toString(16).padStart(16,'0')}.sock`];
};
const tmux = async (socket: string, args: string[]) => {
  const process = Bun.spawn(['tmux', '-S', socket, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code !== 0 && !/no server running|error connecting|No such file/i.test(stderr)) throw new Error(`Legacy preflight failed: ${stderr.trim()}`);
  return code === 0 ? stdout : '';
};
export async function legacyTerminals(stateDirectory: string) {
  const records: { socket: string; window: string; terminalId: string; command: string }[] = [];
  for (const socket of legacySockets(stateDirectory)) {
    if (!await exists(socket)) continue;
    const output = await tmux(socket, ['list-panes', '-a', '-F', '#{session_name}\t#{window_id}\t#{@weave_terminal_id}\t#{pane_current_command}']);
    for (const line of output.split('\n')) {
      const [session, window, terminalId, command] = line.split('\t');
      if (session === '_weave_product' && /^@\d+$/.test(window ?? '') && terminalId) records.push({ socket, window, terminalId, command });
    }
  }
  return records;
}
export async function assertLegacyCutover(stateDirectory: string) {
  if (await exists(join(stateDirectory, 'terminal-cutover.json'))) return;
  const terminals = await legacyTerminals(stateDirectory);
  if (terminals.length) throw new Error(`Cutover requires closing ${terminals.length} legacy Weave Terminals. Run terminal preflight and deliberately close them before updating; current work was preserved.`);
}
export async function terminalMaintenance(stateDirectory: string, action: string, flags: string[]) {
  if (action === 'preflight' || action === 'cutover') {
    const terminals = await legacyTerminals(stateDirectory);
    console.log(JSON.stringify({ legacyTerminals: terminals.map(({ socket: _socket, ...record }) => record) }, null, 2));
    if (action === 'preflight') return;
    if (terminals.length && !flags.includes('--confirm-stop')) throw new Error('Cutover will stop the listed work. Close it deliberately or pass --confirm-stop after approval.');
    for (const terminal of terminals) await tmux(terminal.socket, ['send-keys', '-t', terminal.window, 'C-c']);
    if (terminals.length) await Bun.sleep(500);
    for (const terminal of await legacyTerminals(stateDirectory)) await tmux(terminal.socket, ['kill-window', '-t', terminal.window]);
    if ((await legacyTerminals(stateDirectory)).length) throw new Error('Legacy Terminals remain; cutover aborted');
    await writeFile(join(stateDirectory, 'terminal-cutover.json'), JSON.stringify({ completedAt: new Date().toISOString() }), { mode: 0o600 });
    console.log('Legacy Weave Terminals are closed. Start the new Host to reconcile their Pane references. Conversations, credentials and unrelated sessions are preserved.');
    return;
  }
  if (action === 'accept-owner-loss') {
    if (!flags.includes('--confirm-loss')) throw new Error('Owner-loss maintenance requires --confirm-loss; live process restoration is not possible.');
    const path = join(stateDirectory, 'terminal-service.json');
    const previous = JSON.parse(await readFile(path, 'utf8'));
    if (!Number.isInteger(previous.ownerPid)) throw new Error('Unrecognized service registry');
    try { process.kill(previous.ownerPid, 0); throw new Error('Recorded owner PID is still alive; inspect it before maintenance'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    await rename(path, `${path}.lost-${Date.now()}`);
    await writeFile(path, JSON.stringify({ version: TERMINAL_SERVICE_VERSION, codec: TERMINAL_CODEC, terminals: [] }), { mode: 0o600 });
    console.log('Lost owner registry preserved as a backup. Starting the Host will remove confirmed lost Terminal Panes.');
    return;
  }
  if (action !== 'status' && action !== 'stop') throw new Error('Unknown Terminal Service maintenance action');
  const client = new TerminalServiceClient(stateDirectory);
  try {
    const terminals = await client.list();
    if (action === 'status') { console.log(JSON.stringify({ generation: client.generation, terminals }, null, 2)); return; }
    if (terminals.length && !flags.includes('--confirm-stop')) throw new Error('Terminal Service stop requires deliberate closure of live Terminals or --confirm-stop');
    for (const terminal of terminals) await client.request({ method: 'close', terminalId: terminal.terminalId });
    await client.request({ method: 'shutdown' });
    console.log('Terminal Service stopped.');
  } finally { client.dispose(); }
}
