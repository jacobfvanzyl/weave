import { assertEquals } from 'jsr:@std/assert@1';
import { FileRuntimeStateStore, InMemoryRuntimeStateStore, type RuntimeStream } from './runtime-state.ts';

const stream: RuntimeStream = {
  agentId: 'codex',
  workspaceId: 'workspace-1',
  acpSessionId: 'session-1',
};

Deno.test('Host runtime state increments durable generations and fences stale transitions', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'weave-runtime-state-' });
  const path = `${directory}/runtime-state.json`;
  let timestamp = 0;
  const now = () => new Date(Date.UTC(2026, 7, 23, 12, 0, timestamp++));
  try {
    const store = await FileRuntimeStateStore.open(path, { now });
    const first = await store.start(stream, 'idle');
    assertEquals(first.generation, 1);
    assertEquals(first.state, 'idle');

    await store.transition(stream, first.generation, {
      state: 'exited',
      exit: {
        success: false,
        code: 1,
        signal: 'SIGTERM',
        error: 'provider exited',
        stderrTail: 'diagnostic',
      },
    });
    const second = await store.start(stream, 'restoring');
    assertEquals(second.generation, 2);
    assertEquals(second.state, 'restoring');
    assertEquals(second.lastExit?.code, 1);

    assertEquals(
      await store.transition(stream, first.generation, { state: 'idle' }),
      undefined,
    );
    await store.transition(stream, second.generation, { state: 'idle' });

    const reopened = await FileRuntimeStateStore.open(path);
    assertEquals((await reopened.get(stream))?.generation, 2);
    assertEquals((await reopened.get(stream))?.state, 'idle');
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Host runtime state bounds the persisted stderr tail', async () => {
  const store = new InMemoryRuntimeStateStore();
  const started = await store.start(stream, 'idle');
  await store.transition(stream, started.generation, {
    state: 'exited',
    exit: {
      success: false,
      code: 9,
      stderrTail: `prefix-${'😀'.repeat(3 * 1024)}`,
    },
  });
  const persisted = await store.get(stream);
  assertEquals(new TextEncoder().encode(persisted?.lastExit?.stderrTail).byteLength, 8 * 1024);
  assertEquals(persisted?.lastExit?.stderrTail.startsWith('prefix-'), false);
  assertEquals(persisted?.lastExit?.stderrTail.endsWith('😀'), true);
});
