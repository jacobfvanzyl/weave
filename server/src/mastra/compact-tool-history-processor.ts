import type {
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
  Processor,
} from '@mastra/core/processors';

const compactToolHistoryPrefix = 'Compact tool result summary';

type PromptMessage = Record<string, unknown> & {
  role?: unknown;
  content?: unknown;
};

type PromptPart = Record<string, unknown>;

type CompactToolHistoryOptions = {
  preserveToolSteps?: number;
  tokenLimit?: number;
};

type CompactToolHistoryPart = {
  type: 'text';
  text: string;
  providerMetadata: {
    mastra: {
      weaveCompactToolHistory: true;
      toolName: string;
      toolCallId?: string;
    };
  };
};

const defaultPreserveToolSteps = 2;
const tokensPerMessage = 3.8;
const tokensPerConversation = 24;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const safeStringify = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
};

const getContentParts = (message: PromptMessage): PromptPart[] =>
  Array.isArray(message.content) ? message.content.filter(isRecord) : [];

const getToolCallId = (part: PromptPart) =>
  typeof part.toolCallId === 'string' && part.toolCallId.trim() ? part.toolCallId.trim() : undefined;

const getToolName = (part: PromptPart) =>
  typeof part.toolName === 'string' && part.toolName.trim() ? part.toolName.trim() : 'tool';

const isToolCallPart = (part: PromptPart) => part.type === 'tool-call';

const isToolResultPart = (part: PromptPart) => part.type === 'tool-result';

const hasToolCallPart = (message: PromptMessage) => getContentParts(message).some(isToolCallPart);

const toolResultOutputToText = (output: unknown): string | null => {
  if (typeof output === 'string') return output;
  if (!isRecord(output)) return safeStringify(output);

  if (output.type === 'text' || output.type === 'error-text') {
    return typeof output.value === 'string' ? output.value : safeStringify(output.value);
  }

  if (output.type === 'json' || output.type === 'error-json') {
    return safeStringify(output.value);
  }

  if (typeof output.value === 'string') return output.value;
  if (typeof output.text === 'string') return output.text;
  return safeStringify(output);
};

const promptPartText = (part: PromptPart) => {
  if (typeof part.text === 'string') return part.text;
  if (isToolCallPart(part)) return [part.toolName, safeStringify(part.input)].filter(Boolean).join('\n');
  if (isToolResultPart(part)) return [part.toolName, toolResultOutputToText(part.output)].filter(Boolean).join('\n');
  if (typeof part.mediaType === 'string') return part.mediaType;
  return safeStringify(part) ?? '';
};

const estimatePromptTokens = (prompt: PromptMessage[]) => {
  const content = prompt
    .map(message => [
      typeof message.role === 'string' ? message.role : '',
      typeof message.content === 'string'
        ? message.content
        : getContentParts(message).map(promptPartText).join('\n'),
    ].join('\n'))
    .join('\n');

  return Math.ceil(content.length / 4) + prompt.length * tokensPerMessage + tokensPerConversation;
};

const compactSummaryText = (toolName: string, summary: string, toolCallId?: string) => [
  compactToolHistoryPrefix,
  `tool: ${toolName}`,
  ...(toolCallId ? [`toolCallId: ${toolCallId}`] : []),
  '',
  summary,
].join('\n');

export const createCompactToolHistoryPart = (
  toolName: string,
  summary: string,
  toolCallId?: string,
): CompactToolHistoryPart => ({
  type: 'text',
  text: compactSummaryText(toolName, summary, toolCallId),
  providerMetadata: {
    mastra: {
      weaveCompactToolHistory: true,
      toolName,
      ...(toolCallId ? { toolCallId } : {}),
    },
  },
});

export const isLegacyCompactToolHistoryText = (text: string) => {
  if (text.startsWith(`${compactToolHistoryPrefix}\n`)) return true;

  const legacyHeading = /^(read|write|edit|bash|webSearch|webExtract|rename-thread|renameThreadTool|update_plan|updatePlanTool) result:\s*\n/;
  if (!legacyHeading.test(text)) return false;

  return /(?:^|\n)(ok|path|command|query|results|renamed|updated|completed|total|contentChars|contentHash|exitCode):\s/.test(text);
};

export const isCompactToolHistoryTextPart = (part: unknown) => {
  if (!isRecord(part) || part.type !== 'text') return false;

  const mastraProviderMetadata = isRecord(part.providerMetadata) && isRecord(part.providerMetadata.mastra)
    ? part.providerMetadata.mastra
    : undefined;
  const mastraProviderOptions = isRecord(part.providerOptions) && isRecord(part.providerOptions.mastra)
    ? part.providerOptions.mastra
    : undefined;

  if (mastraProviderMetadata?.weaveCompactToolHistory === true) return true;
  if (mastraProviderOptions?.weaveCompactToolHistory === true) return true;

  return typeof part.text === 'string' && isLegacyCompactToolHistoryText(part.text);
};

