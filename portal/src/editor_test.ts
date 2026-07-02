import { assertEquals, assertRejects } from 'jsr:@std/assert@1.0.19';
import { PortalEditorHost, type PortalEditorFsWatcher, type PortalEditorWatchEvent } from './editor.ts';
import { PortalTerminalHost, startTerminalControlServer } from './terminal.ts';

class FakeFsWatcher implements PortalEditorFsWatcher {
  readonly paths: string | string[];
  readonly options: { recursive: boolean };
  closed = false;
  private readonly events: Deno.FsEvent[] = [];
  private readonly resolvers: Array<(result: IteratorResult<Deno.FsEvent>) => void> = [];

  constructor(paths: string | string[], options: { recursive: boolean }) {
    this.paths = paths;
    this.options = options;
  }

  emit(event: Deno.FsEvent) {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: event, done: false });
      return;
    }
    this.events.push(event);
  }

  close() {
    this.closed = true;
    for (const resolver of this.resolvers.splice(0)) resolver({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  next(): Promise<IteratorResult<Deno.FsEvent>> {
    if (this.events.length > 0) return Promise.resolve({ value: this.events.shift()!, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => this.resolvers.push(resolve));
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

const waitForEventCount = async (events: unknown[], count: number) => {
  for (let index = 0; index < 50; index += 1) {
    if (events.length >= count) return;
    await tick();
  }
  throw new Error(`Timed out waiting for ${count} events.`);
};

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

Deno.test('PortalEditorHost normalizes debounced watch events', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-editor-watch-' });
  const watchers: FakeFsWatcher[] = [];
  const host = new PortalEditorHost({
    config: {},
    watchDebounceMs: 0,
    watchFs: (paths, options) => {
      const watcher = new FakeFsWatcher(paths, options);
      watchers.push(watcher);
      return watcher;
    },
  });
  const events: PortalEditorWatchEvent[] = [];

  try {
    await Deno.mkdir(`${root}/src`);
    const realRoot = await Deno.realPath(root);
    const realSrc = await Deno.realPath(`${root}/src`);
    const subscription = await host.watch({ target: { workspacePath: root }, paths: ['', 'src'] }, {
      onEvent: event => {
        events.push(event);
      },
    });

    assertEquals(subscription.getPaths(), ['', 'src']);
    assertEquals(watchers.length, 1);
    assertEquals(watchers[0].options, { recursive: false });
    assertEquals(watchers[0].paths, [realRoot, realSrc]);

    watchers[0].emit({ kind: 'create', paths: [`${realSrc}/new.ts`] });
    await waitForEventCount(events, 1);
    assertEquals(events[0], {
      kind: 'create',
      paths: ['src/new.ts'],
      affectedDirectories: ['src'],
    });

    watchers[0].emit({ kind: 'rename', paths: [`${realRoot}/old.ts`, `${realSrc}/new.ts`] });
    await waitForEventCount(events, 2);
    assertEquals(events[1], {
      kind: 'rename',
      paths: ['old.ts', 'src/new.ts'],
      affectedDirectories: ['', 'src'],
    });

    watchers[0].emit({ kind: 'other', paths: [], flag: 'rescan' });
    await waitForEventCount(events, 3);
    assertEquals(events[2], {
      kind: 'other',
      paths: [],
      affectedDirectories: ['', 'src'],
      rescan: true,
    });

    subscription.close();
    assertEquals(watchers[0].closed, true);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('PortalEditorHost rejects escaping watch paths and closes old watchers on update', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-editor-watch-update-' });
  const watchers: FakeFsWatcher[] = [];
  const host = new PortalEditorHost({
    config: {},
    watchFs: (paths, options) => {
      const watcher = new FakeFsWatcher(paths, options);
      watchers.push(watcher);
      return watcher;
    },
  });

  try {
    await Deno.mkdir(`${root}/src`);
    await assertRejects(
      () => host.watch({ target: { workspacePath: root }, paths: ['../outside'] }, { onEvent: () => undefined }),
      Error,
      'escape',
    );

    const subscription = await host.watch({ target: { workspacePath: root }, paths: [''] }, {
      onEvent: () => undefined,
    });
    assertEquals(watchers.length, 1);
    await subscription.update(['src']);
    assertEquals(watchers.length, 2);
    assertEquals(watchers[0].closed, true);
    subscription.close();
    assertEquals(watchers[1].closed, true);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

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

Deno.test('Portal local control serves editor watch websocket with token auth', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-editor-watch-control-' });
  const watchers: FakeFsWatcher[] = [];
  const host = new PortalEditorHost({
    config: {},
    watchDebounceMs: 0,
    watchFs: (paths, options) => {
      const watcher = new FakeFsWatcher(paths, options);
      watchers.push(watcher);
      return watcher;
    },
  });
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
    await Deno.mkdir(`${root}/src`);
    const realSrc = await Deno.realPath(`${root}/src`);
    const unauthorized = await fetch(`${baseUrl}/editor/watch`);
    assertEquals(unauthorized.status, 401);

    const socket = new WebSocket(`${baseUrl.replace(/^http:/, 'ws:')}/editor/watch?token=editor-token`);
    const messages: Array<Record<string, unknown>> = [];
    const waiters: Array<(message: Record<string, unknown>) => void> = [];
    const nextMessage = () =>
      messages.length > 0
        ? Promise.resolve(messages.shift()!)
        : new Promise<Record<string, unknown>>(resolve => waiters.push(resolve));
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else messages.push(message);
    };
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('socket failed'));
    });
    socket.send(JSON.stringify({
      type: 'watch.start',
      requestId: 'start-1',
      target: { workspacePath: root },
      paths: ['src'],
    }));

    assertEquals(await nextMessage(), {
      type: 'editor.watch.ready',
      requestId: 'start-1',
      paths: ['src'],
    });
    watchers[0].emit({ kind: 'create', paths: [`${realSrc}/new.ts`] });
    assertEquals(await nextMessage(), {
      type: 'editor.watch.change',
      event: {
        kind: 'create',
        paths: ['src/new.ts'],
        affectedDirectories: ['src'],
      },
    });
    socket.close();
  } finally {
    terminalHost.dispose();
    host.dispose();
    await server.shutdown().catch(() => undefined);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});
