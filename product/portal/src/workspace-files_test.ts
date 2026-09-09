import { test } from './test-support.ts';
import { mkdir, readText, realpath, removePath, stat, symlink, temporaryDirectory, writeBytes, writeText } from './host-files.ts';
import type { FileChange } from './host-files.ts';
import { assertEquals, assertRejects } from './test-support.ts';
import { WorkspaceFileError, WorkspaceFileService, type WorkspaceFileSystemWatcher } from './workspace-files.ts';

test('Workspace files retain a filesystem-root context without treating it as unavailable', async () => {
  const directory = await temporaryDirectory({ prefix: 'weave-root-context-' });
  const files = await WorkspaceFileService.open([{ workspaceId: 'root', path: '/' }]);
  try {
    await writeText(`${directory}/owned.txt`, 'root context');
    const path = (await realpath(`${directory}/owned.txt`)).slice(1);
    const result = await files.read({ workspaceId: 'root', path });
    assertEquals(result.content, 'root context');
  } finally {
    files.close();
    await removePath(directory, { recursive: true });
  }
});

class FakeWatcher implements WorkspaceFileSystemWatcher {
  closed = false;
  readonly #events: FileChange[] = [];
  readonly #waiting: Array<(value: IteratorResult<FileChange>) => void> = [];

  emit(event: FileChange) {
    const waiting = this.#waiting.shift();
    if (waiting) waiting({ value: event, done: false });
    else this.#events.push(event);
  }

