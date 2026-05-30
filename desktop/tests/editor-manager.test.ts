import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EditorManager } from '../src/main/editor-manager';

const target = { planeId: 'plane-1', demiplaneId: 'demiplane-1' };

const withEditorManager = async (callback: (context: {
  manager: EditorManager;
  root: string;
  outside: string;
}) => Promise<void>) => {
  const root = mkdtempSync(path.join(tmpdir(), 'weave-editor-root-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'weave-editor-outside-'));
  const manager = new EditorManager({
    resolveDemiplane: async () => ({ cwd: root }),
    maxReadBytes: 1024,
  });

  try {
    await callback({ manager, root, outside });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
};

describe('EditorManager', () => {
  it('lists directories before files and reads UTF-8 text files', async () => withEditorManager(async ({ manager, root }) => {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'README.md'), '# hello\n');

    const listResult = await manager.list({ target, path: '' });
    expect(listResult.entries.map(entry => `${entry.type}:${entry.name}`)).toEqual([
      'directory:src',
      'file:README.md',
    ]);

    const file = await manager.read({ target, path: 'README.md' });
    expect(file).toMatchObject({
      path: 'README.md',
      content: '# hello\n',
    });
    expect(file.version).toMatch(/:/);
  }));

  it('writes text files and rejects stale saves', async () => withEditorManager(async ({ manager, root }) => {
    await writeFile(path.join(root, 'notes.txt'), 'first');
    const file = await manager.read({ target, path: 'notes.txt' });

    const saved = await manager.write({
      target,
      path: 'notes.txt',
      content: 'second',
      version: file.version,
    });
    expect(await readFile(path.join(root, 'notes.txt'), 'utf8')).toBe('second');

    await writeFile(path.join(root, 'notes.txt'), 'external');
    await expect(manager.write({
      target,
      path: 'notes.txt',
      content: 'third',
      version: saved.version,
    })).rejects.toThrow('Reload before saving');
  }));

  it('rejects path traversal and symlinks that escape the Demiplane', async () => withEditorManager(async ({ manager, root, outside }) => {
    await writeFile(path.join(outside, 'secret.txt'), 'nope');
    await expect(manager.read({ target, path: '../secret.txt' })).rejects.toThrow('escape');

    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'secret-link'));
    await expect(manager.read({ target, path: 'secret-link' })).rejects.toThrow('escape');
  }));

  it('rejects binary and oversized files', async () => withEditorManager(async ({ manager, root }) => {
    await writeFile(path.join(root, 'bin.dat'), Buffer.from([0x66, 0x00, 0x6f]));
    await writeFile(path.join(root, 'big.txt'), 'x'.repeat(1025));

    await expect(manager.read({ target, path: 'bin.dat' })).rejects.toThrow('Binary');
    await expect(manager.read({ target, path: 'big.txt' })).rejects.toThrow('too large');
  }));
});
