import { prepareTerminalCodecHeader } from '../../scripts/terminal-codec';
import { mkdir, cp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const pin = await Bun.file(join(root, 'native/ghostty/pin.json')).json();
const cache = join(homedir(), '.cache/weave/ghostty', pin.revision);
for (const platform of ['macos', 'ios']) {
  if (!await Bun.file(join(cache, platform, 'lib/libghostty-vt.a')).exists()) {
    const child = Bun.spawn(['bun', join(import.meta.dir, 'probe-ghostty.ts')], { stdout: 'inherit', stderr: 'inherit' });
    if (await child.exited !== 0) throw new Error('Pinned native terminal build failed.');
    break;
  }
}
for (const platform of ['macos', 'ios']) {
  const output = join(root, 'native/.build', platform);
  await mkdir(output, { recursive: true });
  await cp(join(cache, platform, 'include'), join(output, 'include'), { recursive: true });
  await prepareTerminalCodecHeader(join(output, 'include'), pin.revision);
  await cp(join(cache, platform, 'lib'), join(output, 'lib'), { recursive: true });
  await cp(join(root, 'native/ghostty/LICENSE'), join(output, 'GHOSTTY-LICENSE'));
}