  close() {
    this.closed = true;
    for (const waiting of this.#waiting.splice(0)) waiting({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  next(): Promise<IteratorResult<FileChange>> {
    const event = this.#events.shift();
    if (event) return Promise.resolve({ value: event, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.#waiting.push(resolve));
  }
}

const withWorkspace = async (
  callback: (context: { root: string; outside: string; service: WorkspaceFileService }) => Promise<void>,
) => {
  const root = await temporaryDirectory({ prefix: 'weave-product-workspace-' });
  const outside = await temporaryDirectory({ prefix: 'weave-product-outside-' });
  const service = await WorkspaceFileService.open([{ workspaceId: 'workspace', path: root }], {
    maxReadBytes: 1_024,
    maxWriteBytes: 1_024,
    maxDirectoryEntries: 2,
    maxSearchFiles: 10,
    maxSearchBytesPerFile: 1_024,
    maxSearchResults: 5,
    maxWatchPaths: 4,
    watchDebounceMs: 0,
  });
  try {
    await callback({ root: await realpath(root), outside: await realpath(outside), service });
  } finally {
    service.close();
    await removePath(root, { recursive: true }).catch(() => undefined);
    await removePath(outside, { recursive: true }).catch(() => undefined);
  }
};

test('Workspace files list directories and read and hash UTF-8 files', async () =>
  await withWorkspace(async ({ root, service }) => {
    await mkdir(`${root}/src`);
    await writeText(`${root}/README.md`, '# hello\n');

    const listed = await service.list({ workspaceId: 'workspace', path: '' });
    assertEquals(listed.path, '');
    assertEquals(listed.entries.map((entry) => `${entry.type}:${entry.name}`), [
      'directory:src',
      'file:README.md',
    ]);
    assertEquals(listed.truncated, false);

    assertEquals(await service.read({ workspaceId: 'workspace', path: 'README.md' }), {
      path: 'README.md',
      content: '# hello\n',
      contentHash: '9e8b62f81ea5c66fa06ee53da032751386b37702153070c0e14dd1d316282fa7',
      size: 8,
      mtimeMs: (await stat(`${root}/README.md`)).mtime?.getTime(),
    });

    assertEquals(await service.hash({ workspaceId: 'workspace', path: 'README.md' }), {
      path: 'README.md',
      contentHash: '9e8b62f81ea5c66fa06ee53da032751386b37702153070c0e14dd1d316282fa7',
      size: 8,
      mtimeMs: (await stat(`${root}/README.md`)).mtime?.getTime(),
      lineCount: 1,
    });
  }));

test('Workspace file listings and limited searches are deterministic and bounded', async () =>
  await withWorkspace(async ({ root, service }) => {
    await writeText(`${root}/z-last.txt`, 'marker');
    await writeText(`${root}/a-first.txt`, 'marker');
    await writeText(`${root}/m-middle.txt`, 'marker');

    const listed = await service.list({ workspaceId: 'workspace', path: '' });
    assertEquals(listed.entries.map((entry) => entry.name), ['a-first.txt', 'm-middle.txt']);
    assertEquals(listed.truncated, true);

    assertEquals(
      await service.search({ workspaceId: 'workspace', path: '', query: 'marker', scope: 'content', limit: 1 }),
      {
        path: '',
        matches: [{ path: 'a-first.txt', kind: 'content', line: 1, preview: 'marker' }],
        truncated: true,
      },
    );
  }));

test('Workspace files require create-only or hash-conditional writes', async () =>
  await withWorkspace(async ({ root, service }) => {
    const created = await service.write({
      workspaceId: 'workspace',
      path: 'notes.txt',
      content: 'first',
      expectedContentHash: null,
    });
    assertEquals(created.contentHash, 'a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e');

    await assertRejects(
      () =>
        service.write({ workspaceId: 'workspace', path: 'notes.txt', content: 'duplicate', expectedContentHash: null }),
      WorkspaceFileError,
      'already exists',
    );

    const replaced = await service.write({
      workspaceId: 'workspace',
      path: 'notes.txt',
      content: 'second',
      expectedContentHash: created.contentHash,
    });
    assertEquals(await readText(`${root}/notes.txt`), 'second');

    await writeText(`${root}/notes.txt`, 'external');
    await assertRejects(
      () =>
        service.write({
          workspaceId: 'workspace',
          path: 'notes.txt',
          content: 'third',
          expectedContentHash: replaced.contentHash,
        }),
      WorkspaceFileError,
      'Reload before saving',
    );
    assertEquals(await readText(`${root}/notes.txt`), 'external');
  }));

test('Workspace files serialize competing conditional writes', async () =>
  await withWorkspace(async ({ service }) => {
    const created = await service.write({
      workspaceId: 'workspace',
      path: 'shared.txt',
      content: 'base',
      expectedContentHash: null,
    });
    const writes = await Promise.allSettled([
      service.write({
        workspaceId: 'workspace',
        path: 'shared.txt',
        content: 'first',
        expectedContentHash: created.contentHash,
      }),
      service.write({
        workspaceId: 'workspace',
        path: 'shared.txt',
        content: 'second',
        expectedContentHash: created.contentHash,
      }),
    ]);
    assertEquals(writes.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  }));

test('Workspace files create, move, delete, and search within bounded roots', async () =>
  await withWorkspace(async ({ root, service }) => {
    await mkdir(`${root}/.git`);
    await mkdir(`${root}/node_modules`);
    assertEquals(await service.createDirectory({ workspaceId: 'workspace', path: 'src/nested' }), {
      ok: true,
      path: 'src/nested',
    });
    await service.write({
      workspaceId: 'workspace',
      path: 'src/nested/main.ts',
      content: 'export const marker = "WVE42";\n',
      expectedContentHash: null,
    });
    assertEquals(
      await service.move({
        workspaceId: 'workspace',
        fromPath: 'src/nested/main.ts',
        toPath: 'src/main.ts',
      }),
      { ok: true, path: 'src/main.ts' },
    );
    assertEquals(await readText(`${root}/src/main.ts`), 'export const marker = "WVE42";\n');

    assertEquals(
      await service.search({ workspaceId: 'workspace', path: '', query: 'WVE42', scope: 'both', limit: 5 }),
      {
        path: '',
        matches: [{ path: 'src/main.ts', kind: 'content', line: 1, preview: 'export const marker = "WVE42";' }],
        truncated: false,
      },
    );

    const nonRecursiveError = await service.delete({ workspaceId: 'workspace', path: 'src', recursive: false })
      .then(() => undefined)
      .catch((cause) => cause);
    assertEquals(nonRecursiveError instanceof WorkspaceFileError, true);
    assertEquals(nonRecursiveError.data, {
      domain: 'workspace-filesystem',
      code: 'DIRECTORY_NOT_EMPTY',
      path: 'src',
    });
    assertEquals(JSON.stringify(nonRecursiveError.data).includes(root), false);

    assertEquals(await service.delete({ workspaceId: 'workspace', path: 'src', recursive: true }), {
      ok: true,
      path: 'src',
    });
    await assertRejects(() => stat(`${root}/src`), { code: 'ENOENT' });
  }));

test('Workspace files reject traversal, symlinks, binary content, and oversized payloads', async () =>
  await withWorkspace(async ({ root, outside, service }) => {
    await writeText(`${outside}/secret.txt`, 'secret');
    await symlink(`${outside}/secret.txt`, `${root}/escape`);
    await writeBytes(`${root}/binary.dat`, new Uint8Array([0x66, 0, 0x6f]));

    for (const path of ['../secret.txt', '/tmp/secret.txt', 'src//main.ts', 'src/./main.ts', 'src\\main.ts']) {
      await assertRejects(
        () => service.read({ workspaceId: 'workspace', path }),
        WorkspaceFileError,
        'invalid',
      );
    }
    await assertRejects(
      () => service.read({ workspaceId: 'workspace', path: 'escape' }),
      WorkspaceFileError,
      'Symbolic links',
    );
    await assertRejects(
      () => service.read({ workspaceId: 'workspace', path: 'binary.dat' }),
      WorkspaceFileError,
      'UTF-8',
    );
    await assertRejects(
      () =>
        service.write({
          workspaceId: 'workspace',
          path: 'large.txt',
          content: 'x'.repeat(1_025),
          expectedContentHash: null,
        }),
      WorkspaceFileError,
      'too large',
    );
    await assertRejects(
      () => service.delete({ workspaceId: 'workspace', path: '', recursive: true }),
      WorkspaceFileError,
      'invalid',
    );
    await assertRejects(
      () => service.list({ workspaceId: 'other-workspace', path: '' }),
      WorkspaceFileError,
      'unavailable',
    );
  }));

test('Workspace file watches normalize changes and belong to one client session', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-product-watch-' });
  const watchers: FakeWatcher[] = [];
  const service = await WorkspaceFileService.open(
    [{ workspaceId: 'workspace', path: root }],
    { watchDebounceMs: 0 },
    {
      createId: () => 'watch-1',
      watchFs: () => {
        const watcher = new FakeWatcher();
        watchers.push(watcher);
        return watcher;
      },
    },
  );
  const notifications: unknown[] = [];
  const session = service.openWatchSession((notification) => notifications.push(notification));
  try {
    await mkdir(`${root}/src`);
    const realRoot = await realpath(root);
    assertEquals(await session.start({ workspaceId: 'workspace', paths: ['', 'src'] }), {
      subscriptionId: 'watch-1',
      paths: ['', 'src'],
    });
    watchers[0].emit({ kind: 'create', paths: [`${realRoot}/src/main.ts`] });
    for (let index = 0; index < 20 && notifications.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assertEquals(notifications.length, 1);
    assertEquals(notifications[0], {
      subscriptionId: 'watch-1',
      event: { kind: 'create', paths: ['src/main.ts'], affectedDirectories: ['src'] },
    });

    watchers[0].emit({ kind: 'other', paths: [], flag: 'rescan' });
    for (let index = 0; index < 20 && notifications.length === 1; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assertEquals(notifications[1], {
      subscriptionId: 'watch-1',
      event: { kind: 'other', paths: [], affectedDirectories: ['', 'src'], rescan: true },
    });

    assertEquals(await session.update({ subscriptionId: 'watch-1', paths: ['src'] }), {
      subscriptionId: 'watch-1',
      paths: ['src'],
    });
    assertEquals(watchers[0].closed, true);
    session.close();
    assertEquals(watchers[1].closed, true);
    await assertRejects(
      async () => await session.stop({ subscriptionId: 'watch-1' }),
      WorkspaceFileError,
      'not found',
    );
  } finally {
    service.close();
    await removePath(root, { recursive: true }).catch(() => undefined);
  }
});
