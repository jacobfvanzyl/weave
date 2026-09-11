import { test } from './test-support.ts';
import { mkdir, readText, realpath, removePath, rename, stat, symlink, temporaryDirectory, writeText } from './host-files.ts';
import { assertEquals, assertRejects } from './test-support.ts';
import { ExecutionContextCatalog, workspaceSummary } from './workspace-catalog.ts';

test('Workspace contexts canonicalize aliases while preserving existing IDs', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-context-' });
  try {
    await mkdir(`${root}/checkout`);
    await mkdir(`${root}/other-worktree`);
    await mkdir(`${root}/state`);
    await symlink(`${root}/checkout`, `${root}/alias`);
    await writeText(`${root}/state/workspaces.json`, JSON.stringify({
      version: 1,
      executionContexts: [{ executionContextId: 'existing', name: 'Existing', path: `${root}/checkout` }],
    }));
    const catalog = await ExecutionContextCatalog.open(`${root}/state`, [
      { executionContextId: 'configured', name: 'Alias', path: `${root}/alias/` },
      { executionContextId: 'worktree', name: 'Same repository', path: `${root}/other-worktree` },
    ]);
    const summaries = catalog.list().map(workspaceSummary);
    assertEquals(summaries.map(({ executionContextId }) => executionContextId), ['configured', 'worktree', 'existing']);
    const canonicalPath = await realpath(`${root}/checkout`);
    assertEquals(summaries[0].canonicalPath, canonicalPath);
    assertEquals(summaries[2].canonicalPath, canonicalPath);
    assertEquals(summaries[1].canonicalPath, await realpath(`${root}/other-worktree`));
    assertEquals((await catalog.add({ path: `${root}/alias/.` })).executionContextId, 'configured');
    assertEquals(catalog.list().length, 3);
  } finally { await removePath(root, { recursive: true }); }
});

test('Workspace contexts preserve the filesystem root and deduplicate concurrent aliases', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-context-' });
  try {
    const catalog = await ExecutionContextCatalog.open(`${root}/state`, []);
    const filesystem = await catalog.add({ path: '/', name: 'Filesystem' });
    assertEquals(filesystem.path, '/');
    assertEquals(workspaceSummary(filesystem).canonicalPath, '/');
    await mkdir(`${root}/checkout`);
    await symlink(`${root}/checkout`, `${root}/alias`);
    const [first, second] = await Promise.all([
      catalog.add({ path: `${root}/checkout` }),
      catalog.add({ path: `${root}/alias` }),
    ]);
    assertEquals(first.executionContextId, second.executionContextId);
    const reopened = await ExecutionContextCatalog.open(`${root}/state`, []);
    assertEquals(reopened.list().map(({ executionContextId }) => executionContextId), [filesystem.executionContextId, first.executionContextId]);
  } finally { await removePath(root, { recursive: true }); }
});

test('Workspace catalog durably registers valid Host-local directories', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-project-catalog-' });
  try {
    const project = `${root}/project`;
    const state = `${root}/state`;
    await mkdir(project);
    const catalog = await ExecutionContextCatalog.open(state, []);
    const added = await catalog.add({ path: project, name: 'ExecutionContext' });
    assertEquals(added.name, 'ExecutionContext');
    assertEquals(catalog.list().map(({ executionContextId }) => executionContextId), [
      added.executionContextId,
    ]);

    const reopened = await ExecutionContextCatalog.open(state, []);
    const projectPath = await realpath(project);
    assertEquals(
      reopened.list().map(({ executionContextId, name, path }) => ({
        executionContextId,
        name,
        path,
      })),
      [{
        executionContextId: added.executionContextId,
        name: 'ExecutionContext',
        path: projectPath,
      }],
    );
    assertEquals(
      (await stat(`${state}/workspaces.json`)).mode! & 0o777,
      0o600,
    );

    assertEquals(
      (await reopened.remove(added.executionContextId))?.executionContextId,
      added.executionContextId,
    );
    assertEquals(reopened.list(), []);
    assertEquals((await ExecutionContextCatalog.open(state, [])).list(), []);
  } finally {
    await removePath(root, { recursive: true });
  }
});

test('Workspace catalog durably removes configured projects', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-project-catalog-' });
  try {
    const project = `${root}/project`;
    await mkdir(project);
    const catalog = await ExecutionContextCatalog.open(`${root}/state`, [{
      executionContextId: 'configured',
      name: 'Configured',
      path: project,
    }]);

    assertEquals((await catalog.remove('configured'))?.executionContextId, 'configured');
    assertEquals(catalog.list(), []);

    const reopened = await ExecutionContextCatalog.open(`${root}/state`, [{
      executionContextId: 'configured',
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
    const catalog = await ExecutionContextCatalog.open(`${root}/state`, []);
    await assertRejects(
      () => catalog.add({ path: 'relative/project' }),
      Error,
      'absolute',
    );
    await assertRejects(() => catalog.add({ path: `${root}/missing` }));
    assertEquals(catalog.list(), []);
    assertEquals(JSON.parse(await readText(`${root}/state/workspaces.json`)).executionContexts, []);
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
    const configured = [{ executionContextId: 'stable-id', name: 'Checkout', path: `${root}/alias` }];
    let catalog = await ExecutionContextCatalog.open(`${root}/state`, configured);
    const canonical = workspaceSummary(catalog.list()[0]!).canonicalPath;
    await removePath(`${root}/alias`);
    catalog = await ExecutionContextCatalog.open(`${root}/state`, configured);
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
    catalog = await ExecutionContextCatalog.open(`${root}/state`, configured);
    assertEquals(catalog.list()[0]!.availability, 'path-changed');
    await assertRejects(() => catalog.add({ path: `${root}/checkout` }), Error, 'identity has changed');
    await removePath(`${root}/checkout`, { recursive: true });
    await rename(`${root}/original`, `${root}/checkout`);
    assertEquals((await catalog.requireAvailable('stable-id')).executionContextId, 'stable-id');
    // Editing configuration does not grant an existing opaque ID a different root.
    catalog = await ExecutionContextCatalog.open(`${root}/state`, [{ ...configured[0]!, path: `${root}/other` }]);
    assertEquals(catalog.list()[0]!.availability, 'path-changed');
    assertEquals(catalog.list()[0]!.canonicalPath, canonical);
  } finally { await removePath(root, { recursive: true }); }
});

test('Legacy unavailable registrations remain inspectable without inventing a canonical identity', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-context-legacy-' });
  try {
    await mkdir(`${root}/state`);
    await writeText(`${root}/state/workspaces.json`, JSON.stringify({ version: 1, executionContexts: [{ executionContextId: 'old-id', name: 'Old', path: `${root}/missing` }] }));
    const catalog = await ExecutionContextCatalog.open(`${root}/state`, []);
    assertEquals(catalog.list()[0]!.executionContextId, 'old-id');
    assertEquals(workspaceSummary(catalog.list()[0]!).canonicalPath, undefined);
    assertEquals(catalog.list()[0]!.availability, 'unavailable');
    await mkdir(`${root}/missing`);
    assertEquals((await catalog.requireAvailable('old-id')).canonicalPath, await realpath(`${root}/missing`));
    const reopened = await ExecutionContextCatalog.open(`${root}/state`, []);
    assertEquals(reopened.list()[0]!.executionContextId, 'old-id');
    assertEquals(reopened.list()[0]!.availability, 'available');
  } finally { await removePath(root, { recursive: true }); }
});
