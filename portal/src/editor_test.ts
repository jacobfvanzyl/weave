import { assertEquals, assertRejects } from 'jsr:@std/assert@1.0.19';
import { PortalEditorHost } from './editor.ts';
import { PortalTerminalHost, startTerminalControlServer } from './terminal.ts';

const withEditorHost = async (
  callback: (context: { root: string; outside: string; host: PortalEditorHost }) => Promise<void>,
) => {
  const root = await Deno.makeTempDir({ prefix: 'weave-editor-root-' });
  const outside = await Deno.makeTempDir({ prefix: 'weave-editor-outside-' });
  const host = new PortalEditorHost({ config: {}, maxReadBytes: 1024 });

  try {
    await callback({ root: await Deno.realPath(root), outside: await Deno.realPath(outside), host });
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
    await Deno.remove(outside, { recursive: true }).catch(() => undefined);
  }
};

Deno.test('PortalEditorHost lists directories before files and reads UTF-8 text files', async () =>
  await withEditorHost(async ({ root, host }) => {
    await Deno.mkdir(`${root}/src`);
    await Deno.writeTextFile(`${root}/README.md`, '# hello\n');

    const listResult = await host.list({ target: { workspacePath: root }, path: '' });
    assertEquals(listResult.entries.map((entry) => `${entry.type}:${entry.name}`), [
      'directory:src',
      'file:README.md',
    ]);

    const file = await host.read({ target: { workspacePath: root }, path: 'README.md' });
    assertEquals(file.path, 'README.md');
    assertEquals(file.content, '# hello\n');
    assertEquals(file.version.includes(':'), true);
    assertEquals(file.size, 8);
    assertEquals(typeof file.mtimeMs, 'number');
  }));

Deno.test('PortalEditorHost writes text files and rejects stale saves', async () =>
  await withEditorHost(async ({ root, host }) => {
    await Deno.writeTextFile(`${root}/notes.txt`, 'first');
    const file = await host.read({ target: { workspacePath: root }, path: 'notes.txt' });

    const saved = await host.write({
      target: { workspacePath: root },
      path: 'notes.txt',
      content: 'second',
      version: file.version,
    });
    assertEquals(await Deno.readTextFile(`${root}/notes.txt`), 'second');

    await Deno.writeTextFile(`${root}/notes.txt`, 'external');
    await assertRejects(
      () =>
        host.write({
          target: { workspacePath: root },
          path: 'notes.txt',
          content: 'third',
          version: saved.version,
        }),
      Error,
      'Reload before saving',
    );
  }));

Deno.test('PortalEditorHost rejects path traversal and symlinks that escape the Workspace', async () =>
  await withEditorHost(async ({ root, outside, host }) => {
    await Deno.writeTextFile(`${outside}/secret.txt`, 'nope');
    await assertRejects(
      () => host.read({ target: { workspacePath: root }, path: '../secret.txt' }),
      Error,
      'escape',
    );

    await Deno.symlink(`${outside}/secret.txt`, `${root}/secret-link`);
    await assertRejects(
      () => host.read({ target: { workspacePath: root }, path: 'secret-link' }),
      Error,
      'escape',
    );
  }));

Deno.test('PortalEditorHost rejects binary, oversized, and missing-parent writes', async () =>
  await withEditorHost(async ({ root, host }) => {
    await Deno.writeFile(`${root}/bin.dat`, new Uint8Array([0x66, 0x00, 0x6f]));
    await Deno.writeTextFile(`${root}/big.txt`, 'x'.repeat(1025));

    await assertRejects(
      () => host.read({ target: { workspacePath: root }, path: 'bin.dat' }),
      Error,
      'Binary',
    );
    await assertRejects(
      () => host.read({ target: { workspacePath: root }, path: 'big.txt' }),
      Error,
      'too large',
    );
    await assertRejects(
      () => host.write({ target: { workspacePath: root }, path: 'missing/file.txt', content: 'nope' }),
      Error,
    );
  }));

