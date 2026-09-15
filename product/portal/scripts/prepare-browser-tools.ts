import { cp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const source = join(root, 'browser-tools');
const install = Bun.spawn(['bun', 'install', '--cwd', source, '--frozen-lockfile', '--ignore-scripts'], { stdout: 'inherit', stderr: 'inherit' });
if (await install.exited !== 0) throw new Error('Pinned browser tools installation failed');
const target = join(root, 'dist', ...(process.argv.includes('--linux') ? ['linux-x64'] : []), 'browser-tools');
await mkdir(target, { recursive: true });
for (const item of ['runner.mjs', 'package.json', 'bun.lock', 'node_modules']) await cp(join(source, item), join(target, item), { recursive: true });
