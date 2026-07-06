import { hashText } from './model-output';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const stringSummary = (value: unknown, prefix: string) => {
  if (typeof value !== 'string') return {};
  return {
    [`${prefix}Chars`]: value.length,
    [`${prefix}Hash`]: hashText(value),
  };
};

export const summarizeProposalToolInput = (input: unknown) => {
  if (!isRecord(input)) return input;

  return {
    ...(typeof input.title === 'string' ? { title: input.title } : {}),
    ...(typeof input.summary === 'string' ? { summary: input.summary } : {}),
    ...(typeof input.proposalPath === 'string' ? { proposalPath: input.proposalPath } : {}),
    ...(typeof input.planPath === 'string' ? { planPath: input.planPath } : {}),
    ...(typeof input.path === 'string' ? { path: input.path } : {}),
    ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
    ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    ...stringSummary(input.overview, 'overview'),
    ...stringSummary(input.content, 'content'),
    ...stringSummary(input.description, 'description'),
    ...stringSummary(input.rationale, 'rationale'),
    ...(Array.isArray(input.edits)
      ? {
          edits: input.edits.map(edit => {
            if (!isRecord(edit)) return edit;
            return {
              ...stringSummary(edit.oldText, 'oldText'),
              ...stringSummary(edit.newText, 'newText'),
            };
          }),
        }
      : {}),
    ...(Array.isArray(input.items)
      ? {
          items: input.items.map(item => {
            if (!isRecord(item)) return item;
            return {
              ...(typeof item.id === 'string' ? { id: item.id } : {}),
              ...(typeof item.status === 'string' ? { status: item.status } : {}),
              ...stringSummary(item.comment, 'comment'),
            };
          }),
        }
      : {}),
  };
};
