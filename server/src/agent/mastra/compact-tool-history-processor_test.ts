import { limitCompactToolHistoryPrompt } from './compact-tool-history-processor.ts';

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test('context limiting bounds oversized cross-thread semantic recall', () => {
  const recalled = [
    'The following messages were remembered from a different conversation:',
    '<remembered_from_other_conversation>',
    'x'.repeat(1_800_000),
    '<end_remembered_from_other_conversation>',
  ].join('\n');
  const prompt = [
    { role: 'system', content: 'Base instructions' },
    { role: 'system', content: recalled },
    { role: 'user', content: 'Read README.md' },
  ];

  const limited = limitCompactToolHistoryPrompt(prompt, 100_000);
  const limitedRecall = limited.find((message) =>
    typeof message.content === 'string' && message.content.startsWith('The following messages were remembered')
  )?.content;

  if (typeof limitedRecall !== 'string') throw new Error('expected recalled conversation to remain available');
  assert(limitedRecall.length <= 40_000, 'expected recall to use no more than ten percent of context');
  assert(limitedRecall.includes('Weave truncated recalled conversation'), 'expected an explicit truncation marker');
  assert(limited.some((message) => message.role === 'user'), 'expected the current user message to be preserved');
});
