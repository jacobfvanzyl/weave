import { test, assertEquals, assertRejects } from './test-support.ts';
import { mkdir, readText, realpath, removePath, temporaryDirectory, writeText } from './host-files.ts';
import { inspectDirectory, type DirectoryIdentity } from './directory-identity.ts';
import { ExecutionContextCatalog } from './workspace-catalog.ts';

const volume = 'uuid:11111111-1111-1111-1111-111111111111';
const replacementVolume = 'uuid:22222222-2222-2222-2222-222222222222';

test('Persistent directory identity resolves the actual volume and canonical path', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-volume-native-' });
  try {
    await mkdir(`${root}/child`);
    const first = await inspectDirectory(root);
    const child = await inspectDirectory(`${root}/child`);
    assertEquals(first.canonicalPath, await realpath(root));
    assertEquals(first.volumeId, child.volumeId);
    if (process.platform === 'darwin') assertEquals(first.volumeId?.startsWith('uuid:'), true);
  } finally { await removePath(root, { recursive: true }); }
});

test('Volume pins survive device renumbering but reject a replacement volume, inode, or path', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-volume-reboot-' });
  try {
    let identity: DirectoryIdentity = { canonicalPath: await realpath(root), device: 'old-device', inode: '42', volumeId: volume };
    const inspect = async () => ({ ...identity });
    const configured = [{ executionContextId: 'existing', name: 'Existing', path: root }];
    await ExecutionContextCatalog.open(`${root}/state`, configured, inspect);
    identity.device = 'new-device';
    const catalog = await ExecutionContextCatalog.open(`${root}/state`, configured, inspect);
    assertEquals((await catalog.requireAvailable('existing')).executionContextId, 'existing');
    const stored = JSON.parse(await readText(`${root}/state/workspaces.json`));
    assertEquals(stored.contextPins[0].volumeId, volume);
    assertEquals(stored.contextPins[0].device, 'new-device');
    const original = { ...identity };
    for (const changed of [{ volumeId: replacementVolume }, { inode: '43' }, { canonicalPath: `${root}/replacement` }, { volumeId: undefined }]) {
      identity = { ...original, ...changed };
      await assertRejects(() => catalog.requireAvailable('existing'), Error, 'unavailable');
      assertEquals(catalog.list()[0].availability, 'path-changed');
    }
    identity = { ...original, volumeId: replacementVolume };
    await assertRejects(() => catalog.add({ path: root }), Error, 'identity has changed');
    assertEquals(JSON.parse(await readText(`${root}/state/workspaces.json`)).contextPins[0].volumeId, volume);
    identity = original;
    assertEquals((await catalog.requireAvailable('existing')).availability, 'available');
  } finally { await removePath(root, { recursive: true }); }
});

test('Legacy pins gain a volume UUID only after the complete old identity matches', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-volume-migration-' });
  try {
    await mkdir(`${root}/state`);
    const canonicalPath = await realpath(root);
    const state = { version: 2, executionContexts: [{ executionContextId: 'existing', name: 'Existing', path: root }], contextPins: [{ executionContextId: 'existing', canonicalPath, device: 'old-device', inode: '42' }] };
    await writeText(`${root}/state/workspaces.json`, JSON.stringify(state));
    let device = 'new-device';
    const inspect = async () => ({ canonicalPath, device, inode: '42', volumeId: volume });
    const catalog = await ExecutionContextCatalog.open(`${root}/state`, [], inspect);
    assertEquals(catalog.list()[0].availability, 'path-changed');
    assertEquals(JSON.parse(await readText(`${root}/state/workspaces.json`)).contextPins, state.contextPins);
    device = 'old-device';
    assertEquals((await catalog.requireAvailable('existing')).availability, 'available');
    assertEquals(JSON.parse(await readText(`${root}/state/workspaces.json`)).contextPins[0].volumeId, volume);
    device = 'new-device';
    assertEquals((await (await ExecutionContextCatalog.open(`${root}/state`, [], inspect)).requireAvailable('existing')).availability, 'available');
  } finally { await removePath(root, { recursive: true }); }
});

test('Unavailable volume inspection retains pins and recovers without re-registration', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-volume-unavailable-' });
  try {
    let unavailable = false;
    const identity = { canonicalPath: await realpath(root), device: 'device', inode: '42', volumeId: volume };
    const inspect = async () => { if (unavailable) throw new Error('Volume query failed'); return identity; };
    const catalog = await ExecutionContextCatalog.open(`${root}/state`, [{ executionContextId: 'existing', name: 'Existing', path: root }], inspect);
    const before = await readText(`${root}/state/workspaces.json`);
    unavailable = true;
    await assertRejects(() => catalog.requireAvailable('existing'));
    assertEquals(catalog.list()[0].availability, 'unavailable');
    assertEquals(await readText(`${root}/state/workspaces.json`), before);
    unavailable = false;
    assertEquals((await catalog.requireAvailable('existing')).availability, 'available');
  } finally { await removePath(root, { recursive: true }); }
});
