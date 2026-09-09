import { test } from './test-support.ts';
import { mkdir, readText, realpath, removePath, stat, temporaryDirectory } from './host-files.ts';
import { assertEquals, assertRejects } from './test-support.ts';
import { WorkspaceCatalog } from './workspace-catalog.ts';

test('Workspace catalog durably registers valid Host-local directories', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-project-catalog-' });
  try {
    const project = `${root}/project`;
    const state = `${root}/state`;
    await mkdir(project);
    const catalog = await WorkspaceCatalog.open(state, []);
    const added = await catalog.add({ path: project, name: 'Project' });
    assertEquals(added.name, 'Project');
    assertEquals(catalog.list().map(({ workspaceId }) => workspaceId), [
      added.workspaceId,
    ]);

    const reopened = await WorkspaceCatalog.open(state, []);
    const projectPath = await realpath(project);
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
    assertEquals(
      (await stat(`${state}/workspaces.json`)).mode! & 0o777,
      0o600,
    );

    assertEquals(
      (await reopened.remove(added.workspaceId))?.workspaceId,
      added.workspaceId,
    );
    assertEquals(reopened.list(), []);
    assertEquals((await WorkspaceCatalog.open(state, [])).list(), []);
  } finally {
    await removePath(root, { recursive: true });
  }
});

test('Workspace catalog durably removes configured projects', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-project-catalog-' });
  try {
    const project = `${root}/project`;
    await mkdir(project);
    const catalog = await WorkspaceCatalog.open(`${root}/state`, [{
      workspaceId: 'configured',
      name: 'Configured',
      path: project,
    }]);

    assertEquals((await catalog.remove('configured'))?.workspaceId, 'configured');
    assertEquals(catalog.list(), []);

    const reopened = await WorkspaceCatalog.open(`${root}/state`, [{
      workspaceId: 'configured',
      name: 'Configured',
      path: project,
    }]);
    assertEquals(reopened.list(), []);
  } finally {
    await removePath(root, { recursive: true });
  }
});

test('Workspace catalog rejects an unavailable path without persisting it', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-project-catalog-' });
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
      () => readText(`${root}/state/workspaces.json`),
      { code: 'ENOENT' },
    );
  } finally {
    await removePath(root, { recursive: true });
  }
});
