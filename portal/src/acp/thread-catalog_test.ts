import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { FileThreadCatalog } from './thread-catalog.ts';

Deno.test('Host Thread catalog persists ACP sessions and scopes discovery by Workspace', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'weave-host-threads-' });
  const path = `${directory}/threads.json`;
  let tick = 0;
  const catalog = await FileThreadCatalog.open(path, {
    createId: () => 'thread-1',
    now: () => new Date(`2026-08-23T00:00:0${tick++}.000Z`),
  });
  try {
    const created = await catalog.upsertAcpSession({
      agentId: 'codex',
      workspaceId: 'odin',
      acpSessionId: 'codex-session-1',
      creatorPrincipalId: 'local',
    });
    assertEquals(created.threadId, 'thread-1');
    assertEquals((await catalog.list({ workspaceIds: new Set(['other']) })).length, 0);
    assertEquals((await catalog.list({ workspaceIds: new Set(['odin']) }))[0].acpSessionId, 'codex-session-1');

    await catalog.setAcpSessionStatus('codex', 'odin', 'codex-session-1', 'closed');
    const reopened = await FileThreadCatalog.open(path);
    assertEquals((await reopened.get('thread-1', { workspaceIds: new Set(['odin']) }))?.status, 'closed');

    await reopened.upsertAcpSession({
      agentId: 'codex',
      workspaceId: 'odin',
      acpSessionId: 'codex-session-1',
      creatorPrincipalId: 'remote',
    });
    assertEquals((await reopened.list({ workspaceIds: new Set(['odin']) }))[0].status, 'active');
    const file = await Deno.stat(path);
    assertEquals(file.mode! & 0o777, 0o600);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Host Thread catalog refuses invalid persisted state', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'weave-host-threads-invalid-' });
  const path = `${directory}/threads.json`;
  try {
    await Deno.writeTextFile(path, '{"version":1,"threads":[{}]}');
    await assertRejects(() => FileThreadCatalog.open(path), Error, 'catalog is invalid');
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
