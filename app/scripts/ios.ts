/// <reference types="bun" />
// Builds the iPad's and iPhone's app, the Mac's shell built for iOS (ADR 0033, WVE-221), and
// installs it: on a device, where it launches it too, or in a simulator.
//
//   bun scripts/ios.ts build [--simulator]
//   bun scripts/ios.ts install --device <udid> | --simulator <name or udid>
//
// A build is a release one for any device, signed for development by the team in
// `tauri.conf.json` (`bundle.iOS.developmentTeam`), which Xcode needs an account of to make the
// first provisioning profile; `--simulator` builds a debug one for the simulator on Apple silicon
// instead. Tauri runs Xcode on the project in `src-tauri/gen/apple`, which builds where Xcode's
// DerivedData is configured to: never pass it a path under /tmp or the home directory.
//
// `xcrun devicectl list devices` names the devices; a simulator has to be booted.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const built = resolve(root, 'src-tauri/gen/apple/build');
const bundleId = 'com.veezee.weave';

const [command, ...rest] = process.argv.slice(2);
const option = (name: string) => {
  const index = rest.indexOf(`--${name}`);
  const value = index === -1 ? undefined : rest[index + 1];
  return value?.startsWith('--') ? undefined : value;
};

const run = async (args: string[]) => {
  const child = Bun.spawn(args, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if ((await child.exited) !== 0) throw new Error(`${args.join(' ')} failed`);
};

const found = (path: string, how: string) => {
  if (!existsSync(path)) throw new Error(`There's no build at ${path}. Run \`bun scripts/ios.ts ${how}\` first.`);
  return path;
};

switch (command) {
  case 'build':
    await run(rest.includes('--simulator')
      ? ['bun', '--bun', 'run', 'tauri', 'ios', 'build', '--debug', '--target', 'aarch64-sim', '--ci']
      : ['bun', '--bun', 'run', 'tauri', 'ios', 'build', '--export-method', 'debugging', '--ci']);
    break;
  case 'install': {
    const device = option('device');
    const simulator = option('simulator');
    if (device) {
      await run(['xcrun', 'devicectl', 'device', 'install', 'app', '--device', device, found(resolve(built, 'arm64/Weave.ipa'), 'build')]);
      await run(['xcrun', 'devicectl', 'device', 'process', 'launch', '--terminate-existing', '--device', device, bundleId]);
    } else if (simulator) {
      await run(['xcrun', 'simctl', 'install', simulator, found(resolve(built, 'arm64-sim/Weave.app'), 'build --simulator')]);
    } else {
      throw new Error('install needs --device <udid> (see `xcrun devicectl list devices`) or --simulator <name or udid>.');
    }
    break;
  }
  default:
    console.error('Usage: bun scripts/ios.ts build [--simulator] | install --device <udid> | --simulator <name or udid>');
    process.exit(2);
}
