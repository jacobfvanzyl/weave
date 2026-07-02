import type {
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
  Processor,
} from '@mastra/core/processors';
import { hashText } from './tools/model-output';
import { summarizeProposalToolInput } from './tools/proposal-tool-input-summary';

const compactToolHistoryPrefix = 'Compact tool result summary';

type PromptMessage = Record<string, unknown> & {
  role?: unknown;
  content?: unknown;
};

type PromptPart = Record<string, unknown>;

type CompactToolHistoryOptions = {
  preserveToolCalls?: number;
  /** @deprecated Use preserveToolCalls. Kept as a compatibility alias. */
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

const defaultPreserveToolCalls = 16;
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

const positiveInteger = (value: unknown) => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : undefined;
};

export const getToolHistoryFullCalls = (env: NodeJS.ProcessEnv = process.env) =>
  positiveInteger(env.WEAVE_TOOL_HISTORY_FULL_CALLS) ?? defaultPreserveToolCalls;

const getContentParts = (message: PromptMessage): PromptPart[] =>
  Array.isArray(message.content) ? message.content.filter(isRecord) : [];

const getToolCallId = (part: PromptPart) =>
  typeof part.toolCallId === 'string' && part.toolCallId.trim() ? part.toolCallId.trim() : undefined;

const getToolName = (part: PromptPart) =>
  typeof part.toolName === 'string' && part.toolName.trim() ? part.toolName.trim() : 'tool';

const isToolCallPart = (part: PromptPart) => part.type === 'tool-call';

const isToolResultPart = (part: PromptPart) => part.type === 'tool-result';

const getToolInvocation = (part: PromptPart) =>
  part.type === 'tool-invocation' && isRecord(part.toolInvocation) ? part.toolInvocation : undefined;

const isToolInvocationPart = (part: PromptPart) => Boolean(getToolInvocation(part));

const getToolInvocationName = (part: PromptPart) => {
  const invocation = getToolInvocation(part);
  return typeof invocation?.toolName === 'string' && invocation.toolName.trim() ? invocation.toolName.trim() : 'tool';
};

const getToolInvocationCallId = (part: PromptPart) => {
  const invocation = getToolInvocation(part);
  return typeof invocation?.toolCallId === 'string' && invocation.toolCallId.trim() ? invocation.toolCallId.trim() : undefined;
};

const hasToolCallPart = (message: PromptMessage) => getContentParts(message).some(part => isToolCallPart(part) || isToolInvocationPart(part));

const proposalToolNames = new Set([
  'writeProposalTool',
  'write_proposal',
  'write-proposal',
  'writeProposalPatchTool',
  'write_proposal_patch',
  'write-proposal-patch',
  'updateProposalTool',
  'update_proposal',
  'update-proposal',
]);

const textHashSummary = (value: unknown, prefix: string) => {
  if (typeof value !== 'string') return [];
  return [
    [`${prefix}Chars`, value.length] as const,
    [`${prefix}Hash`, hashText(value)] as const,
  ];
};

const firstErrorLines = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value
    .split(/\r?\n/)
    .filter(line => /error|failed|exception|traceback|denied|not found|invalid/i.test(line))
    .slice(0, 8)
    .join('\n')
    .slice(0, 1_200) || undefined;
};

const summaryLines = (fields: Array<readonly [string, unknown]>) =>
  fields
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n');

const compactPortalReadResult = (result: Record<string, unknown>) => summaryLines([
  ['ok', result.ok],
  ['path', result.path],
  ['offset', result.offset],
  ['limit', result.limit],
  ['error', result.error],
  ...textHashSummary(result.content, 'content'),
]);

const compactPortalBashResult = (result: Record<string, unknown>, args?: Record<string, unknown>) => summaryLines([
  ['ok', result.ok],
  ['command', typeof result.command === 'string' ? result.command : args?.command],
  ['exitCode', result.exitCode],
  ['error', result.error],
  ...textHashSummary(result.stdout, 'stdout'),
  ...textHashSummary(result.stderr, 'stderr'),
  ['stderrErrors', firstErrorLines(result.stderr)],
  ['stdoutErrors', firstErrorLines(result.stdout)],
]);

