import { __askUserToolTest, askUserTool } from './ask-user-tool.ts';

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown) => {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${actualJson} to equal ${expectedJson}`);
  }
};

const input = {
  questions: [
    {
      id: 'scope',
      header: 'Scope',
      question: 'How broad should this be?',
      options: [
        { id: 'narrow', label: 'Narrow', description: 'Only the current path.' },
        { id: 'broad', label: 'Broad', description: 'Include adjacent surfaces.' },
      ],
    },
  ],
};

Deno.test('ask_user tool description allows explicit demo requests', () => {
  const description = String((askUserTool as any).description ?? '');
  assert(description.includes('test, demonstrate, show, or use this tool'), 'expected explicit demo guidance');
});

Deno.test('ask_user input schema accepts one to three questions with two to four options', () => {
  const parsed = __askUserToolTest.askUserInputSchema.safeParse(input);
  assert(parsed.success, 'expected valid ask_user input');

  const invalid = __askUserToolTest.askUserInputSchema.safeParse({
    questions: [
      {
        id: 'scope',
        question: 'How broad?',
        options: [{ id: 'narrow', label: 'Narrow' }],
      },
    ],
  });
  assert(!invalid.success, 'expected one-option input to be rejected');
});

Deno.test('ask_user output maps submitted option answers', () => {
  assertEquals(
    __askUserToolTest.buildAskUserOutput(input, {
      action: 'submit',
      answers: [{ id: 'scope', selectedOptionId: 'narrow', finalAnswer: 'Narrow' }],
    }),
    {
      ok: true,
      answered: 1,
      questionCount: 1,
      answers: [
        {
          id: 'scope',
          selectedOptionId: 'narrow',
          finalAnswer: 'Narrow',
          question: 'How broad should this be?',
          selectedOptionLabel: 'Narrow',
        },
      ],
    },
  );
});

Deno.test('ask_user output maps custom answers and cancel responses', () => {
  assertEquals(
    __askUserToolTest.buildAskUserOutput(input, {
      action: 'submit',
      answers: [{ id: 'scope', customAnswer: 'Only the changed test file.', finalAnswer: 'Only the changed test file.' }],
    }),
    {
      ok: true,
      answered: 1,
      questionCount: 1,
      answers: [
        {
          id: 'scope',
          customAnswer: 'Only the changed test file.',
          finalAnswer: 'Only the changed test file.',
          question: 'How broad should this be?',
        },
      ],
    },
  );

  assertEquals(
    __askUserToolTest.buildAskUserOutput(input, { action: 'cancel', reason: 'cancelled_by_user' }),
    {
      ok: false,
      cancelled: true,
      answered: 0,
      questionCount: 1,
      answers: [],
    },
  );
});

Deno.test('ask_user output reports invalid resume mappings without throwing', () => {
  const output = __askUserToolTest.buildAskUserOutput(input, {
    action: 'submit',
    answers: [{ id: 'scope', selectedOptionId: 'missing', finalAnswer: 'Missing' }],
  });

  assertEquals(output.ok, false);
  assert(output.error?.includes('Unknown option id'), 'expected unknown option error');
});
