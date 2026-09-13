import {mkdir, readFile, writeFile, cp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root = import.meta.dir, build = resolve(root, '.build');
await mkdir(build, {recursive: true});
const mode = process.argv[2] ?? 'mac';
if (!['mac', 'ipad'].includes(mode)) throw new Error('Expected mac or ipad');
const run = async (args: string[]) => { const child = Bun.spawn(args, {stdout: 'inherit', stderr: 'inherit'}); if (await child.exited !== 0) throw new Error('Failed: ' + args[0]); };
const pin = await Bun.file(resolve(root, 'native/pin.json')).json();
const archive = resolve(build, 'LiveKitWebRTC.xcframework.zip');
if (!await Bun.file(archive).exists()) {
  const response = await fetch(pin.url); if (!response.ok) throw new Error('Framework download failed');
  await Bun.write(archive, response);
}
if (createHash('sha256').update(await readFile(archive)).digest('hex') !== pin.sha256) throw new Error('WebRTC checksum mismatch');
const framework = resolve(build, 'LiveKitWebRTC.xcframework');
if (!await Bun.file(resolve(framework, 'Info.plist')).exists()) await run(['unzip','-q',archive,'-d',build]);
const connectionFile = process.env.SPIKE_CONNECTION ?? resolve(build, 'connection.json');
await mkdir(resolve(build, 'receiver'), {recursive:true});
await cp(connectionFile, resolve(build, 'receiver/connection.json'));
if (!await Bun.file(connectionFile).exists()) throw new Error('Start the Host first or copy its private connection.json into .build');
const info = {CFBundleExecutable:'BrowserSpike',CFBundleIdentifier:'com.veezee.browser-spike',CFBundleName:'BrowserSpike',CFBundleDisplayName:'Browser Spike',CFBundlePackageType:'APPL',CFBundleShortVersionString:'0.1',CFBundleVersion:'1',NSLocalNetworkUsageDescription:'Connect to your browser feasibility Host over the local network.',NSAppTransportSecurity:{NSAllowsArbitraryLoads:true},UILaunchScreen:{},UISupportedInterfaceOrientations:['UIInterfaceOrientationPortrait','UIInterfaceOrientationPortraitUpsideDown','UIInterfaceOrientationLandscapeLeft','UIInterfaceOrientationLandscapeRight']};
const plist = resolve(build,'Info.plist'); await writeFile(plist,JSON.stringify(info)); await run(['plutil','-convert','xml1',plist]);
if (mode === 'ipad') {
  await run(['python3',resolve(root,'native/make-project.py'),root]);
  await run(['xcodebuild','-project',resolve(build,'BrowserSpike.xcodeproj'),'-scheme','BrowserSpike','-configuration','Debug','-destination','generic/platform=iOS','-derivedDataPath',resolve(build,'ipad'),'-allowProvisioningUpdates','build']);
} else {
  const app = resolve(build,'BrowserSpike.app'), contents = resolve(app,'Contents');
  await mkdir(resolve(contents,'MacOS'),{recursive:true}); await mkdir(resolve(contents,'Frameworks'),{recursive:true}); await mkdir(resolve(contents,'Resources'),{recursive:true});
  await cp(resolve(framework,'macos-arm64_x86_64/LiveKitWebRTC.framework'),resolve(contents,'Frameworks/LiveKitWebRTC.framework'),{recursive:true});
  await cp(plist,resolve(contents,'Info.plist')); await cp(connectionFile,resolve(contents,'Resources/connection.json'));
  await run(['xcrun','swiftc','-swift-version','5','-parse-as-library','-F',resolve(contents,'Frameworks'),'-framework','LiveKitWebRTC','-Xlinker','-rpath','-Xlinker','@executable_path/../Frameworks',resolve(root,'native/BrowserMediaReceiver.swift'),resolve(root,'native/SpikeApp.swift'),'-o',resolve(contents,'MacOS/BrowserSpike')]);
  await run(['codesign','--force','--sign','-','--deep',app]);
  console.log('Built ' + app);
}
