import { test, expect } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompositionStore } from './composition-store';

test('unsupported persisted compositions fail closed without replacing user layout data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-composition-corruption-'));
  try {
    const store = new CompositionStore(root);
    await store.replace('workspace', 0, [], async () => undefined);
    const file = join(root, 'compositions', (await readdir(join(root, 'compositions')))[0]!);
    const preserved = JSON.stringify({ schemaVersion: 99, workspaceId: 'workspace', revision: 20, tabs: [{ future: 'user arrangement' }] });
    await writeFile(file, preserved);
    await expect(store.get('workspace')).rejects.toThrow('Unsupported');
    await expect(store.replace('workspace', 0, [], async () => undefined)).rejects.toThrow('Unsupported');
    expect(await readFile(file, 'utf8')).toBe(preserved);
  } finally { await rm(root, { recursive: true, force: true }); }
});
