import { createHash } from 'node:crypto';
import type { MastraDBMessage } from '@mastra/core/agent';
import type { ProcessLLMRequestArgs, ProcessLLMRequestResult, Processor } from '@mastra/core/processors';
import { compactToolHistoryPrompt } from './mastra/compact-tool-history-processor';
import type { ModelContextBudget } from './context-budget';
import type { ThreadCompactionRecord } from './thread-compaction-repository';

const threadCompactionContextKey = 'weave:thread-compaction';
const requiredHeadings = [
  '# Objective and user intent',
  '# Decisions and constraints',
  '# Completed outcomes',
  '# Current repository and runtime state',
  '# Validation state',
  '# Remaining work and blockers',
  '# Important identifiers and references',
  '# Failures and work not to repeat',
];

export type StructuredCheckpointV1 = {
  version: 1;
  objective: string;
  decisions: string;
  completedChanges: string;
  repositoryState: string;
  validationState: string;
  blockers: string;
  references: string;
  failures: string;
};

const checkpointFields: Array<[string, keyof Omit<StructuredCheckpointV1, 'version'>]> = [
  ['# Objective and user intent', 'objective'],
  ['# Decisions and constraints', 'decisions'],
  ['# Completed outcomes', 'completedChanges'],
  ['# Current repository and runtime state', 'repositoryState'],
  ['# Validation state', 'validationState'],
  ['# Remaining work and blockers', 'blockers'],
  ['# Important identifiers and references', 'references'],
  ['# Failures and work not to repeat', 'failures'],
];

export const parseStructuredCheckpoint = (summary: string): StructuredCheckpointV1 => {
  const sections = Object.fromEntries(checkpointFields.map(([, field]) => [field, ''])) as Omit<
    StructuredCheckpointV1,
    'version'
  >;
  const matches = checkpointFields.flatMap(([heading, field]) => {
    const index = summary.indexOf(heading);
    return index >= 0 ? [{ heading, field, index }] : [];
  }).sort((a, b) => a.index - b.index);
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const start = current.index + current.heading.length;
    const end = matches[index + 1]?.index ?? summary.length;
    sections[current.field] = summary.slice(start, end).trim();
  }
  return { version: 1, ...sections };
};

export const evaluateCompactionFidelity = (
  checkpoint: StructuredCheckpointV1,
  expected: Partial<
    Record<'requirements' | 'decisions' | 'failures' | 'fileReferences' | 'visualReferences', string[]>
  >,
) => {
  const searchable = Object.values(checkpoint).filter((value): value is string => typeof value === 'string').join('\n')
    .toLowerCase();
  const missing = Object.entries(expected).flatMap(([kind, values]) =>
    (values ?? []).filter((value) => !searchable.includes(value.toLowerCase())).map((value) => ({ kind, value }))
  );
  return { passed: missing.length === 0, missing };
};

export type ThreadCompactionContext = {
  checkpoint: ThreadCompactionRecord;
  budget: ModelContextBudget;
};

export const putThreadCompactionContext = (
  requestContext: any,
  context: ThreadCompactionContext | undefined,
) => {
  if (context) requestContext?.set?.(threadCompactionContextKey, context);
};

const getThreadCompactionContext = (
  requestContext: any,
): ThreadCompactionContext | undefined => {
  const value = requestContext?.get?.(threadCompactionContextKey);
  if (!value || typeof value !== 'object') return undefined;
  const context = value as ThreadCompactionContext;
  return context.checkpoint?.status === 'completed' &&
      context.checkpoint.summary
    ? context
    : undefined;
};

