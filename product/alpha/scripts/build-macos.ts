import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const alphaRoot = resolve(import.meta.dir, '..');
const macosRoot = resolve(alphaRoot, 'macos');
const webDist = resolve(alphaRoot, 'dist');
const appPath = resolve(webDist, 'Weave Alpha.app');
const executableName = 'WeaveAlpha';
const scratchPath = process.env.WEAVE_ALPHA_SWIFT_SCRATCH_PATH?.trim() ||
  '/tmp/weave-alpha-macos-build';

if (process.platform !== 'darwin') {
  throw new Error('The Weave Alpha macOS application can only be built on macOS.');
}

const run = (command: string, args: string[], cwd = alphaRoot) => {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command} exited with status ${result.exitCode}.`);
  }
};

run('bun', ['run', 'build']);
const webEntries = readdirSync(webDist).filter((entry) => entry !== 'Weave Alpha.app');

run('swift', [
  'build',
  '-c',
  'release',
  '--package-path',
  macosRoot,
  '--scratch-path',
  scratchPath,
]);
const binPath = Bun.spawnSync([
  'swift',
  'build',
  '-c',
  'release',
  '--package-path',
  macosRoot,
  '--scratch-path',
  scratchPath,
  '--show-bin-path',
], { stdout: 'pipe', stderr: 'inherit' }).stdout.toString().trim();
if (!binPath) throw new Error('Swift did not report its binary output path.');

rmSync(appPath, { recursive: true, force: true });
const contents = resolve(appPath, 'Contents');
const macos = resolve(contents, 'MacOS');
const resources = resolve(contents, 'Resources');
const publicResources = resolve(resources, 'public');
mkdirSync(macos, { recursive: true });
mkdirSync(publicResources, { recursive: true });

const executable = resolve(macos, executableName);
copyFileSync(resolve(binPath, executableName), executable);
chmodSync(executable, 0o755);
for (const entry of webEntries) {
  cpSync(resolve(webDist, entry), resolve(publicResources, entry), {
    recursive: true,
  });
}

writeFileSync(resolve(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Weave Alpha</string>
  <key>CFBundleExecutable</key><string>${executableName}</string>
  <key>CFBundleIdentifier</key><string>com.veezee.alpha.macos</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Weave Alpha</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`);

const identity = process.env.WEAVE_ALPHA_CODESIGN_IDENTITY?.trim() || '-';
run('/usr/bin/codesign', [
  '--force',
  '--sign',
  identity,
  '--timestamp=none',
  appPath,
]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);

console.log(`Built and signed ${appPath}`);
