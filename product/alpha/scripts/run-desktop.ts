import { resolve } from 'node:path';
if (process.platform !== 'darwin') throw new Error('The supported desktop target is macOS.');
const app = resolve(import.meta.dir, `../release/Weave Alpha-darwin-${process.arch}/Weave Alpha.app`);
const child = Bun.spawn(['open', app], { stdout: 'inherit', stderr: 'inherit' });
process.exitCode = await child.exited;
