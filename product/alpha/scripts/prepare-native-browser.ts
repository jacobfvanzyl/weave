import { mkdir, cp, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PORTAL_WEBSOCKET_PROTOCOL } from '@weave/product-protocol';
const root = resolve(import.meta.dir, '..');
const pin = (await Bun.file(resolve(root, '../portal/native/browser/dependencies.json')).json()).libvncserver;
const cache = join(homedir(), '.cache/weave/libvnc', pin.sha256);
await mkdir(cache, { recursive: true });
const source = join(cache, `libvncserver-LibVNCServer-${pin.version}`);
const run = async (args: string[]) => { const child = Bun.spawn(args, { stdout: 'inherit', stderr: 'inherit' }); if (await child.exited !== 0) throw new Error(`Native browser dependency build failed: ${args[0]}`); };
if (!await Bun.file(join(source, 'CMakeLists.txt')).exists()) {
  const response = await fetch(pin.url); if (!response.ok) throw new Error('Pinned LibVNC download failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error('Pinned LibVNC checksum mismatch');
  const archive = join(cache, 'source.tar.gz'); await writeFile(archive, bytes);
  await run(['tar', '-xzf', archive, '-C', cache]);
}
for (const platform of ['macos', 'ios']) {
  const build = join(cache, platform), target = join(root, 'native/.build/browser', platform);
  if (!await Bun.file(join(build, 'libvncclient.a')).exists()) {
    const sdk = Bun.spawnSync(['xcrun', '--sdk', platform === 'ios' ? 'iphoneos' : 'macosx', '--show-sdk-path']).stdout.toString().trim();
    const options = ['cmake', '-S', source, '-B', build, '-DCMAKE_POLICY_VERSION_MINIMUM=3.5', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DCMAKE_OSX_ARCHITECTURES=arm64', `-DCMAKE_OSX_SYSROOT=${sdk}`, `-DZLIB_LIBRARY=${sdk}/usr/lib/libz.tbd`, `-DZLIB_INCLUDE_DIR=${sdk}/usr/include`, ...['LZO','JPEG','PNG','SDL','GTK','LIBSSHTUNNEL','GNUTLS','OPENSSL','SYSTEMD','GCRYPT','FFMPEG','TIGHTVNC_FILETRANSFER','WEBSOCKETS','SASL','XCB','EXAMPLES','TESTS','QT'].map(name => `-DWITH_${name}=OFF`)];
    options.push(`-DCMAKE_OSX_DEPLOYMENT_TARGET=${platform === 'ios' ? '17.0' : '14.0'}`);
    if (platform === 'ios') options.push('-DCMAKE_SYSTEM_NAME=iOS', '-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY');
    await run(options); await run(['cmake', '--build', build, '--target', 'vncclient', '-j', '4']);
  }
  await mkdir(join(target, 'include'), { recursive: true });
  await cp(join(source, 'include/rfb'), join(target, 'include/rfb'), { recursive: true });
  await cp(join(build, 'include/rfb/rfbconfig.h'), join(target, 'include/rfb/rfbconfig.h'));
  await cp(join(build, 'libvncclient.a'), join(target, 'libvncclient.a'));
  await cp(join(source, 'COPYING'), join(target, 'LIBVNC-LICENSE'));
  await writeFile(join(target, 'include/WeaveBrowserProtocol.h'), `#define WEAVE_BROWSER_WEBSOCKET_PROTOCOL @${JSON.stringify(PORTAL_WEBSOCKET_PROTOCOL)}\n`);
}