Deno.test('PortalEditorHost creates, moves, and deletes files and directories', async () =>
  await withEditorHost(async ({ root, host }) => {
    const target = { workspacePath: root };
    assertEquals(await host.mkdir({ target, path: 'src/nested' }), { ok: true, path: 'src/nested' });

    const saved = await host.write({ target, path: 'src/nested/README.md', content: 'hello' });
    assertEquals(saved.path, 'src/nested/README.md');
    assertEquals(saved.size, 5);

    assertEquals(await host.move({ target, fromPath: 'src/nested/README.md', toPath: 'src/README.md' }), {
      ok: true,
      path: 'src/README.md',
    });
    assertEquals(await Deno.readTextFile(`${root}/src/README.md`), 'hello');

    await host.write({ target, path: 'src/existing.md', content: 'existing' });
    assertEquals(await host.move({ target, fromPath: 'src/README.md', toPath: 'src/existing.md', overwrite: true }), {
      ok: true,
      path: 'src/existing.md',
    });
    assertEquals(await Deno.readTextFile(`${root}/src/existing.md`), 'hello');

    await assertRejects(
      () => host.delete({ target, path: 'src', recursive: false }),
      Error,
    );
    assertEquals(await host.delete({ target, path: 'src', recursive: true }), { ok: true, path: 'src' });
    await assertRejects(
      () => Deno.stat(`${root}/src`),
      Deno.errors.NotFound,
    );
  }));

Deno.test('PortalEditorHost rejects traversal in create, move, and delete operations', async () =>
  await withEditorHost(async ({ root, host }) => {
    const target = { workspacePath: root };
    await Deno.writeTextFile(`${root}/note.md`, 'hello');

    await assertRejects(
      () => host.mkdir({ target, path: '../outside' }),
      Error,
      'escape',
    );
    await assertRejects(
      () => host.move({ target, fromPath: 'note.md', toPath: '../outside.md' }),
      Error,
      'escape',
    );
    await assertRejects(
      () => host.delete({ target, path: '../outside.md' }),
      Error,
      'escape',
    );
  }));

Deno.test('Portal local control serves editor requests with token auth', async () =>
  await withEditorHost(async ({ root, host }) => {
    await Deno.writeTextFile(`${root}/README.md`, 'hello');
    const terminalHost = new PortalTerminalHost({ config: {} });
    const server = startTerminalControlServer({
      host: terminalHost,
      editor: host,
      hostname: '127.0.0.1',
      port: 0,
      token: 'editor-token',
      metadata: { portalId: 'portal_test' },
    });
    const baseUrl = `http://127.0.0.1:${server.addr.port}`;

    try {
      const unauthorized = await fetch(`${baseUrl}/editor/list`, { method: 'POST' });
      assertEquals(unauthorized.status, 401);

      const list = await fetch(`${baseUrl}/editor/list?token=editor-token`, {
        method: 'POST',
        body: JSON.stringify({ target: { workspacePath: root }, path: '' }),
      });
      assertEquals(list.ok, true);
      assertEquals((await list.json()).entries.map((entry: { name: string }) => entry.name), ['README.md']);

      const read = await fetch(`${baseUrl}/editor/read?token=editor-token`, {
        method: 'POST',
        body: JSON.stringify({ target: { workspacePath: root }, path: 'README.md' }),
      });
      const readBody = await read.json() as { path: string; content: string; version: string; size?: number; mtimeMs?: number };
      assertEquals(readBody.path, 'README.md');
      assertEquals(readBody.content, 'hello');
      assertEquals(readBody.version, (await host.read({ target: { workspacePath: root }, path: 'README.md' })).version);
      assertEquals(readBody.size, 5);
      assertEquals(typeof readBody.mtimeMs, 'number');

      const mkdir = await fetch(`${baseUrl}/editor/mkdir?token=editor-token`, {
        method: 'POST',
        body: JSON.stringify({ target: { workspacePath: root }, path: 'src' }),
      });
      assertEquals(await mkdir.json(), { ok: true, path: 'src' });
    } finally {
      terminalHost.dispose();
      await server.shutdown().catch(() => undefined);
    }
  }));
