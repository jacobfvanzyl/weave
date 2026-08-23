import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import type { JsonRpcMessage } from '@weave/protocol';
import { FileThreadEventJournal } from './thread-event-journal.ts';

const update = (sessionId: string, text: string): JsonRpcMessage => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    },
  },
});

Deno.test('Host Thread event journal persists ordered events and resumes after a cursor', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'weave-host-thread-events-' });
  const path = `${directory}/events.jsonl`;
  let eventId = 0;
  let tick = 0;
  const journal = await FileThreadEventJournal.open(path, {
    createId: () => `event-${++eventId}`,
    now: () => new Date(`2026-08-23T01:00:0${tick++}.000Z`),
  });
  const firstThread = { agentId: 'codex', workspaceId: 'odin', acpSessionId: 'session-1' };
  const secondThread = { agentId: 'codex', workspaceId: 'odin', acpSessionId: 'session-2' };

  try {
    assertEquals(await journal.append(firstThread, update('session-1', 'one')), {
      ...firstThread,
      sequence: 1,
      eventId: 'event-1',
      createdAt: '2026-08-23T01:00:00.000Z',
      message: update('session-1', 'one'),
    });
    assertEquals((await journal.append(firstThread, update('session-1', 'two'))).sequence, 2);
    assertEquals((await journal.append(secondThread, update('session-2', 'other'))).sequence, 1);

    const reopened = await FileThreadEventJournal.open(path);
    assertEquals(await reopened.list(firstThread, { afterSequence: 1 }), [{
      ...firstThread,
      sequence: 2,
      eventId: 'event-2',
      createdAt: '2026-08-23T01:00:01.000Z',
      message: update('session-1', 'two'),
    }]);
    assertEquals((await reopened.list(secondThread)).map((event) => event.sequence), [1]);
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Host Thread event journal refuses invalid or discontinuous persisted state', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'weave-host-thread-events-invalid-' });
  const path = `${directory}/events.jsonl`;
  try {
    await Deno.writeTextFile(
      path,
      [
        JSON.stringify({ version: 1 }),
        JSON.stringify({
          agentId: 'codex',
          workspaceId: 'odin',
          acpSessionId: 'session-1',
          sequence: 2,
          eventId: 'event-2',
          createdAt: '2026-08-23T01:00:00.000Z',
          message: update('session-1', 'two'),
        }),
        '',
      ].join('\n'),
    );
    await assertRejects(() => FileThreadEventJournal.open(path), Error, 'event journal is invalid');
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Host Thread event journal truncates an incomplete crash tail before appending', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'weave-host-thread-events-tail-' });
  const path = `${directory}/events.jsonl`;
  let eventId = 0;
  const thread = { agentId: 'codex', workspaceId: 'odin', acpSessionId: 'session-1' };
  try {
    const journal = await FileThreadEventJournal.open(path, { createId: () => `event-${++eventId}` });
    await journal.append(thread, update('session-1', 'one'));
    await Deno.writeTextFile(path, '{"partial":', { append: true });

    const reopened = await FileThreadEventJournal.open(path, { createId: () => `event-${++eventId}` });
    assertEquals((await reopened.list(thread)).map((event) => event.sequence), [1]);
    assertEquals((await reopened.append(thread, update('session-1', 'two'))).sequence, 2);
    assertEquals(await (await FileThreadEventJournal.open(path)).list(thread).then((events) => events.length), 2);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Host Thread event journal compacts each stream and persists its replay watermark', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'weave-host-thread-events-retention-' });
  const path = `${directory}/events.jsonl`;
  let eventId = 0;
  const thread = { agentId: 'codex', workspaceId: 'odin', acpSessionId: 'session-1' };
  try {
    const journal = await FileThreadEventJournal.open(path, {
      createId: () => `event-${++eventId}`,
      maxEventsPerStream: 2,
    });
    for (const text of ['one', 'two', 'three', 'four']) await journal.append(thread, update('session-1', text));

    assertEquals(await journal.read(thread), {
      events: [
        { ...(await journal.list(thread))[0], sequence: 3 },
        { ...(await journal.list(thread))[1], sequence: 4 },
      ],
      compactedThrough: 2,
      lastSequence: 4,
      cursorExpired: true,
    });
    assertEquals((await journal.read(thread, { afterSequence: 2 })).cursorExpired, false);

    const reopened = await FileThreadEventJournal.open(path, {
      createId: () => `event-${++eventId}`,
      maxEventsPerStream: 2,
    });
    assertEquals(await reopened.read(thread, { afterSequence: 2 }), {
      events: await reopened.list(thread),
      compactedThrough: 2,
      lastSequence: 4,
      cursorExpired: false,
    });
    assertEquals((await reopened.append(thread, update('session-1', 'five'))).sequence, 5);
    assertEquals((await reopened.list(thread)).map(({ sequence }) => sequence), [4, 5]);
    assertEquals((await reopened.read(thread, { afterSequence: 2 })).compactedThrough, 3);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
