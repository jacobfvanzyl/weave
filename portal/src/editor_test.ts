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

Deno.test('PortalEditorHost rejects path traversal and symlinks that escape the Demiplane', async () =>
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
      assertEquals(await read.json(), {
        path: 'README.md',
        content: 'hello',
        version: (await host.read({ target: { workspacePath: root }, path: 'README.md' })).version,
      });
    } finally {
      terminalHost.dispose();
      await server.shutdown().catch(() => undefined);
    }
  }));