const getPreservedToolCallIds = (prompt: PromptMessage[], preserveToolSteps: number) => {
  if (preserveToolSteps <= 0) return new Set<string>();

  const toolSteps = prompt
    .filter(message => message.role === 'assistant')
    .map(message => getContentParts(message)
      .filter(isToolCallPart)
      .map(getToolCallId)
      .filter((id): id is string => typeof id === 'string'))
    .filter(ids => ids.length > 0);

  return new Set(toolSteps.slice(-preserveToolSteps).flat());
};

const compactToolResultPart = (part: PromptPart) => {
  const summary = toolResultOutputToText(part.output);
  if (!summary) return null;

  return {
    ...part,
    output: {
      type: 'text',
      value: compactSummaryText(getToolName(part), summary, getToolCallId(part)),
    },
  };
};

const compactAssistantMessage = (message: PromptMessage, preserveToolCallIds: Set<string>) => {
  const nextContent = getContentParts(message).flatMap(part => {
    if (isCompactToolHistoryTextPart(part)) return [];

    if (isToolCallPart(part)) return [part];

    if (isToolResultPart(part)) {
      const toolCallId = getToolCallId(part);
      if (toolCallId && preserveToolCallIds.has(toolCallId)) return [part];

      const compactPart = compactToolResultPart(part);
      return compactPart ? [compactPart] : [];
    }

    return [part];
  });

  return nextContent.length ? [{ ...message, content: nextContent }] : [];
};

const compactToolMessage = (message: PromptMessage, preserveToolCallIds: Set<string>) => {
  const nextContent = getContentParts(message).flatMap(part => {
    if (!isToolResultPart(part)) return [];

    const toolCallId = getToolCallId(part);
    if (toolCallId && preserveToolCallIds.has(toolCallId)) return [part];

    const compactPart = compactToolResultPart(part);
    return compactPart ? [compactPart] : [];
  });

  return nextContent.length ? [{ ...message, content: nextContent }] : [];
};

export const compactToolHistoryPrompt = (
  prompt: PromptMessage[],
  options: CompactToolHistoryOptions = {},
) => {
  const preserveToolCallIds = getPreservedToolCallIds(prompt, options.preserveToolSteps ?? defaultPreserveToolSteps);
  let changed = false;

  const nextPrompt = prompt.flatMap(message => {
    if (!Array.isArray(message.content)) return [message];

    if (message.role === 'assistant') {
      const compacted = compactAssistantMessage(message, preserveToolCallIds);
      if (compacted.length !== 1 || compacted[0] !== message) changed = true;
      return compacted;
    }

    if (message.role === 'tool') {
      const compacted = compactToolMessage(message, preserveToolCallIds);
      if (compacted.length !== 1 || compacted[0] !== message) changed = true;
      return compacted;
    }

    const nextContent = getContentParts(message).filter(part => !isCompactToolHistoryTextPart(part));
    if (nextContent.length === getContentParts(message).length) return [message];

    changed = true;
    return nextContent.length ? [{ ...message, content: nextContent }] : [];
  });

  return changed ? nextPrompt : prompt;
};

const promptGroups = (messages: PromptMessage[]) => {
  const groups: PromptMessage[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'assistant' && hasToolCallPart(message)) {
      const group = [message];
      while (messages[index + 1]?.role === 'tool') {
        group.push(messages[index + 1]);
        index += 1;
      }
      groups.push(group);
      continue;
    }

    groups.push([message]);
  }
  return groups;
};

export const limitCompactToolHistoryPrompt = (
  prompt: PromptMessage[],
  tokenLimit: number | undefined,
) => {
  if (!Number.isFinite(tokenLimit) || !tokenLimit || tokenLimit <= 0) return prompt;
  if (estimatePromptTokens(prompt) <= tokenLimit) return prompt;

  const systemMessages = prompt.filter(message => message.role === 'system');
  const nonSystemGroups = promptGroups(prompt.filter(message => message.role !== 'system'));
  const keptGroups = [...nonSystemGroups];

  while (keptGroups.length > 1) {
    const candidate = [...systemMessages, ...keptGroups.flat()];
    if (estimatePromptTokens(candidate) <= tokenLimit) return candidate;
    keptGroups.shift();
  }

  return [...systemMessages, ...keptGroups.flat()];
};

export class CompactToolHistoryProcessor implements Processor<'weave-compact-tool-history'> {
  readonly id = 'weave-compact-tool-history';
  readonly name = 'Weave Compact Tool History';

  constructor(private readonly options: CompactToolHistoryOptions = {}) {}

  processLLMRequest(args: ProcessLLMRequestArgs): ProcessLLMRequestResult {
    const compactedPrompt = compactToolHistoryPrompt(args.prompt as PromptMessage[], this.options);
    return {
      prompt: limitCompactToolHistoryPrompt(compactedPrompt, this.options.tokenLimit) as typeof args.prompt,
    };
  }
}
