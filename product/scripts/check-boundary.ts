import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const ignoredDirectories = new Set(['node_modules', 'dist', 'ios', '.git', 'deferred']);
const forbiddenPackages = new Set([
  '@weave/client',
  '@weave/protocol',
  'weave-server',
  'weave-desktop',
  'weave-mobile',
  'weave-web',
  'weave-portal',
]);

type Violation = { file: string; message: string };

const isInside = (root: string, path: string) => {
  const candidate = relative(root, path);
  return candidate === '' || (!candidate.startsWith(`..${sep}`) && candidate !== '..' && !candidate.startsWith(sep));
};

const packageName = (specifier: string) => {
  if (!specifier.startsWith('@')) return specifier.split('/')[0];
  return specifier.split('/').slice(0, 2).join('/');
};

const inspectSpecifier = (root: string, file: string, specifier: string, violations: Violation[]) => {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const target = resolve(dirname(file), specifier);
    if (!isInside(root, target)) violations.push({ file, message: `relative dependency escapes product/: ${specifier}` });
    return;
  }
  if (forbiddenPackages.has(packageName(specifier))) {
    violations.push({ file, message: `legacy package dependency is forbidden: ${specifier}` });
  }
};

const walk = async (root: string, directory = root): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, path));
    else files.push(path);
  }
  return files;
};

const inspectManifest = (root: string, file: string, value: unknown, violations: Violation[]) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const dependencies = record[field];
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    for (const dependency of Object.keys(dependencies)) inspectSpecifier(root, file, dependency, violations);
  }
  const imports = record.imports;
  if (imports && typeof imports === 'object' && !Array.isArray(imports)) {
    for (const specifier of Object.values(imports)) {
      if (typeof specifier === 'string') inspectSpecifier(root, file, specifier, violations);
    }
  }
};

export const findProductBoundaryViolations = async (productRoot: string): Promise<Violation[]> => {
  const root = resolve(productRoot);
  const violations: Violation[] = [];
  for (const file of await walk(root)) {
    if (relative(root, file) === 'scripts/check-boundary.test.ts') continue;
    const extension = extname(file);
    if (sourceExtensions.has(extension)) {
      const source = await readFile(file, 'utf8');
      const imports = source.matchAll(/(?:from\s+|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g);
      for (const match of imports) inspectSpecifier(root, file, match[1], violations);
    }
    if (file.endsWith('package.json') || file.endsWith('deno.json')) {
      inspectManifest(root, file, JSON.parse(await readFile(file, 'utf8')), violations);
    }
  }
  return violations.map((violation) => ({ ...violation, file: relative(root, violation.file) }));
};

if (import.meta.main) {
  const productRoot = resolve(import.meta.dir, '..');
  const violations = await findProductBoundaryViolations(productRoot);
  if (violations.length) {
    for (const violation of violations) console.error(`${violation.file}: ${violation.message}`);
    process.exit(1);
  }
  console.log('Product dependency boundary is clean.');
}
