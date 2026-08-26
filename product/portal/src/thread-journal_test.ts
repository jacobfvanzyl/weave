import { assertEquals } from 'jsr:@std/assert@1.0.14';
import { ThreadEventJournal } from './thread-journal.ts';

Deno.test('Thread journal clears only non-conversational state for provider replacement', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-product-portal-journal-replacement-' });
  try {
    const journal = await ThreadEventJournal.open(root);
    await journal.append('empty-thread', {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'missing-session',
        update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
      },
    });
    assertEquals(await journal.clearIfNoConversation('empty-thread'), true);
    assertEquals((await journal.read('empty-thread')).events, []);

    await journal.append('used-thread', {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'persisted-session',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'Keep this work' },
        },
      },
    });
    assertEquals(await journal.clearIfNoConversation('used-thread'), false);
    assertEquals((await journal.read('used-thread')).events.length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
