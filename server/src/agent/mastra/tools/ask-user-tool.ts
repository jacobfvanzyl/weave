import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { formatToolModelOutput } from './model-output';

const idSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const askUserOptionSchema = z.object({
  id: idSchema.describe('Stable option id. Use short kebab_case, snake_case, or camelCase.'),
  label: z.string().trim().min(1).max(96).describe('Short user-facing option label. Put the recommended option first.'),
  description: z.string().trim().min(1).max(240).optional().describe('One concise sentence explaining the tradeoff.'),
});

export const askUserQuestionSchema = z.object({
  id: idSchema.describe('Stable question id used to map the user answer.'),
  header: z.string().trim().min(1).max(32).optional().describe('Short section label for this question.'),
  question: z.string().trim().min(1).max(280).describe('The question to ask the user.'),
  options: z.array(askUserOptionSchema).min(2).max(4).describe('Two to four meaningful, mutually exclusive options.'),
}).superRefine((question, context) => {
  const optionIds = new Set<string>();
  for (const option of question.options) {
    if (optionIds.has(option.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: `Duplicate option id "${option.id}" in question "${question.id}".`,
      });
    }
    optionIds.add(option.id);
  }
});

export const askUserInputSchema = z.object({
  questions: z.array(askUserQuestionSchema).min(1).max(3).describe('One to three concise structured questions.'),
}).superRefine((input, context) => {
  const questionIds = new Set<string>();
  for (const question of input.questions) {
    if (questionIds.has(question.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['questions'],
        message: `Duplicate question id "${question.id}".`,
      });
    }
    questionIds.add(question.id);
  }
});

export const askUserSuspendSchema = z.object({
  questions: askUserInputSchema.shape.questions,
  requestedAt: z.string().datetime(),
});

export const askUserAnswerSchema = z.object({
  id: idSchema,
  selectedOptionId: idSchema.optional(),
  customAnswer: z.string().trim().min(1).max(2_000).optional(),
  finalAnswer: z.string().trim().min(1).max(2_000),
});

export const askUserResumeSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('submit'),
    answers: z.array(askUserAnswerSchema).min(1).max(3),
  }),
  z.object({
    action: z.literal('cancel'),
    reason: z.string().trim().max(240).optional(),
  }),
]);

const askUserOutputAnswerSchema = askUserAnswerSchema.extend({
  question: z.string(),
  selectedOptionLabel: z.string().optional(),
});

export const askUserOutputSchema = z.object({
  ok: z.boolean(),
  cancelled: z.boolean().optional(),
  answered: z.number().int().min(0),
  questionCount: z.number().int().min(0),
  answers: z.array(askUserOutputAnswerSchema),
  error: z.string().optional(),
});

export type AskUserInput = z.infer<typeof askUserInputSchema>;
export type AskUserResume = z.infer<typeof askUserResumeSchema>;
export type AskUserOutput = z.infer<typeof askUserOutputSchema>;

const answerKey = (answer: Pick<z.infer<typeof askUserAnswerSchema>, 'id'>) => answer.id;

export const buildAskUserOutput = (input: AskUserInput, resumeData: AskUserResume): AskUserOutput => {
  if (resumeData.action === 'cancel') {
    return {
      ok: false,
      cancelled: true,
      answered: 0,
      questionCount: input.questions.length,
      answers: [],
    };
  }

  const questionsById = new Map(input.questions.map(question => [question.id, question]));
  const seenAnswers = new Set<string>();
  const answers: AskUserOutput['answers'] = [];

  for (const answer of resumeData.answers) {
    const question = questionsById.get(answer.id);
    if (!question) {
      return {
        ok: false,
        answered: answers.length,
        questionCount: input.questions.length,
        answers,
        error: `Unknown question id "${answer.id}".`,
      };
    }

    if (seenAnswers.has(answerKey(answer))) {
      return {
        ok: false,
        answered: answers.length,
        questionCount: input.questions.length,
        answers,
        error: `Duplicate answer for question "${answer.id}".`,
      };
    }

    const selectedOption = answer.selectedOptionId
      ? question.options.find(option => option.id === answer.selectedOptionId)
      : undefined;
    if (answer.selectedOptionId && !selectedOption) {
      return {
        ok: false,
        answered: answers.length,
        questionCount: input.questions.length,
        answers,
        error: `Unknown option id "${answer.selectedOptionId}" for question "${answer.id}".`,
      };
    }

    seenAnswers.add(answerKey(answer));
    answers.push({
      ...answer,
      question: question.question,
      ...(selectedOption ? { selectedOptionLabel: selectedOption.label } : {}),
    });
  }

  const missing = input.questions.filter(question => !seenAnswers.has(question.id));
  if (missing.length > 0) {
    return {
      ok: false,
      answered: answers.length,
      questionCount: input.questions.length,
      answers,
      error: `Missing answer for question "${missing[0].id}".`,
    };
  }

  return {
    ok: true,
    answered: answers.length,
    questionCount: input.questions.length,
    answers,
  };
};

export const askUserTool = createTool({
  id: 'ask_user',
  description: [
    'Ask the user one to three structured clarification questions and pause until they answer.',
    'Use only when missing information materially changes the plan, implementation, or tradeoff.',
    'Also use when the user explicitly asks to test, demonstrate, show, or use this tool; in that case ask a harmless sample question.',
    'Do not use for secrets, credentials, permission prompts, or routine status updates.',
    'Put the recommended option first when there is a clear default; the UI always provides a custom answer path.',
  ].join(' '),
  inputSchema: askUserInputSchema,
  suspendSchema: askUserSuspendSchema,
  resumeSchema: askUserResumeSchema,
  outputSchema: askUserOutputSchema,
  execute: async (input, context): Promise<AskUserOutput> => {
    const agentContext = context.agent;
    const resumeData = agentContext?.resumeData;

    if (!resumeData) {
      if (!agentContext?.suspend) {
        return {
          ok: false,
          answered: 0,
          questionCount: input.questions.length,
          answers: [],
          error: 'ask_user can only pause from an interactive agent stream.',
        };
      }

      return await agentContext.suspend({
        questions: input.questions,
        requestedAt: new Date().toISOString(),
      }) as never;
    }

    const parsed = askUserResumeSchema.safeParse(resumeData);
    if (!parsed.success) {
      return {
        ok: false,
        answered: 0,
        questionCount: input.questions.length,
        answers: [],
        error: 'Ask response did not match the expected schema.',
      };
    }

    return buildAskUserOutput(input, parsed.data);
  },
  toModelOutput: output => {
    return formatToolModelOutput('ask_user', [
      ['ok', output.ok],
      ['cancelled', output.cancelled],
      ['answered', `${output.answered}/${output.questionCount}`],
      ['error', output.error],
    ], output.answers);
  },
});

export const __askUserToolTest = {
  askUserInputSchema,
  askUserResumeSchema,
  buildAskUserOutput,
};