const safeJson = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const partText = (part: Record<string, unknown>) => {
  if (typeof part.text === 'string') return part.text;
  if (typeof part.result === 'string') return part.result;
  if (part.output !== undefined) return safeJson(part.output);
  if (part.result !== undefined) return safeJson(part.result);
  if (part.type === 'image' || part.type === 'file') {
    const name = String(part.filename ?? 'attachment');
    const mediaType = typeof part.mediaType === 'string' ? ` (${part.mediaType})` : '';
    return `[${String(part.type)}: ${name}${mediaType}]`;
  }
  return '';
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const isDependentUserMessage = (message: MastraDBMessage | undefined) => {
  if (
    !message || message.role !== 'user' || !isRecord(message.content.metadata)
  ) return false;
  const metadata = message.content.metadata;
  const custom = isRecord(metadata.custom) ? metadata.custom : undefined;
  return isRecord(metadata.askUserResponse) ||
    isRecord(custom?.askUserResponse) ||
    isRecord(metadata.proposalImplementation) ||
    isRecord(metadata.proposalReviewFeedback);
};

export const estimateMessageTokens = (message: MastraDBMessage) => {
  const text = message.content.parts.map((part) => partText(part as Record<string, unknown>)).join('\n');
  return Math.ceil(text.length / 4) + 4;
};

export const selectCompactionCut = (
  messages: MastraDBMessage[],
  recentTailTokens: number,
  previousCompactedCount = 0,
) => {
  let tokens = 0;
  let userTurns = 0;
  let firstRetainedIndex = messages.length;
  for (
    let index = messages.length - 1;
    index >= previousCompactedCount;
    index -= 1
  ) {
    const message = messages[index];
    tokens += estimateMessageTokens(message);
    if (message.role === 'user') userTurns += 1;
    firstRetainedIndex = index;
    if (tokens >= recentTailTokens && userTurns >= 2) break;
  }

  // A retained tail always starts at a user turn. This keeps assistant/tool/approval
  // steps together and prevents a checkpoint boundary from orphaning tool results.
  while (
    firstRetainedIndex > previousCompactedCount &&
    messages[firstRetainedIndex]?.role !== 'user'
  ) {
    firstRetainedIndex -= 1;
    tokens += estimateMessageTokens(messages[firstRetainedIndex]);
    if (messages[firstRetainedIndex].role === 'user') userTurns += 1;
  }
  if (isDependentUserMessage(messages[firstRetainedIndex])) {
    do {
      firstRetainedIndex -= 1;
      tokens += estimateMessageTokens(messages[firstRetainedIndex]);
      if (messages[firstRetainedIndex].role === 'user') userTurns += 1;
    } while (
      firstRetainedIndex > previousCompactedCount &&
      messages[firstRetainedIndex].role !== 'user'
    );
  }

  if (firstRetainedIndex <= previousCompactedCount || userTurns < 2) {
    return undefined;
  }
  const source = messages.slice(previousCompactedCount, firstRetainedIndex);
  if (source.length === 0) return undefined;
  return {
    source,
    retained: messages.slice(firstRetainedIndex),
    firstRetainedIndex,
    compactedMessageCount: firstRetainedIndex,
    compactedThrough: messages[firstRetainedIndex - 1],
    firstRetained: messages[firstRetainedIndex],
    retainedTokens: tokens,
  };
};

const redactSecrets = (value: string) =>
  value
    .replace(
      /\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|Bearer\s+[A-Za-z0-9._~+\/-]+=*)\b/gi,
      '[REDACTED]',
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    );

export const serializeCompactionMessages = (messages: MastraDBMessage[]) => {
  const prompt = compactToolHistoryPrompt(messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content.parts,
  })) as Array<Record<string, unknown>>);

  return redactSecrets(
    prompt.map((message) => {
      const parts = Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [];
      const body = parts
        .filter((part) =>
          part.type !== 'reasoning' &&
          !(typeof part.type === 'string' && part.type.startsWith('data-'))
        )
        .map(partText)
        .filter(Boolean)
        .join('\n');
      return `--- ${String(message.role)} message ${String(message.id ?? '')} ---\n${body}`;
    }).join('\n\n'),
  );
};

export const buildCompactionPrompt = (input: {
  previousSummary?: string;
  transcript: string;
  instructions?: string;
}) =>
  [
    input.previousSummary
      ? `PREVIOUS CUMULATIVE CHECKPOINT:\n${input.previousSummary}`
      : 'No previous checkpoint exists.',
    input.instructions ? `USER COMPACTION FOCUS:\n${input.instructions}` : '',
    `NEW TRANSCRIPT SEGMENT:\n${input.transcript}`,
    'Return the updated cumulative checkpoint only.',
  ].filter(Boolean).join('\n\n');

