import { test } from './test-support.ts';
import { mkdir, readText, realpath, removePath, rename, stat, symlink, temporaryDirectory, writeText } from './host-files.ts';
import { assertEquals, assertRejects } from './test-support.ts';
import { WorkspaceCatalog, workspaceSummary } from './workspace-catalog.ts';

test('Workspace contexts canonicalize aliases while preserving existing IDs', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-context-' });
  try {
    await mkdir(`${root}/checkout`);
    await mkdir(`${root}/other-worktree`);
    await mkdir(`${root}/state`);
    await symlink(`${root}/checkout`, `${root}/alias`);
    await writeText(`${root}/state/workspaces.json`, JSON.stringify({
      version: 1,
      workspaces: [{ workspaceId: 'existing', name: 'Existing', path: `${root}/checkout` }],
    }));
    const catalog = await WorkspaceCatalog.open(`${root}/state`, [
      { workspaceId: 'configured', name: 'Alias', path: `${root}/alias/` },
      { workspaceId: 'worktree', name: 'Same repository', path: `${root}/other-worktree` },
    ]);
    const summaries = catalog.list().map(workspaceSummary);
    assertEquals(summaries.map(({ workspaceId }) => workspaceId), ['configured', 'worktree', 'existing']);
    const canonicalPath = await realpath(`${root}/checkout`);
    assertEquals(summaries[0].canonicalPath, canonicalPath);
    assertEquals(summaries[2].canonicalPath, canonicalPath);
    assertEquals(summaries[1].canonicalPath, await realpath(`${root}/other-worktree`));
    assertEquals((await catalog.add({ path: `${root}/alias/.` })).workspaceId, 'configured');
    assertEquals(catalog.list().length, 3);
  } finally { await removePath(root, { recursive: true }); }
});

test('Workspace contexts preserve the filesystem root and deduplicate concurrent aliases', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-context-' });
  try {
    const catalog = await WorkspaceCatalog.open(`${root}/state`, []);
    const filesystem = await catalog.add({ path: '/', name: 'Filesystem' });
    assertEquals(filesystem.path, '/');
    assertEquals(workspaceSummary(filesystem).canonicalPath, '/');
    await mkdir(`${root}/checkout`);
    await symlink(`${root}/checkout`, `${root}/alias`);
    const [first, second] = await Promise.all([
      catalog.add({ path: `${root}/checkout` }),
      catalog.add({ path: `${root}/alias` }),
    ]);
    assertEquals(first.workspaceId, second.workspaceId);
    const reopened = await WorkspaceCatalog.open(`${root}/state`, []);
    assertEquals(reopened.list().map(({ workspaceId }) => workspaceId), [filesystem.workspaceId, first.workspaceId]);
  } finally { await removePath(root, { recursive: true }); }
});

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


test('Pinned contexts survive missing directories and reject symlink and inode replacements', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-context-lifetime-' });
  try {
    await mkdir(`${root}/checkout`);
    await mkdir(`${root}/other`);
    await symlink(`${root}/checkout`, `${root}/alias`);
    const configured = [{ workspaceId: 'stable-id', name: 'Checkout', path: `${root}/alias` }];
    let catalog = await WorkspaceCatalog.open(`${root}/state`, configured);
    const canonical = workspaceSummary(catalog.list()[0]!).canonicalPath;
    await removePath(`${root}/alias`);
    catalog = await WorkspaceCatalog.open(`${root}/state`, configured);
    assertEquals(workspaceSummary(catalog.list()[0]!).canonicalPath, canonical);
    assertEquals(catalog.list()[0]!.availability, 'unavailable');
    await assertRejects(() => catalog.requireAvailable('stable-id'));
    await symlink(`${root}/other`, `${root}/alias`);
    await catalog.refresh();
    assertEquals(catalog.list()[0]!.availability, 'path-changed');
    assertEquals(catalog.list()[0]!.path, canonical);
    await removePath(`${root}/alias`);
    await symlink(`${root}/checkout`, `${root}/alias`);
    assertEquals((await catalog.requireAvailable('stable-id')).availability, 'available');
    await rename(`${root}/checkout`, `${root}/original`);
    await mkdir(`${root}/checkout`);
    catalog = await WorkspaceCatalog.open(`${root}/state`, configured);
    assertEquals(catalog.list()[0]!.availability, 'path-changed');
    await assertRejects(() => catalog.add({ path: `${root}/checkout` }), Error, 'identity has changed');
    await removePath(`${root}/checkout`, { recursive: true });
    await rename(`${root}/original`, `${root}/checkout`);
    assertEquals((await catalog.requireAvailable('stable-id')).workspaceId, 'stable-id');
    // Editing configuration does not grant an existing opaque ID a different root.
    catalog = await WorkspaceCatalog.open(`${root}/state`, [{ ...configured[0]!, path: `${root}/other` }]);
    assertEquals(catalog.list()[0]!.availability, 'path-changed');
    assertEquals(catalog.list()[0]!.canonicalPath, canonical);
  } finally { await removePath(root, { recursive: true }); }
});

test('Legacy unavailable registrations remain inspectable without inventing a canonical identity', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-context-legacy-' });
  try {
    await mkdir(`${root}/state`);
    await writeText(`${root}/state/workspaces.json`, JSON.stringify({ version: 1, workspaces: [{ workspaceId: 'old-id', name: 'Old', path: `${root}/missing` }] }));
    const catalog = await WorkspaceCatalog.open(`${root}/state`, []);
    assertEquals(catalog.list()[0]!.workspaceId, 'old-id');
    assertEquals(workspaceSummary(catalog.list()[0]!).canonicalPath, undefined);
    assertEquals(catalog.list()[0]!.availability, 'unavailable');
    await mkdir(`${root}/missing`);
    assertEquals((await catalog.requireAvailable('old-id')).canonicalPath, await realpath(`${root}/missing`));
    const reopened = await WorkspaceCatalog.open(`${root}/state`, []);
    assertEquals(reopened.list()[0]!.workspaceId, 'old-id');
    assertEquals(reopened.list()[0]!.availability, 'available');
  } finally { await removePath(root, { recursive: true }); }
});
