import { __chatStateContextUsageTest } from './chat-state.ts';

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const assistant = (id: string, parts: Array<Record<string, unknown>>) => ({
  id,
  role: 'assistant' as const,
  parts,
});

Deno.test('retained run replaces its earliest persisted assistant instead of duplicating it', () => {
  const persisted = [
    { id: 'user-1', role: 'user' as const, parts: [{ type: 'text', text: 'Inspect the repo' }] },
    assistant('assistant-run-1', [{ type: 'text', text: 'I will inspect it.' }]),
    assistant('assistant-final', [{ type: 'text', text: 'It is Weave.' }]),
  ];
  const retained = [
    assistant('assistant-run-1', [
      { type: 'text', text: 'I will inspect it.' },
      { type: 'tool-read', toolCallId: 'call-1', state: 'output-available', input: {}, output: 'README' },
    ]),
    assistant('assistant-final', [{ type: 'text', text: 'It is Weave.' }]),
  ];

  const merged = __chatStateContextUsageTest.mergeRetainedRunMessages(persisted as any, retained as any);

  assertEquals(merged.map((message) => message.id), ['user-1', 'assistant-run-1', 'assistant-final']);
  assertEquals(merged[1], retained[0]);
});
