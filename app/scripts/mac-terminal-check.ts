/// <reference types="bun" />
// Checks the Mac app's terminal against a dev Host (WVE-205): the built app, started on one
// terminal of a dev Host's over its whole window (`src-tauri/src/check.rs`,
// `src/mac/terminal-check.tsx`), reaches the Host on its socket and the terminal's stream
// through its core, as it does this Mac's own. The script types through the page's keyboard,
// runs a shell, vim and htop (or top) in it, changes the view's width, has a program write to the
// clipboard and notify, floods it, and measures a key to its echo and to the frame that shows
// it. Pictures of what the page drew, and the numbers, go to `--out`.
//
//   bun scripts/mac-terminal-check.ts [--out <dir>] [--app <binary>]
//
// Build first: `bun run tauri build --bundles app`, and the debug `weave`, fake agent and holder
// (`(cd .. && cargo build -p weave-cli -p weave-fake-agent -p weave-holder)`). The app's window
// comes to the front while it runs, and the clipboard's text is put back after the check wrote
// to it. Nothing reaches this Mac's own Host or its Dispatcher: the app is given the dev Host's
// directory and a state directory of its own.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HostConnection } from '../src/host/connection';
import { devHostHasTerminals, startDevHost, unixConnector } from '../src/host/testing/dev-host';

const root = resolve(import.meta.dir, '..');
const option = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
};
const out = option('out', '/Volumes/External/Build/weave-mac-terminal-check');
const binary = option('app', resolve(root, 'src-tauri/target/release/bundle/macos/Weave.app/Contents/MacOS/weave-app'));

if (!devHostHasTerminals()) throw new Error('Build the debug weave, fake agent and holder first.');
if (!existsSync(binary)) throw new Error(`No app at ${binary}. Build it with \`bun run tauri build --bundles app\`.`);

