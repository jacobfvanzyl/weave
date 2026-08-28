import { assertEquals, assertRejects } from 'jsr:@std/assert@1.0.14';
import { WorkspaceCatalog } from './workspace-catalog.ts';

Deno.test('Workspace catalog durably registers valid Host-local directories', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-project-catalog-' });
  try {
    const project = `${root}/project`;
    const state = `${root}/state`;
    await Deno.mkdir(project);
    const catalog = await WorkspaceCatalog.open(state, []);
    const added = await catalog.add({ path: project, name: 'Project' });
    assertEquals(added.name, 'Project');
    assertEquals(catalog.list().map(({ workspaceId }) => workspaceId), [
      added.workspaceId,
    ]);

    const reopened = await WorkspaceCatalog.open(state, []);
    const projectPath = await Deno.realPath(project);
    assertEquals(
      reopened.list().map(({ workspaceId, name, path }) => ({
        workspaceId,
        name,
        path,
      })),
      [{
        workspaceId: added.workspaceId,
        name: 'Project',
        path: projectPath,
      }],
    );
    assertEquals((await Deno.stat(`${state}/workspaces.json`)).mode! & 0o777, 0o600);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Workspace catalog rejects an unavailable path without persisting it', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-project-catalog-' });
  try {
    const catalog = await WorkspaceCatalog.open(`${root}/state`, []);
    await assertRejects(
      () => catalog.add({ path: 'relative/project' }),
      Error,
      'absolute',
    );
    await assertRejects(() => catalog.add({ path: `${root}/missing` }));
    assertEquals(catalog.list(), []);
    await assertRejects(
      () => Deno.readTextFile(`${root}/state/workspaces.json`),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