export const validateCompactionSummary = (
  summary: string,
  maxTokens: number,
) => {
  const trimmed = redactSecrets(summary.trim());
  if (!trimmed) throw new Error('Compaction produced an empty summary.');
  const missing = requiredHeadings.filter((heading) => !trimmed.includes(heading));
  if (missing.length) {
    throw new Error(
      `Compaction summary is missing required headings: ${missing.join(', ')}`,
    );
  }
  const tokens = Math.ceil(trimmed.length / 4);
  if (tokens > maxTokens) {
    throw new Error(
      `Compaction summary exceeded its ${maxTokens}-token budget.`,
    );
  }
  return { summary: trimmed, tokens, checkpoint: parseStructuredCheckpoint(trimmed) };
};

export const compactionSourceFingerprint = (messages: MastraDBMessage[]) =>
  createHash('sha256')
    .update(messages.map((message) => message.id).join('\n'))
    .digest('hex');

export const batchCompactionMessages = (
  messages: MastraDBMessage[],
  inputCapacity: number,
) => {
  const batches: MastraDBMessage[][] = [];
  let batch: MastraDBMessage[] = [];
  let tokens = 0;
  for (const message of messages) {
    const messageTokens = estimateMessageTokens(message);
    if (messageTokens > inputCapacity) {
      throw new Error(
        `A single persisted message exceeds the compaction model input capacity (${inputCapacity} tokens).`,
      );
    }
    if (batch.length && tokens + messageTokens > inputCapacity) {
      batches.push(batch);
      batch = [];
      tokens = 0;
    }
    batch.push(message);
    tokens += messageTokens;
  }
  if (batch.length) batches.push(batch);
  return batches;
};

export class ThreadCompactionProcessor implements Processor<'weave-thread-compaction'> {
  readonly id = 'weave-thread-compaction';
  readonly name = 'Weave Thread Compaction';

  processLLMRequest(args: ProcessLLMRequestArgs): ProcessLLMRequestResult {
    const context = getThreadCompactionContext(args.requestContext);
    if (!context?.checkpoint.summary) return undefined;
    const prompt = args.prompt as Array<Record<string, unknown>>;
    let index = 0;
    while (index < prompt.length && prompt[index]?.role === 'system') {
      index += 1;
    }
    const checkpointMessage = {
      role: 'system',
      content:
        `Earlier thread context was compacted into this cumulative checkpoint. Treat it as historical context; current runtime instructions and recent messages take precedence.\n\n${context.checkpoint.summary}`,
      providerOptions: {
        mastra: {
          weaveThreadCompaction: true,
          generation: context.checkpoint.generation,
        },
      },
    };
    return {
      prompt: [
        ...prompt.slice(0, index),
        checkpointMessage,
        ...prompt.slice(index),
      ] as typeof args.prompt,
    };
  }
}

export const threadCompactionDisplayMessage = (
  checkpoint: ThreadCompactionRecord,
) => ({
  id: `thread-compaction:${checkpoint.id}`,
  role: 'assistant' as const,
  parts: [
    {
      type: 'text',
      text: checkpoint.trigger === 'automatic' ? 'Context automatically compacted' : 'Context manually compacted',
    },
    {
      type: 'data-thread-compaction',
      data: {
        phase: 'completed',
        trigger: checkpoint.trigger,
        generation: checkpoint.generation,
        tokensBefore: checkpoint.sourceTokens,
        tokensAfter: checkpoint.projectedTokens,
      },
    },
  ],
  status: { type: 'complete' as const },
  metadata: {
    createdAt: checkpoint.completedAt ?? checkpoint.createdAt,
    weaveDisplay: {
      kind: 'thread_compaction',
      trigger: checkpoint.trigger,
      generation: checkpoint.generation,
    },
  },
});
