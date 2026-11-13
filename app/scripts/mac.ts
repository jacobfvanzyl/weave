// Builds the Mac app (ADR 0032, WVE-204) in release and installs it in ~/Applications, replacing
// the one there, so `weave://` links open it.
//
//   bun scripts/mac.ts install [--open]
//
// It signs with the Apple Development identity of the iOS app's team when this Mac has one,
// otherwise ad hoc (`WEAVE_SIGNING_IDENTITY` names another, `-` for ad hoc). Nothing is notarized,
// and the app doesn't update itself: run this again after pulling. A Weave already running quits
// first, and opens again after.
import { existsSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const [command, ...rest] = process.argv.slice(2);

const run = async (args: string[], options: { quiet?: boolean; env?: Record<string, string> } = {}) => {
  const child = Bun.spawn(args, {
    stdout: options.quiet ? 'pipe' : 'inherit',
    stderr: options.quiet ? 'pipe' : 'inherit',
    cwd: root,
    env: { ...process.env, ...options.env },
  });
  const output = options.quiet ? await new Response(child.stdout).text() : '';
  if ((await child.exited) !== 0) throw new Error(`${args.join(' ')} failed`);
  return output;
};

/** The team the iPad's and iPhone's app signs with (`bundle.iOS.developmentTeam`). */
const team = async () => {
  const config = await Bun.file(resolve(root, 'src-tauri/tauri.conf.json')).json() as { bundle?: { iOS?: { developmentTeam?: string } } };
  return config.bundle?.iOS?.developmentTeam;
};

/** The Apple Development identity of the iOS app's team, or ad hoc. */
const identity = async () => {
  const named = process.env.WEAVE_SIGNING_IDENTITY;
  if (named) return named;
  const wanted = await team();
  const listed = await run(['security', 'find-identity', '-v', '-p', 'codesigning'], { quiet: true });
  for (const [, name] of listed.matchAll(/"(Apple Development: [^"]+)"/g)) {
    const pem = await run(['security', 'find-certificate', '-c', name, '-p'], { quiet: true });
    const openssl = Bun.spawn(['openssl', 'x509', '-noout', '-subject'], { stdin: new TextEncoder().encode(pem), stdout: 'pipe' });
    const subject = await new Response(openssl.stdout).text();
    if (wanted && subject.includes(`OU=${wanted}`)) return name;
  }
  return '-';
};

const running = async () => (await Bun.spawn(['pgrep', '-x', 'weave-app']).exited) === 0;

switch (command) {
  case 'install': {
    const signing = await identity();
    console.log(`Signing with ${signing === '-' ? 'an ad hoc signature' : signing}.`);
    await run(['bun', '--bun', 'run', 'tauri', 'build', '--bundles', 'app'], { env: { APPLE_SIGNING_IDENTITY: signing } });
    const built = resolve(root, 'src-tauri/target/release/bundle/macos/Weave.app');
    if (!existsSync(built)) throw new Error(`Tauri built no app at ${built}.`);
    const installed = resolve(homedir(), 'Applications/Weave.app');
    const wasRunning = await running();
    if (wasRunning) {
      await run(['osascript', '-e', 'quit app "Weave"']);
      // Gone before its files are, and before it's opened again: `open` fails on one still quitting.
      for (let tries = 0; tries < 100 && await running(); tries += 1) await Bun.sleep(100);
    }
    await rm(installed, { recursive: true, force: true });
    await cp(built, installed, { recursive: true, verbatimSymlinks: true });
    // Launch Services learns its `weave://` scheme from the copy.
    await run(['/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', '-f', installed]);
    console.log(`Installed ${installed}.`);
    if (wasRunning || rest.includes('--open')) await run(['open', installed]);
    break;
  }
  default:
    console.error('Usage: bun scripts/mac.ts install [--open]');
    process.exit(1);
}
