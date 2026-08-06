import type { ProcessLLMRequestArgs, ProcessLLMRequestResult, Processor } from '@mastra/core/processors';

type PromptMessage = Record<string, unknown> & {
  role?: unknown;
  content?: unknown;
};

type PromptPart = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getContentParts = (message: PromptMessage): PromptPart[] =>
  Array.isArray(message.content) ? message.content.filter(isRecord) : [];

const partMediaType = (part: PromptPart) =>
  typeof part.mediaType === 'string' ? part.mediaType : typeof part.mimeType === 'string' ? part.mimeType : undefined;

const isImagePart = (part: PromptPart) => {
  if (part.type === 'image' || part.type === 'input_image') return true;
  if (part.type !== 'file') return false;
  return partMediaType(part)?.startsWith('image/') ?? false;
};

const referenceUrl = (value: unknown) =>
  typeof value === 'string' ? value : value instanceof URL ? value.href : undefined;

const imageReference = (part: PromptPart) => {
  const value = referenceUrl(part.image) ?? referenceUrl(part.url) ?? referenceUrl(part.data);
  const match = value?.match(/(?:weave\.local\/attachments\/|\/attachments\/)([A-Za-z0-9_-]+)/);
  const attachmentId = match?.[1];
  const name = typeof part.filename === 'string' ? part.filename : 'image';
  return {
    type: 'text',
    text: attachmentId
      ? `[Image attachment ${name}; id=${attachmentId}. Call view_attachment with this id to inspect it again.]`
      : `[Image attachment ${name} is available in the persisted thread, but has no durable attachment id.]`,
  };
};

const replaceImagePartsWithReferences = (message: PromptMessage) => {
  const parts = getContentParts(message);
  if (!parts.some(isImagePart)) return { message, removed: false };

  const content = parts.map((part) => isImagePart(part) ? imageReference(part) : part);
  return {
    message: { ...message, content },
    removed: true,
  };
};

const isEmptyUserMessage = (message: PromptMessage) => {
  if (message.role !== 'user') return false;
  if (typeof message.content === 'string') return message.content.trim().length === 0;
  return Array.isArray(message.content) && getContentParts(message).length === 0;
};

export const stripHistoricalImagePrompt = (
  prompt: PromptMessage[],
  options: { stepNumber?: number } = {},
) => {
  let latestUserIndex = -1;
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    if (prompt[index]?.role === 'user') {
      latestUserIndex = index;
      break;
    }
  }

  if (latestUserIndex === -1) return prompt;

  let changed = false;
  const stripLatestUser = (options.stepNumber ?? 0) > 0;

  const nextPrompt = prompt.flatMap((message, index) => {
    if (message.role !== 'user') return [message];
    if (index > latestUserIndex) return [message];

    const shouldStripImages = index < latestUserIndex || (index === latestUserIndex && stripLatestUser);
    if (!shouldStripImages) return [message];

    const result = replaceImagePartsWithReferences(message);
    changed ||= result.removed;
    if (isEmptyUserMessage(result.message)) {
      changed = true;
      return [];
    }

    return [result.message];
  });

  return changed ? nextPrompt : prompt;
};

export class CurrentTurnImageProcessor implements Processor<'weave-current-turn-image'> {
  readonly id = 'weave-current-turn-image';
  readonly name = 'Weave Current Turn Image';

  processLLMRequest(args: ProcessLLMRequestArgs): ProcessLLMRequestResult {
    return {
      prompt: stripHistoricalImagePrompt(args.prompt as PromptMessage[], {
        stepNumber: args.stepNumber,
      }) as typeof args.prompt,
    };
  }
}