const compactToolResultForPrompt = (toolName: string, output: unknown, args?: Record<string, unknown>): string | null => {
  if (isRecord(output) && typeof output.type !== 'string') {
    if (toolName === 'read') {
      const summary = compactPortalReadResult(output);
      if (summary) return summary;
    }
    if (toolName === 'bash') {
      const summary = compactPortalBashResult(output, args);
      if (summary) return summary;
    }
  }

  const summary = toolResultOutputToText(output);
  if (!summary) return null;
  if ((toolName === 'read' || toolName === 'bash') && summary.length > 2_000) {
    return summaryLines([
      ['resultChars', summary.length],
      ['resultHash', hashText(summary)],
      ['firstErrorLines', firstErrorLines(summary)],
    ]);
  }
  return summary;
};

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
  if (isToolInvocationPart(part)) {
    const invocation = getToolInvocation(part)!;
    return [
      invocation.toolName,
      safeStringify(invocation.args),
      safeStringify(invocation.result),
    ].filter(Boolean).join('\n');
  }
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

  const legacyHeading = /^(read|write|edit|bash|webSearch|webExtract|rename-thread|renameThreadTool|write_plan|writePlanTool|update_plan|updatePlanTool|write_proposal|writeProposalTool|write_proposal_patch|writeProposalPatchTool|update_proposal|updateProposalTool) result:\s*\n/;
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

const getPreservedToolCallIds = (prompt: PromptMessage[], preserveToolCalls: number) => {
  if (preserveToolCalls <= 0) return new Set<string>();

  const toolCallIds = prompt
    .filter(message => message.role === 'assistant')
    .flatMap(message => getContentParts(message)
      .filter(part => isToolCallPart(part) || isToolInvocationPart(part))
      .map(part => isToolCallPart(part) ? getToolCallId(part) : getToolInvocationCallId(part))
      .filter((id): id is string => typeof id === 'string'));

  return new Set(toolCallIds.slice(-preserveToolCalls));
};

const compactToolResultPart = (part: PromptPart) => {
  const summary = compactToolResultForPrompt(getToolName(part), part.output);
  if (!summary) return null;

  return {
    ...part,
    output: {
      type: 'text',
      value: compactSummaryText(getToolName(part), summary, getToolCallId(part)),
    },
  };
};

const compactToolCallPart = (part: PromptPart) => {
  if (!proposalToolNames.has(getToolName(part))) return part;

  const nextPart = {
    ...part,
    ...(part.input !== undefined ? { input: summarizeProposalToolInput(part.input) } : {}),
    ...(part.args !== undefined ? { args: summarizeProposalToolInput(part.args) } : {}),
  };
  return nextPart;
};

const compactToolInvocationPart = (part: PromptPart, preserveToolCallIds: Set<string>) => {
  const invocation = getToolInvocation(part);
  if (!invocation) return part;
  const toolName = getToolInvocationName(part);
  const toolCallId = getToolInvocationCallId(part);
  const args = isRecord(invocation.args) ? invocation.args : undefined;
  const nextInvocation = {
    ...invocation,
    ...(proposalToolNames.has(toolName) && invocation.args !== undefined
      ? { args: summarizeProposalToolInput(invocation.args) }
      : {}),
  };

  if (toolCallId && preserveToolCallIds.has(toolCallId)) {
    return { ...part, toolInvocation: nextInvocation };
  }

  if (invocation.result !== undefined) {
    const summary = compactToolResultForPrompt(toolName, invocation.result, args);
    if (summary) {
      return {
        ...part,
        toolInvocation: {
          ...nextInvocation,
          result: {
            type: 'text',
            value: compactSummaryText(toolName, summary, toolCallId),
          },
        },
      };
    }
  }

  return { ...part, toolInvocation: nextInvocation };
};

const compactAssistantMessage = (message: PromptMessage, preserveToolCallIds: Set<string>) => {
  const nextContent = getContentParts(message).flatMap(part => {
    if (isCompactToolHistoryTextPart(part)) return [];

    if (isToolCallPart(part)) return [compactToolCallPart(part)];

    if (isToolInvocationPart(part)) return [compactToolInvocationPart(part, preserveToolCallIds)];

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
  const preserveToolCallIds = getPreservedToolCallIds(
    prompt,
    options.preserveToolCalls ?? options.preserveToolSteps ?? getToolHistoryFullCalls(),
  );
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
