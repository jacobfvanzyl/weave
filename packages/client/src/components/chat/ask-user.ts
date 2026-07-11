export type AskUserOption = {
  id: string;
  label: string;
  description?: string;
};

export type AskUserQuestion = {
  id: string;
  header?: string;
  question: string;
  options: AskUserOption[];
};

export type AskUserPart = {
  mastraRunId: string;
  toolCallId: string;
  questions: AskUserQuestion[];
  status: 'pending' | 'submitted';
  resume?: AskUserResume;
  requestedAt?: string;
};

export type AskUserAnswer = {
  id: string;
  selectedOptionId?: string;
  customAnswer?: string;
  finalAnswer: string;
};

export type AskUserResume =
  | { action: 'submit'; answers: AskUserAnswer[] }
  | { action: 'cancel'; reason?: string };

export type AskUserResponseMetadata = {
  mastraRunId: string;
  toolCallId: string;
  questions?: AskUserQuestion[];
  resume: AskUserResume;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const parseQuestions = (value: unknown): AskUserQuestion[] | undefined => {
  if (!Array.isArray(value)) return undefined;

  const questions = value.map((question): AskUserQuestion | undefined => {
    if (!isRecord(question)) return undefined;
    const id = nonEmptyString(question.id);
    const text = nonEmptyString(question.question);
    const options = Array.isArray(question.options)
      ? question.options.map((option): AskUserOption | undefined => {
        if (!isRecord(option)) return undefined;
        const optionId = nonEmptyString(option.id);
        const label = nonEmptyString(option.label);
        if (!optionId || !label) return undefined;
        return {
          id: optionId,
          label,
          ...(nonEmptyString(option.description) ? { description: nonEmptyString(option.description) } : {}),
        };
      }).filter((option): option is AskUserOption => Boolean(option))
      : [];

    if (!id || !text || options.length < 2) return undefined;
    return {
      id,
      question: text,
      options,
      ...(nonEmptyString(question.header) ? { header: nonEmptyString(question.header) } : {}),
    };
  }).filter((question): question is AskUserQuestion => Boolean(question));

  return questions.length > 0 ? questions : undefined;
};

export const parseAskUserAnswers = (value: unknown): AskUserAnswer[] | undefined => {
  if (!Array.isArray(value)) return undefined;

  const answers = value.map((answer): AskUserAnswer | undefined => {
    if (!isRecord(answer)) return undefined;
    const id = nonEmptyString(answer.id);
    const finalAnswer = nonEmptyString(answer.finalAnswer);
    if (!id || !finalAnswer) return undefined;

    return {
      id,
      finalAnswer,
      ...(nonEmptyString(answer.selectedOptionId) ? { selectedOptionId: nonEmptyString(answer.selectedOptionId) } : {}),
      ...(nonEmptyString(answer.customAnswer) ? { customAnswer: nonEmptyString(answer.customAnswer) } : {}),
    };
  }).filter((answer): answer is AskUserAnswer => Boolean(answer));

  return answers.length > 0 ? answers : undefined;
};

const parseAskUserResume = (value: unknown): AskUserResume | undefined => {
  if (!isRecord(value)) return undefined;

  if (value.action === 'cancel') {
    return {
      action: 'cancel',
      ...(nonEmptyString(value.reason) ? { reason: nonEmptyString(value.reason) } : {}),
    };
  }

  if (value.action !== 'submit') return undefined;
  const answers = parseAskUserAnswers(value.answers);
  return answers ? { action: 'submit', answers } : undefined;
};

export const parseAskUserPart = (part: unknown): AskUserPart | null => {
  if (!isRecord(part)) return null;

  const isNormalizedAskPart = part.type === 'data-ask-user' ||
    (part.type === 'data' && (part.name === 'ask-user' || part.name === 'ask_user'));

  if (isNormalizedAskPart) {
    const data = isRecord(part.data) ? part.data : {};
    const questions = parseQuestions(data.questions);
    const mastraRunId = nonEmptyString(data.mastraRunId);
    const toolCallId = nonEmptyString(data.toolCallId);
    if (!mastraRunId || !toolCallId || !questions) return null;
    const resume = parseAskUserResume(data.resume);
    return {
      mastraRunId,
      toolCallId,
      questions,
      status: data.status === 'submitted' ? 'submitted' : 'pending',
      ...(resume ? { resume } : {}),
      ...(nonEmptyString(data.requestedAt) ? { requestedAt: nonEmptyString(data.requestedAt) } : {}),
    };
  }

  const isSuspendedPart = part.type === 'data-tool-call-suspended' ||
    (part.type === 'data' &&
      (part.name === 'tool-call-suspended' || part.name === 'data-tool-call-suspended'));
  if (!isSuspendedPart) return null;

  const data = isRecord(part.data) ? part.data : part;
  if (data.toolName !== 'ask_user') return null;
  const suspendPayload = isRecord(data.suspendPayload)
    ? data.suspendPayload
    : isRecord(part.suspendPayload)
    ? part.suspendPayload
    : {};
  const questions = parseQuestions(suspendPayload.questions);
  const mastraRunId = nonEmptyString(data.runId) ?? nonEmptyString(data.mastraRunId);
  const toolCallId = nonEmptyString(data.toolCallId);
  if (!mastraRunId || !toolCallId || !questions) return null;

  return {
    mastraRunId,
    toolCallId,
    questions,
    status: 'pending',
    ...(nonEmptyString(suspendPayload.requestedAt) ? { requestedAt: nonEmptyString(suspendPayload.requestedAt) } : {}),
  };
};

export const isAskUserPart = (part: unknown) => parseAskUserPart(part) !== null;

const parseAskUserResponseRecord = (metadata: Record<string, unknown>): AskUserResponseMetadata | null => {
  const response = isRecord(metadata.askUserResponse) ? metadata.askUserResponse : undefined;
  if (!response) return null;

  const mastraRunId = nonEmptyString(response.mastraRunId);
  const toolCallId = nonEmptyString(response.toolCallId);
  if (!mastraRunId || !toolCallId) return null;
  const questions = parseQuestions(response.questions);

  if (response.action === 'cancel') {
    return {
      mastraRunId,
      toolCallId,
      ...(questions ? { questions } : {}),
      resume: {
        action: 'cancel',
        ...(nonEmptyString(response.reason) ? { reason: nonEmptyString(response.reason) } : {}),
      },
    };
  }

  if (response.action !== 'submit') return null;
  const answers = parseAskUserAnswers(response.answers);
  if (!answers) return null;

  return {
    mastraRunId,
    toolCallId,
    ...(questions ? { questions } : {}),
    resume: { action: 'submit', answers },
  };
};

export const parseAskUserResponseMetadata = (metadata: unknown): AskUserResponseMetadata | null => {
  if (!isRecord(metadata)) return null;
  return parseAskUserResponseRecord(metadata) ??
    (isRecord(metadata.custom) ? parseAskUserResponseRecord(metadata.custom) : null);
};

const getAnswerLabel = (part: AskUserPart, answer: AskUserAnswer) => {
  const question = part.questions.find(item => item.id === answer.id);
  const option = question?.options.find(item => item.id === answer.selectedOptionId);
  return option?.label ?? answer.finalAnswer;
};

export const buildAskUserResponseText = (part: AskUserPart, resume: AskUserResume) => {
  if (resume.action === 'cancel') return 'I cancelled the clarification request.';

  return resume.answers.map((answer) => {
    const question = part.questions.find(item => item.id === answer.id);
    const prefix = question?.header ?? question?.question ?? answer.id;
    return `${prefix}: ${getAnswerLabel(part, answer)}`;
  }).join('\n');
};

export const buildAskUserResponseMetadata = (part: AskUserPart, resume: AskUserResume) => ({
  custom: {
    askUserResponse: {
      toolCallId: part.toolCallId,
      mastraRunId: part.mastraRunId,
      questions: part.questions,
      action: resume.action,
      ...(resume.action === 'submit' ? { answers: resume.answers } : { reason: resume.reason }),
    },
    weaveDisplay: {
      kind: 'ask_user_response',
      toolCallId: part.toolCallId,
    },
  },
});
