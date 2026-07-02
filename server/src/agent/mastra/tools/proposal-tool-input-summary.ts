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
    ...(typeof input.status === 'string' ? { status: input.status } : {}),
    ...(typeof input.patchPath === 'string' ? { patchPath: input.patchPath } : {}),
    ...(typeof input.allowDroppingItems === 'boolean' ? { allowDroppingItems: input.allowDroppingItems } : {}),
    ...stringSummary(input.overview, 'overview'),
    ...(Array.isArray(input.files)
      ? {
          files: input.files.map(file => {
            if (!isRecord(file)) return file;
            return {
              ...(typeof file.id === 'string' ? { id: file.id } : {}),
              ...(typeof file.kind === 'string' ? { kind: file.kind } : {}),
              ...(typeof file.title === 'string' ? { title: file.title } : {}),
              ...(typeof file.path === 'string' ? { path: file.path } : {}),
              ...(typeof file.currentHash === 'string' ? { currentHash: file.currentHash } : {}),
              ...stringSummary(file.description, 'description'),
              ...stringSummary(file.rationale, 'rationale'),
              ...stringSummary(file.diff, 'diff'),
              ...stringSummary(file.currentContent, 'currentContent'),
              ...stringSummary(file.proposedContent, 'proposedContent'),
            };
          }),
        }
      : {}),
  };
};
