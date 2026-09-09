import { resolve } from 'node:path';
const device = process.env.WEAVE_IPAD_UDID;
if (!device) throw new Error('Set WEAVE_IPAD_UDID to the connected iPad UDID.');
const root = resolve(import.meta.dir, '..');
const result = process.env.WEAVE_IPAD_RESULT || `/tmp/weave-ipad-${Date.now()}.xcresult`;
const child = Bun.spawn(['xcodebuild', '-project', resolve(root, 'ios/App/App.xcodeproj'), '-scheme', 'Acceptance', '-destination', `id=${device}`, '-derivedDataPath', '/tmp/weave-ipad-build', '-allowProvisioningUpdates', '-resultBundlePath', result, 'test'], { stdout: 'inherit', stderr: 'inherit' });
process.exitCode = await child.exited;
