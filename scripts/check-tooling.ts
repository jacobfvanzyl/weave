import { resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const fail = (message: string): never => { throw new Error(message); };
if (Bun.version !== '1.3.14') fail('Use the repository-pinned Bun 1.3.14.');
const manifest = await Bun.file(resolve(root, 'package.json')).json();
if (manifest.packageManager !== 'bun@1.3.14') fail('Root packageManager must match the pinned Bun runtime.');
if (JSON.stringify(manifest.workspaces) !== JSON.stringify(['product/alpha', 'product/protocol', 'product/portal'])) fail('Only Alpha, protocol and Host are application workspaces.');
for (const directory of ['.', ...manifest.workspaces]) {
  const pkg = await Bun.file(resolve(root, directory, 'package.json')).json();
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (/(^|[\s;&|])(deno|npm|npx|pnpm|yarn)(?=\s|$)/.test(String(command))) fail(`${directory}:${name} uses a retired toolchain.`);
  }
  for (const name of ['deno.json', 'deno.jsonc', 'deno.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    if (await Bun.file(resolve(root, directory, name)).exists()) fail(`Retired configuration remains: ${directory}/${name}`);
  }
}
console.log('Bun version, workspaces, scripts and lockfile policy passed.');
