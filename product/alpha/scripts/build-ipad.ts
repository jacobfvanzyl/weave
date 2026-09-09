import { resolve } from 'node:path';
if (process.platform !== 'darwin') throw new Error('iPad builds require macOS and Xcode.');
const root = resolve(import.meta.dir, '..');
const sync = Bun.spawn(['bun', 'run', 'cap:sync'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
if (await sync.exited !== 0) throw new Error('Capacitor sync failed.');
const device = process.env.WEAVE_IPAD_UDID;
const args = ['xcodebuild', '-project', resolve(root, 'ios/App/App.xcodeproj'), '-scheme', 'App', '-configuration', 'Debug', '-destination', device ? `id=${device}` : 'generic/platform=iOS', '-derivedDataPath', resolve(root, '.ipad-build'), '-allowProvisioningUpdates', 'build'];
const child = Bun.spawn(args, { stdout: 'inherit', stderr: 'inherit' });
process.exitCode = await child.exited;
