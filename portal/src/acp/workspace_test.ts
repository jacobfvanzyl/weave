import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { resolveHostWorkspace } from './workspace.ts';

Deno.test('Host resolves a connector working directory to the narrowest configured root', async () => {
  const parent = await Deno.makeTempDir({ prefix: 'weave-host-workspace-' });
  const project = `${parent}/project`;
  const child = `${project}/packages/client`;
  await Deno.mkdir(child, { recursive: true });

  try {
    const roots = new Map([
      ['code', await Deno.realPath(parent)],
      ['project', await Deno.realPath(project)],
    ]);
    assertEquals(await resolveHostWorkspace(roots, { workspacePath: child }), {
      workspaceId: 'project',
      path: await Deno.realPath(child),
    });
    assertEquals(await resolveHostWorkspace(roots, { workspaceId: 'code' }), {
      workspaceId: 'code',
      path: await Deno.realPath(parent),
    });
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test('Host rejects connector paths outside configured roots without disclosing them', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-host-allowed-' });
  const outside = await Deno.makeTempDir({ prefix: 'weave-host-outside-' });
  const escape = `${root}/escape`;
  await Deno.symlink(outside, escape);

  try {
    const roots = new Map([['private-workspace-name', await Deno.realPath(root)]]);
    for (const workspacePath of [outside, escape, `${root}/missing`]) {
      await assertRejects(
        () => resolveHostWorkspace(roots, { workspacePath }),
        Error,
        'Workspace is unavailable.',
      );
    }
    await assertRejects(
      () => resolveHostWorkspace(roots, { workspaceId: 'missing' }),
      Error,
      'Workspace is unavailable.',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test('Host requires exactly one workspace selector', async () => {
  const roots = new Map([['default', '/workspace']]);
  for (
    const selection of [
      {},
      { workspaceId: 'default', workspacePath: '/workspace' },
    ]
  ) {
    await assertRejects(
      () => resolveHostWorkspace(roots, selection),
      Error,
      'Workspace is unavailable.',
    );
  }
});
