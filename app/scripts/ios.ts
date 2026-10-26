// Builds the iOS app, and installs and launches it on a device. A build first puts libghostty-vt
// in place (`scripts/ghostty.ts`).
//
//   bun scripts/ios.ts build [--device <udid> | --simulator <name>] [--unsigned]
//   bun scripts/ios.ts install --device <udid>
//
// Without a device, it builds for any iOS device, signed through automatic signing, so a device
// that is slow to connect doesn't hold the build up; install then copies it over.
//
// Builds use Xcode's configured DerivedData location: never pass -derivedDataPath or
// -resultBundlePath under /tmp or the home directory.
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const project = resolve(root, 'ios/App/App.xcodeproj');
const bundleId = 'com.veezee.weave';

const [command, ...rest] = process.argv.slice(2);
const option = (name: string) => {
  const index = rest.indexOf(`--${name}`);
  return index === -1 ? undefined : rest[index + 1];
};
const device = option('device');
const unsigned = rest.includes('--unsigned');
const simulator = option('simulator');
const destination = device
  ? `id=${device}`
  : simulator
    ? `platform=iOS Simulator,name=${simulator}`
    : 'generic/platform=iOS';
const xcodebuild = (target = destination) =>
  ['xcodebuild', '-project', project, '-scheme', 'App', '-configuration', 'Debug', '-destination', target];

const run = async (args: string[], options: { quiet?: boolean } = {}) => {
  const child = Bun.spawn(args, { stdout: options.quiet ? 'pipe' : 'inherit', stderr: 'inherit' });
  const output = options.quiet ? await new Response(child.stdout).text() : '';
  if ((await child.exited) !== 0) throw new Error(`${args[0]} failed`);
  return output;
};

const builtApp = async () => {
  // Where device builds go doesn't depend on the device, and asking about one waits for it.
  const settings = await run([...xcodebuild('generic/platform=iOS'), '-showBuildSettings'], { quiet: true });
  const value = (key: string) => settings.match(new RegExp(`^\\s*${key} = (.*)$`, 'm'))?.[1];
  const directory = value('BUILT_PRODUCTS_DIR');
  const name = value('FULL_PRODUCT_NAME');
  if (!directory || !name) throw new Error('Xcode did not report where it builds the app.');
  return resolve(directory, name);
};

switch (command) {
  case 'build':
    // libghostty-vt and the terminal fonts, from the holder's Ghostty pin (WVE-153).
    await run(['bun', resolve(import.meta.dir, 'ghostty.ts')]);
    await run([
      ...xcodebuild(),
      ...(simulator ? [] : unsigned ? ['CODE_SIGNING_ALLOWED=NO'] : ['-allowProvisioningUpdates']),
      'build',
    ]);
    break;
  case 'install': {
    if (!device) throw new Error('install needs --device <udid> (see `xcrun devicectl list devices`).');
    const app = await builtApp();
    await run(['xcrun', 'devicectl', 'device', 'install', 'app', '--device', device, app]);
    await run(['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', device, bundleId]);
    break;
  }
  default:
    console.error('Usage: bun scripts/ios.ts build [--device <udid> | --simulator <name>] [--unsigned] | install --device <udid>');
    process.exit(2);
}