const until = async <T>(what: string, find: () => Promise<T | undefined | false> | T | undefined | false, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await find();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await Bun.sleep(100);
  }
};

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures += 1;
};
const sh = (args: string[], stdin?: string) => {
  const child = Bun.spawnSync(args, { stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
  return child.stdout.toString();
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const state = await mkdtemp(join(tmpdir(), 'weave-mac-check-'));
const host = await startDevHost();
const local = await HostConnection.connect({
  connector: unixConnector(host.socket),
  client: { name: 'mac-terminal-check', version: '0' },
  credentials: { method: 'local' },
  onEvent: () => {},
});
const { terminal } = await local.request('terminals/new', { directory: host.cwd });
const id = terminal.id;
const screen = async () => (await local.request('terminals/format', { id, format: 'text', trim: true })).content;
const listed = async () => (await local.request('terminals/list', { directory: host.cwd })).terminals.find((one) => one.id === id);
const write = (text: string) => local.request('terminals/write', { id, text });

const app = Bun.spawn([binary], {
  env: { ...process.env, WEAVE_DAEMON_DIR: host.dir, XDG_STATE_HOME: state, WEAVE_TERMINAL_CHECK: out, WEAVE_TERMINAL_CHECK_TERMINAL: id },
  stdout: 'inherit',
  stderr: 'inherit',
});

type Shot = {
  state: { kind: string; restore?: string; message?: string };
  fits?: { cols: number; rows: number };
  lines: string[];
  notices: { kind: string; title?: string; body?: string }[];
  focused: boolean;
  /** Whether the window is on screen: covered, the page draws no frames, and nothing measured means much. */
  visible: boolean;
};

/** Asks the page for something and reads what it reports under `name`. */
const ask = async <T>(request: string, name: string, ms = 30_000): Promise<T> => {
  const reported = join(out, `${name}.json`);
  await rm(reported, { force: true });
  await writeFile(join(out, 'request.partial'), request);
  await Bun.$`mv ${join(out, 'request.partial')} ${join(out, 'request')}`.quiet();
  await until(`the page's ${name}`, () => existsSync(reported), ms);
  return JSON.parse(await readFile(reported, 'utf8')) as T;
};
const shot = (name: string) => ask<Shot>(`shot ${name}`, name);
const type = (text: string) => ask(`type ${JSON.stringify(text)}`, 'typed');

const summary: Record<string, unknown> = { at: new Date().toISOString(), binary };
const clipboardBefore = sh(['pbpaste']);
let wroteClipboard = false;
try {
  const first = await until('the page to attach to the terminal', async () => {
    const taken = await shot('start');
    if (taken.state.kind === 'failed') console.log(`     ${taken.state.message}`);
    return taken.state.kind === 'attached' ? taken : undefined;
  }, 40_000);
  check(first.state.restore === 'snapshot', "the screen came as the holder's snapshot, which the page decoded");
  check(first.focused, 'the terminal has the keyboard');
  check(first.visible, "the app's window is on screen, so the page draws");
  const fits = first.fits ?? { cols: 0, rows: 0 };
  const sized = await until('the terminal to take the size of the view', async () => {
    const now = await listed();
    return now && now.size.cols === fits.cols && now.size.rows === fits.rows ? now.size : undefined;
  });
  check(sized.cols > 80, `the terminal took the view's size, ${sized.cols} by ${sized.rows}`);
  summary.grid = sized;

  // A shell, typed into through the page's keyboard.
  await type('echo hi-$((6*7))\r');
  await until('the shell to run what was typed', async () => (await screen()).includes('hi-42'));
  const shell = await shot('shell');
  check(shell.lines.some((line) => line === 'hi-42'), 'the page drew what the shell printed');

  // vim, on the alternate screen, with keys that aren't text.
  await type('vim -u NONE\r');
  await until('vim to start', async () => (await screen()).includes('~'));
  await type('ihello from vim\x1b');
  await until('vim to take the keys', async () => (await screen()).includes('hello from vim'));
  const vim = await shot('vim');
  check(vim.lines[0] === 'hello from vim' && vim.lines.filter((line) => line === '~').length > 5, 'the page drew vim');
  await type(':q!\r');
  await until('vim to quit', async () => !(await screen()).includes('hello from vim'));

  // htop, or top where there's none: colors, and a screen redrawn every second.
  const monitor = Bun.which('htop') ? 'htop' : 'top';
  await type(`${monitor}\r`);
  // Whatever the shell calls by that name: a person's `top` may be another program.
  await until(`${monitor} to draw`, async () => /cpu|pid/i.test(await screen()));
  await Bun.sleep(1500);
  const monitored = await shot(monitor);
  check(monitored.lines.some((line) => /cpu|pid/i.test(line)), `the page drew ${monitor}`);
  await type('q');
  await Bun.sleep(1000);
  await type('clear\r');

  // The view narrower, as when the window's edge is dragged: the terminal follows this device.
  const narrowed = await ask<{ fits: { cols: number; rows: number } }>('width 60%', 'width');
  check(narrowed.fits.cols < fits.cols, `a narrower view fits ${narrowed.fits.cols} columns`);
  await until('the terminal to take the narrower size', async () => (await listed())?.size.cols === narrowed.fits.cols);
  check(true, 'the terminal took the narrower size');
  const widened = await ask<{ fits: { cols: number; rows: number } }>('width 100%', 'width');
  await until('the terminal to take the wider size', async () => (await listed())?.size.cols === widened.fits.cols);
  check(widened.fits.cols === fits.cols, 'and the wider one again');

  // A program writing to the clipboard (OSC 52), and notifying (OSC 9).
  wroteClipboard = true;
  await write("printf '\\033]52;c;%s\\a' \"$(printf weave-check-52 | base64)\"\r");
  const copied = await until('the clipboard to have what the program wrote', () => sh(['pbpaste']) === 'weave-check-52', 10_000).catch(() => false);
  check(copied === true, "a program's clipboard write (OSC 52) reached the Mac's clipboard");
  await write("printf '\\033]9;weave check\\a'\r");
  const noticed = await until('the notification', async () => {
    const taken = await shot('notices');
    return taken.notices.some((notice) => notice.kind === 'notification' && `${notice.title} ${notice.body}`.includes('weave check')) ? taken : undefined;
  }, 10_000).catch(() => undefined);
  check(noticed !== undefined, "a program's notification (OSC 9) reached the page");
  check(noticed?.notices.some((notice) => notice.kind === 'clipboard') === true, 'and the page said the clipboard was written');

  // A flood of output.
  await type('clear\r');
  await ask('count counting', 'counting');
  const lines = 2_000_000;
  const started = Date.now();
  // BSD's seq counts in floating point; the marker isn't in what was typed.
  await write(`seq -f %.0f 1 ${lines}; echo flood-done-$((1+1))\r`);
  await until('the flood to end', async () => (await screen()).includes('flood-done-2'), 120_000);
  const hostMs = Date.now() - started;
  const flood = await ask<{ bytes: number; frames: number; outputMs: number; drawnMs: number; longestFrameGapMs: number }>('counted flood', 'flood', 60_000);
  const flooded = await shot('flood');
  check(flooded.lines.includes(String(lines)) && flooded.lines.includes('flood-done-2'), 'the page drew the end of the flood');
  check(flooded.state.kind === 'attached', 'and its stream is still open');
  summary.flood = {
    lines,
    megabytes: Number((flood.bytes / 1e6).toFixed(1)),
    hostSeconds: Number((hostMs / 1000).toFixed(2)),
    pageSeconds: Number((flood.drawnMs / 1000).toFixed(2)),
    megabytesPerSecond: Number((flood.bytes / 1e6 / (flood.drawnMs / 1000)).toFixed(1)),
    frames: flood.frames,
    framesPerSecond: Number((flood.frames / (flood.drawnMs / 1000)).toFixed(1)),
    longestFrameGapMs: Math.round(flood.longestFrameGapMs),
  };

  // A key to its echo, and to the frame that shows it.
  await type('clear\r');
  await Bun.sleep(300);
  summary.latency = await ask('latency latency', 'latency', 60_000);
  await shot('end');
} catch (error) {
  // What the terminal showed when the check gave up.
  console.log(await screen().catch(() => ''));
  throw error;
} finally {
  if (wroteClipboard) sh(['pbcopy'], clipboardBefore);
  app.kill();
  await local.request('terminals/close', { id }).catch(() => {});
  await Bun.sleep(300);
  local.close();
  await host.stop();
  await rm(state, { recursive: true, force: true });
}
summary.failures = failures;
await writeFile(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(`Pictures and reports are in ${out}.`);
process.exit(failures ? 1 : 0);
