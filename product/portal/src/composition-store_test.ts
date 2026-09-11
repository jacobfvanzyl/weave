import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompositionStore } from './composition-store';
import { ThreadCatalog } from './catalog';

const pane = (id: string, terminalId = id) => ({ kind: 'terminal', nodeId: `node-${id}`, paneId: `pane-${id}`, terminalId });
test('migration preserves identities, recovers ambiguous Threads into dedicated Workspaces, and resumes after the layout write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-workspace-migration-'));
  try {
    await mkdir(join(root, 'compositions'));
    for (const [context, count] of [['zero', 0], ['one', 1], ['many', 2]] as const) {
      await writeFile(join(root, 'compositions', createHash('sha256').update(context).digest('hex') + '.json'), JSON.stringify({ schemaVersion: 1, workspaceId: context, revision: 7, tabs: Array.from({ length: count }, (_, index) => ({ tabId: `${context}-${index}`, name: 'Same directory', layout: pane(`${context}-${index}`) })) }));
    }
    const legacy = ['zero', 'one', 'many'].map((workspaceId) => ({ threadId: workspaceId, workspaceId, agentId: 'agent', acpSessionId: `session-${workspaceId}`, status: workspaceId === 'many' ? 'archived' : 'active', createdAt: '2026-09-10', updatedAt: '2026-09-10' }));
    await writeFile(join(root, 'threads.json'), JSON.stringify({ version: 1, threads: legacy }));
    const store = new CompositionStore(root);
    await store.migrate('host', ['zero', 'one', 'many']);
    const before = await store.get('host');
    const restarted = new CompositionStore(root);
    await restarted.migrate('host', ['zero', 'one', 'many']);
    expect(await restarted.get('host')).toEqual(before);
    expect(before.workspaces.map((workspace) => workspace.workspaceId)).toEqual(['one-0', 'many-0', 'many-1']);
    const resolve = (id: string, preferred?: string, assigned?: string[]) => restarted.ensureThreadWorkspace('host', id, id, preferred, assigned);
    const catalog = new ThreadCatalog(root); await catalog.load(resolve);
    expect(catalog.get('one')).toMatchObject({ workspaceId: 'one-0', executionContextId: 'one', acpSessionId: 'session-one' });
    expect(catalog.get('zero')?.workspaceId).toMatch(/^recovered-/);
    expect(catalog.get('many')).toMatchObject({ status: 'archived', acpSessionId: 'session-many' });
    expect(catalog.get('many')?.workspaceId).toMatch(/^recovered-/);
    const migrated = await restarted.get('host');
    expect(migrated.workspaces).toHaveLength(5);
    const runtimeSnapshot = { ...catalog.get('one')! };
    const moved = await catalog.assign('one', 'many-0', 1);
    await catalog.put({ ...runtimeSnapshot, title: 'Runtime title update' });
    expect(catalog.get('one')).toMatchObject({ workspaceId: 'many-0', membershipRevision: 2, title: 'Runtime title update', executionContextId: 'one' });
    await expect(catalog.assign('one', 'one-0', 0)).rejects.toThrow('assignment changed');
    const reopened = new ThreadCatalog(root); await reopened.load(resolve);
    expect(reopened.get('one')?.workspaceId).toBe(moved.workspaceId);
    await reopened.assign('one', 'one-0', 2);
    expect(reopened.get('one')?.executionContextId).toBe('one');
    expect(await restarted.get('host')).toEqual(migrated);
    expect(JSON.parse(await readFile(join(root, 'threads.json'), 'utf8')).version).toBe(3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unsupported persisted compositions fail closed without replacing layout data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-workspace-corruption-'));
  try {
    const store = new CompositionStore(root); await store.migrate('host', []);
    const file = join(root, 'compositions', (await readdir(join(root, 'compositions')))[0]!);
    const preserved = JSON.stringify({ schemaVersion: 99, hostId: 'host', revision: 20, workspaces: [{ future: 'user arrangement' }] });
    await writeFile(file, preserved);
    await expect(store.get('host')).rejects.toThrow('Unsupported');
    await expect(store.replace('host', 0, [], async () => undefined)).rejects.toThrow('Unsupported');
    expect(await readFile(file, 'utf8')).toBe(preserved);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('schema-2 migration preserves assignments and resumes after recovering destinations before saving Threads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-required-membership-'));
  try {
    const store = new CompositionStore(root); await store.migrate('host', []);
    await store.replace('host', 0, [{ workspaceId: 'kept', name: 'Kept', layout: null }], async () => undefined);
    const record = { agentId: 'agent', acpSessionId: 'session', executionContextId: 'context', status: 'archived', createdAt: '2026-09-10', updatedAt: '2026-09-10', membershipRevision: 4 };
    const records = [{ ...record, threadId: 'assigned', workspaceId: 'kept' }, { ...record, threadId: 'unassigned', executionContextId: 'other', workspaceId: null }, { ...record, threadId: 'also-unassigned', executionContextId: 'other', workspaceId: null }];
    await writeFile(join(root, 'threads.json'), JSON.stringify({ version: 2, threads: records }));
    const resolve = (id: string, preferred?: string, assigned?: string[]) => store.ensureThreadWorkspace('host', id, id, preferred, assigned);
    const interrupted = new ThreadCatalog(root);
    await expect(interrupted.load(async (...args) => { const destination = await resolve(...args); if (args[0] === 'other') throw new Error('Interrupted catalog migration'); return destination; })).rejects.toThrow('Interrupted');
    const catalog = new ThreadCatalog(root); await catalog.load(resolve);
    expect(catalog.get('assigned')).toMatchObject({ workspaceId: 'kept', membershipRevision: 4, acpSessionId: 'session', status: 'archived' });
    expect(catalog.get('unassigned')).toMatchObject({ membershipRevision: 5, acpSessionId: 'session', status: 'archived', executionContextId: 'other' });
    expect(catalog.get('unassigned')?.workspaceId).toBe(catalog.get('also-unassigned')?.workspaceId);
    const saved = await store.get('host');
    expect(saved.workspaces).toHaveLength(2);
    await new ThreadCatalog(root).load(resolve);
    expect(await store.get('host')).toEqual(saved);
    await expect(catalog.assign('assigned', null as unknown as string, 4)).rejects.toThrow('required');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('terminal removal collapses nested splits, preserves Workspaces, and serializes with provisioning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-terminal-removal-'));
  try {
    const store = new CompositionStore(root); await store.migrate('host', []);
    const leaf = (id: string) => ({ ...pane(id), kind: 'terminal' as const, executionContextId: 'context' });
    const workspaces = [{ workspaceId: 'workspace', name: 'Retained workspace', layout: { kind: 'split' as const, nodeId: 'outer', axis: 'vertical' as const, ratio: 0.3, children: [leaf('one'), { kind: 'split' as const, nodeId: 'inner', axis: 'horizontal' as const, ratio: 0.6, children: [leaf('two'), leaf('three')] }] } }];
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const write = store.replace('host', 0, workspaces as any, async () => { entered(); await gate; });
    await started;
    const exit = store.removeTerminal('host', 'two');
    release(); await write;
    const pruned = await exit;
    expect(pruned.revision).toBe(2);
    expect(pruned.workspaces[0]?.layout).toEqual({ ...workspaces[0]!.layout, children: [leaf('one'), leaf('three')] });
    expect(await store.removeTerminal('host', 'two')).toEqual(pruned);
    await expect(store.reconcileTerminals('host', async () => { throw new Error('backend offline'); })).rejects.toThrow('backend offline');
    expect(await store.get('host')).toEqual(pruned);
    expect((await store.reconcileTerminals('host', async () => new Set(['three']))).workspaces[0]?.layout).toEqual(leaf('three'));
    const empty = await store.removeTerminal('host', 'three');
    expect(empty.workspaces).toEqual([{ workspaceId: 'workspace', name: 'Retained workspace', layout: null }]);
    expect((await new CompositionStore(root).get('host'))).toEqual(empty);
  } finally { await rm(root, { recursive: true, force: true }); }
});
