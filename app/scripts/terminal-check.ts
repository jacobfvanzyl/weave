/// <reference types="bun" />
// Checks the native terminal in a simulator against a dev Host (WVE-153): the app's debug
// `--terminal-stream` opens one terminal's stream over the whole window, and the Host's side types
// into it, floods it and reads its screen, while screenshots record what the app drew.
//
//   bun scripts/terminal-check.ts [--simulator "<name>"] [--out <dir>]
//
// Build first: `bun run cap:sync && bun scripts/ios.ts build --simulator "<name>"`, and the debug
// `weave`, fake agent and holder (`cargo build -p weave-cli -p weave-fake-agent -p weave-holder`).
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HostConnection } from '../src/host/connection';
import { startDevHost, unixConnector } from '../src/host/testing/dev-host';

const root = resolve(import.meta.dir, '..');
const option = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const simulator = option('simulator', 'iPad Pro 11-inch (M5)');
const out = option('out', '/Volumes/External/Build/weave-terminal-check');
const bundleId = 'com.veezee.weave';

const run = (args: string[]) => {
  const child = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
  return { ok: child.success, out: child.stdout.toString().trim(), err: child.stderr.toString().trim() };
};
const must = (args: string[]) => {
  const result = run(args);
  if (!result.ok) throw new Error(`${args.join(' ')}: ${result.err}`);
  return result.out;
};
const until = async <T>(what: string, find: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await find();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await Bun.sleep(200);
  }
};

const settings = must(['xcodebuild', '-project', resolve(root, 'ios/App/App.xcodeproj'), '-scheme', 'App', '-configuration', 'Debug',
  '-destination', `platform=iOS Simulator,name=${simulator}`, '-showBuildSettings']);
const setting = (key: string) => settings.match(new RegExp(`^\\s*${key} = (.*)$`, 'm'))?.[1];
const app = resolve(setting('BUILT_PRODUCTS_DIR') ?? '', setting('FULL_PRODUCT_NAME') ?? '');
const devices = JSON.parse(must(['xcrun', 'simctl', 'list', 'devices', 'available', '-j'])) as { devices: Record<string, { name: string; udid: string }[]> };
const device = Object.values(devices.devices).flat().find(({ name }) => name === simulator);
if (!device) throw new Error(`No simulator called ${simulator}.`);
run(['xcrun', 'simctl', 'boot', device.udid]);
must(['xcrun', 'simctl', 'install', device.udid, app]);
await mkdir(out, { recursive: true });
// Through a temporary file: the simulator's service may not write to every volume.
const shots = await mkdtemp(join(tmpdir(), 'terminal-check-'));
const shot = async (name: string) => {
  const path = resolve(out, `${name}.png`);
  const taken = join(shots, `${name}.png`);
  must(['xcrun', 'simctl', 'io', device.udid, 'screenshot', taken]);
  await copyFile(taken, path);
  console.log(`screenshot ${path}`);
};
const log = Bun.spawn(['xcrun', 'simctl', 'spawn', device.udid, 'log', 'stream', '--style', 'compact', '--predicate', 'eventMessage CONTAINS "weave-terminal-check"'], { stdout: 'pipe' });
const logged: string[] = [];
void (async () => {
  for await (const chunk of log.stdout) logged.push(...new TextDecoder().decode(chunk).split('\n').filter((line) => line.includes('weave-terminal-check')));
})();

const host = await startDevHost();
const local = await HostConnection.connect({
  connector: unixConnector(host.socket),
  client: { name: 'terminal-check', version: '0' },
  credentials: { method: 'local' },
  onEvent: () => {},
});
// A pairing offer turns the Host's WebSocket on (ADR 0016); the offer itself goes unused.
await local.request('devices/offer', {});
const screen = async (id: string) => (await local.request('terminals/format', { id, trim: true })).content;
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures += 1;
};
const launch = async (id: string) => {
  const { ticket } = await local.request('terminals/attach', { id });
  must(['xcrun', 'simctl', 'launch', '--terminate-running-process', device.udid, bundleId, '--terminal-stream', host.url, ticket]);
};

let terminalId: string | undefined;
try {
  const { terminal } = await local.request('terminals/new', { directory: host.cwd, label: 'check' });
  terminalId = terminal.id;
  await launch(terminal.id);
  // The first stream sizes the terminal for the simulator's view.
  const size = await until('the terminal to take the view\'s size', async () => {
    const [listed] = (await local.request('terminals/list', { directory: host.cwd })).terminals;
    return listed && (listed.size.cols !== 80 || listed.size.rows !== 24) ? listed.size : undefined;
  });
  console.log(`size ${size.cols}x${size.rows}`);
  await until('the prompt', async () => (await screen(terminal.id)).length > 0);
  await local.request('terminals/write', { id: terminal.id, text: "printf '\\033[1;31mred\\033[0m \\033[4munderlined\\033[0m %s\\n' hello-$((6*7)); echo cols=$(tput cols) lines=$(tput lines) term=$TERM\r" });
  const typed = await until('the output', async () => { const text = await screen(terminal.id); return text.includes('hello-42') && text.includes('term=') ? text : undefined; });
  check(typed.includes(`cols=${size.cols} lines=${size.rows}`), `the shell sees the view's size (${size.cols}x${size.rows})`);
  check(typed.includes('term=xterm-ghostty'), 'TERM is xterm-ghostty');
  await Bun.sleep(1000);
  await shot('1-output');

  // A flood the app falls behind on, then catches up from a resync.
  await local.request('terminals/write', { id: terminal.id, text: 'yes weave-flood | head -c 40000000; echo flood-$((1+1))-done\r' });
  await until('the flood to end', async () => (await screen(terminal.id)).includes('flood-2-done'), 120_000);
  await Bun.sleep(1500);
  await shot('2-after-flood');

  // A second launch restores from a snapshot, history included.
  await local.request('terminals/write', { id: terminal.id, text: 'clear; for i in $(seq 1 200); do echo line-$i; done; echo before-relaunch\r' });
  await until('the lines', async () => (await screen(terminal.id)).includes('before-relaunch'));
  await launch(terminal.id);
  await Bun.sleep(3000);
  await shot('3-relaunched');
  await local.request('terminals/write', { id: terminal.id, text: 'echo after-relaunch\r' });
  await until('output after the relaunch', async () => (await screen(terminal.id)).includes('after-relaunch'));
  await Bun.sleep(1000);
  await shot('4-after-relaunch');
  check(logged.some((line) => line.includes('weave-terminal-check opened')), 'the app opened the stream');
  // Whether the app fell 4 MiB behind depends on how fast it draws.
  console.log(`resyncs during the flood: ${logged.filter((line) => line.includes('weave-terminal-check resync')).length}`);
  console.log(logged.slice(-12).join('\n'));
} catch (error) {
  console.log(logged.slice(-12).join('\n'));
  throw error;
} finally {
  if (terminalId) await local.request('terminals/close', { id: terminalId }).catch(() => {});
  await Bun.sleep(500);
  run(['xcrun', 'simctl', 'terminate', device.udid, bundleId]);
  log.kill();
  local.close();
  await host.stop();
  await rm(shots, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
