import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const repo = resolve(root, '../..');
const target = process.argv.includes('--linux') ? 'bun-linux-x64' : 'bun';
const outfile = join(root, 'dist', target === 'bun' ? 'weave-portal' : 'weave-portal-linux-x64');
const hash = createHash('sha256');
async function visit(path: string) {
  for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(path, item.name);
    if (item.isDirectory()) await visit(file);
    else if (item.isFile()) { hash.update(file.slice(repo.length)); hash.update(await readFile(file)); }
  }
}
await visit(join(root, 'src'));
await visit(join(repo, 'product/protocol/src'));
hash.update(await readFile(join(repo, 'bun.lock')));
const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repo });
const metadata = { version: (await Bun.file(join(root, 'package.json')).json()).version, revision: git.exitCode === 0 ? git.stdout.toString().trim() : 'source-archive', sourceHash: hash.digest('hex') };
await mkdir(join(root, 'dist'), { recursive: true });
const build = Bun.spawn(['bun', 'build', '--compile', `--target=${target}`, '--outfile', outfile, '--define', `WEAVE_BUILD=${JSON.stringify(metadata)}`, join(root, 'src/main.ts')], { stdout: 'inherit', stderr: 'inherit' });
if (await build.exited !== 0) throw new Error('Host compilation failed');
const sha256 = createHash('sha256').update(await readFile(outfile)).digest('hex');
await writeFile(`${outfile}.json`, JSON.stringify({ ...metadata, target, sha256, protocolVersion: 2, stateFormat: 1, bun: Bun.version }, null, 2) + '\n');
