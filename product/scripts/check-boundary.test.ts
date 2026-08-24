import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProductBoundaryViolations } from './check-boundary';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-product-boundary-'));
  roots.push(root);
  await mkdir(join(root, 'alpha', 'src'), { recursive: true });
  await mkdir(join(root, 'protocol', 'src'), { recursive: true });
  await writeFile(join(root, 'alpha', 'package.json'), JSON.stringify({ dependencies: { '@weave/product-protocol': 'workspace:*' } }));
  return root;
};

describe('product dependency boundary', () => {
  test('allows dependencies contained within product', async () => {
    const root = await fixture();
    await writeFile(join(root, 'alpha', 'src', 'client.ts'), "import type { Host } from '../../protocol/src/index.ts';\n");
    expect(await findProductBoundaryViolations(root)).toEqual([]);
  });

  test('rejects legacy packages and paths that escape product', async () => {
    const root = await fixture();
    await writeFile(join(root, 'alpha', 'package.json'), JSON.stringify({ dependencies: { '@weave/protocol': 'workspace:*' } }));
    await writeFile(join(root, 'alpha', 'src', 'client.ts'), "import '../../../portal/src/main.ts';\n");
    expect((await findProductBoundaryViolations(root)).map((violation) => violation.message)).toEqual([
      'legacy package dependency is forbidden: @weave/protocol',
      'relative dependency escapes product/: ../../../portal/src/main.ts',
    ]);
  });
});
