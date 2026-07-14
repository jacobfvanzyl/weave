import { createHash } from 'node:crypto';
import type { MastraDBMessage } from '@mastra/core/agent';
import type {
  ProcessInputStepArgs,
  ProcessInputStepResult,
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
  Processor,
} from '@mastra/core/processors';
import { z } from 'zod';
import { compactToolHistoryPrompt } from './mastra/compact-tool-history-processor';
import type { ModelContextBudget } from './context-budget';
import type { ThreadCompactionRecord } from './thread-compaction-repository';

const threadCompactionContextKey = 'weave:thread-compaction';
const threadCompactionStepRuntimeKey = 'weave:thread-compaction-step-runtime';
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

export const checkpointReferenceSchema = z.object({
  kind: z.string().trim().min(1),
  value: z.string().trim().min(1),
  context: z.string().trim().default(''),
});

export const checkpointAttachmentSchema = z.object({
  id: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  partIndex: z.number().int().nonnegative(),
  kind: z.enum(['image', 'file']),
  name: z.string().trim().optional(),
  mediaType: z.string().trim().optional(),
  note: z.string().trim().default(''),
});

export const structuredCheckpointV2Schema = z.object({
  version: z.literal(2).default(2),
  producer: z.enum(['v2', 'legacy_normalized']).default('v2'),
  objectiveAndIntent: z.array(z.string().trim().min(1)).default([]),
  decisionsAndConstraints: z.array(z.string().trim().min(1)).default([]),
  completedOutcomes: z.array(z.string().trim().min(1)).default([]),
  repositoryAndRuntimeState: z.array(z.string().trim().min(1)).default([]),
  validationState: z.array(z.string().trim().min(1)).default([]),
  remainingWorkAndBlockers: z.array(z.string().trim().min(1)).default([]),
  importantReferences: z.array(checkpointReferenceSchema).default([]),
  failuresToAvoid: z.array(z.string().trim().min(1)).default([]),
  attachments: z.array(checkpointAttachmentSchema).default([]),
  lineageDepth: z.number().int().min(0).default(0),
});

export const structuredCheckpointV2OutputSchema = structuredCheckpointV2Schema.omit({ producer: true }).extend({
  attachments: z.array(z.object({
    id: z.string().trim().min(1),
    note: z.string().trim().default(''),
  })).default([]),
});

export type StructuredCheckpointV2 = z.infer<typeof structuredCheckpointV2Schema>;
export type StructuredCheckpoint = StructuredCheckpointV1 | StructuredCheckpointV2;
export type CompactionMode = 'incremental' | 'rebuild';

export type CompactionProjection = {
  tokensBefore: number;
  tokensAfter: number;
  reclaimedTokens: number;
  headroomTokens: number;
  minimumGainTokens: number;
  hardCeilingTokens: number;
  accepted: boolean;
  reason?: 'insufficient_gain' | 'insufficient_headroom' | 'hard_ceiling';
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

const sectionLines = (value: string) =>
  value.split('\n').map((line) => line.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean);

export const normalizeCheckpoint = (
  checkpoint: unknown,
  fallbackSummary = '',
): StructuredCheckpointV2 => {
  const parsed = structuredCheckpointV2Schema.safeParse(checkpoint);
  if (parsed.success) return parsed.data;

  const legacy = parseStructuredCheckpoint(fallbackSummary);
  return {
    version: 2,
    producer: 'legacy_normalized',
    objectiveAndIntent: sectionLines(legacy.objective),
    decisionsAndConstraints: sectionLines(legacy.decisions),
    completedOutcomes: sectionLines(legacy.completedChanges),
    repositoryAndRuntimeState: sectionLines(legacy.repositoryState),
    validationState: sectionLines(legacy.validationState),
    remainingWorkAndBlockers: sectionLines(legacy.blockers),
    importantReferences: sectionLines(legacy.references).map((value) => ({
      kind: 'reference',
      value,
      context: '',
    })),
    failuresToAvoid: sectionLines(legacy.failures),
    attachments: [],
    lineageDepth: 0,
  };
};

const renderList = (values: string[]) =>
  values.length ? values.map((value) => `- ${value}`).join('\n') : '- None recorded.';

export const renderStructuredCheckpoint = (checkpoint: StructuredCheckpointV2) =>
  [
    '# Objective and user intent',
    renderList(checkpoint.objectiveAndIntent),
    '# Decisions and constraints',
    renderList(checkpoint.decisionsAndConstraints),
    '# Completed outcomes',
    renderList(checkpoint.completedOutcomes),
    '# Current repository and runtime state',
    renderList(checkpoint.repositoryAndRuntimeState),
    '# Validation state',
    renderList(checkpoint.validationState),
    '# Remaining work and blockers',
    renderList(checkpoint.remainingWorkAndBlockers),
    '# Important identifiers and references',
    renderList(checkpoint.importantReferences.map((reference) =>
      `${reference.kind}: ${reference.value}${reference.context ? ` — ${reference.context}` : ''}`
    )),
    '# Attachments',
    renderList(checkpoint.attachments.map((attachment) =>
      `${attachment.id}: ${attachment.kind}${attachment.name ? ` ${attachment.name}` : ''}${
        attachment.mediaType ? ` (${attachment.mediaType})` : ''
      }${attachment.note ? ` — ${attachment.note}` : ''}`
    )),
    '# Failures and work not to repeat',
    renderList(checkpoint.failuresToAvoid),
  ].join('\n\n');

export const validateStructuredCheckpoint = (
  checkpoint: unknown,
  input: {
    maxTokens: number;
    attachmentCatalog?: Map<string, StructuredCheckpointV2['attachments'][number]>;
    lineageDepth?: number;
  },
) => {
  const parsed = structuredCheckpointV2OutputSchema.parse(checkpoint);
  const attachmentCatalog = input.attachmentCatalog ?? new Map();
  const attachments = parsed.attachments.map((attachment) => {
    const trusted = attachmentCatalog.get(attachment.id);
    if (!trusted) {
      throw new Error(
        `Compaction checkpoint referenced unknown attachment ${redactCompactionText(attachment.id)}.`,
      );
    }
    return { ...trusted, note: attachment.note };
  });
  const normalized = {
    ...parsed,
    producer: 'v2' as const,
    attachments,
    lineageDepth: input.lineageDepth ?? parsed.lineageDepth,
  };
  const sanitized = structuredCheckpointV2Schema.parse(redactStructuredValue(normalized));
  const summary = renderStructuredCheckpoint(sanitized);
  const tokens = Math.ceil(summary.length / 4);
  if (tokens > input.maxTokens) {
    throw new Error(`Compaction checkpoint exceeded its ${input.maxTokens}-token budget.`);
  }
  return { checkpoint: sanitized, summary, tokens };
};

export const evaluateCompactionFidelity = (
  checkpoint: StructuredCheckpoint,
  expected: Partial<
    Record<'requirements' | 'decisions' | 'failures' | 'fileReferences' | 'visualReferences', string[]>
  >,
) => {
  const searchable = JSON.stringify(checkpoint).toLowerCase();
  const missing = Object.entries(expected).flatMap(([kind, values]) =>
    (values ?? []).filter((value) => !searchable.includes(value.toLowerCase())).map((value) => ({ kind, value }))
  );
  return { passed: missing.length === 0, missing };
};

export type ThreadCompactionContext = {
  checkpoint: ThreadCompactionRecord;
  budget: ModelContextBudget;
};

export type ThreadCompactionStepRuntime = {
  compactIfNeeded(input: {
    messages: MastraDBMessage[];
    stepNumber: number;
    abortSignal?: AbortSignal;
  }): Promise<ThreadCompactionRecord | undefined>;
};

export const putThreadCompactionContext = (
  requestContext: any,
  context: ThreadCompactionContext | undefined,
) => {
  requestContext?.set?.(threadCompactionContextKey, context);
};

export const putThreadCompactionStepRuntime = (
  requestContext: any,
  runtime: ThreadCompactionStepRuntime | undefined,
) => {
  requestContext?.set?.(threadCompactionStepRuntimeKey, runtime);
};

const getThreadCompactionStepRuntime = (requestContext: any): ThreadCompactionStepRuntime | undefined => {
  const value = requestContext?.get?.(threadCompactionStepRuntimeKey);
  return value && typeof value.compactIfNeeded === 'function' ? value as ThreadCompactionStepRuntime : undefined;
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

const attachmentKind = (part: Record<string, unknown>) =>
  part.type === 'image' || part.type === 'file' ? part.type : undefined;

const attachmentId = (messageId: string, partIndex: number) => `attachment:${messageId}:${partIndex}`;

const partText = (part: Record<string, unknown>, messageId = 'unknown', partIndex = 0) => {
  if (typeof part.text === 'string') return part.text;
  if (typeof part.result === 'string') return part.result;
  if (part.output !== undefined) return safeJson(part.output);
  if (part.result !== undefined) return safeJson(part.result);
  if (attachmentKind(part)) {
    const name = String(part.filename ?? 'attachment');
    const mediaType = typeof part.mediaType === 'string' ? ` (${part.mediaType})` : '';
    const id = typeof part.weaveAttachmentId === 'string' ? part.weaveAttachmentId : attachmentId(messageId, partIndex);
    return `[${String(part.type)} id=${id}: ${name}${mediaType}]`;
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
  const text = message.content.parts.map((part, index) => partText(part as Record<string, unknown>, message.id, index))
    .join('\n');
  return Math.ceil(text.length / 4) + 4;
};

export const collectCompactionAttachments = (messages: MastraDBMessage[]) => {
  const attachments = new Map<string, StructuredCheckpointV2['attachments'][number]>();
  for (const message of messages) {
    message.content.parts.forEach((value, partIndex) => {
      const part = value as Record<string, unknown>;
      const kind = attachmentKind(part);
      if (!kind) return;
      const id = attachmentId(message.id, partIndex);
      attachments.set(id, {
        id,
        messageId: message.id,
        partIndex,
        kind,
        ...(typeof part.filename === 'string' && part.filename ? { name: part.filename } : {}),
        ...(typeof part.mediaType === 'string' && part.mediaType ? { mediaType: part.mediaType } : {}),
        note: '',
      });
    });
  }
  return attachments;
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

export const redactCompactionText = (value: string) =>
  value
    .replace(
      /\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|Bearer\s+[A-Za-z0-9._~+\/-]+=*)\b/gi,
      '[REDACTED]',
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    );

const redactStructuredValue = (value: unknown): unknown => {
  if (typeof value === 'string') return redactCompactionText(value);
  if (Array.isArray(value)) return value.map(redactStructuredValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactStructuredValue(entry)]),
    );
  }
  return value;
};

export const serializeCompactionMessages = (messages: MastraDBMessage[]) => {
  const prompt = compactToolHistoryPrompt(messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content.parts.map((value, partIndex) => {
      const part = value as Record<string, unknown>;
      return attachmentKind(part) ? { ...part, weaveAttachmentId: attachmentId(message.id, partIndex) } : part;
    }),
  })) as Array<Record<string, unknown>>);

  return redactCompactionText(
    prompt.map((message) => {
      const parts = Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [];
      const body = parts
        .filter((part) =>
          part.type !== 'reasoning' &&
          !(typeof part.type === 'string' && part.type.startsWith('data-'))
        )
        .map((part, partIndex) => partText(part, String(message.id ?? 'unknown'), partIndex))
        .filter(Boolean)
        .join('\n');
      return `--- ${String(message.role)} message ${String(message.id ?? '')} ---\n${body}`;
    }).join('\n\n'),
  );
};

export const buildCompactionPrompt = (input: {
  previousSummary?: string;
  previousCheckpoint?: StructuredCheckpointV2;
  transcript: string;
  instructions?: string;
  mode?: CompactionMode;
  validationErrors?: string[];
  outputFormat?: 'legacy_markdown' | 'structured_v2';
}) =>
  [
    input.outputFormat === 'legacy_markdown'
      ? `Create an updated cumulative checkpoint using exactly these Markdown headings:\n${requiredHeadings.join('\n')}
Use only supplied facts, preserve exact requirements and identifiers, distinguish completed from pending work, omit hidden reasoning, and redact secrets.`
      : `Create a version 2 structured checkpoint for a long-running coding-agent conversation.
Use only facts present in the previous checkpoint and transcript. Do not infer completion, validation, repository state,
or user intent. Preserve exact requirements, decisions, paths, commands, identifiers, errors, validation results, and
attachment IDs. Distinguish completed, pending, blocked, and failed work. Consolidate duplicates, omit hidden reasoning,
and never reproduce secrets. Return only the requested structured object.`,
    input.mode === 'rebuild'
      ? 'This is a full rebuild. Derive the checkpoint from the supplied raw transcript and do not carry forward stale facts.'
      : 'This is an incremental update. Merge new facts into the previous checkpoint and remove facts superseded by the transcript.',
    input.previousCheckpoint
      ? `PREVIOUS CUMULATIVE CHECKPOINT JSON:\n${JSON.stringify(input.previousCheckpoint)}`
      : input.previousSummary
      ? `PREVIOUS CUMULATIVE CHECKPOINT:\n${input.previousSummary}`
      : 'No previous checkpoint exists.',
    input.instructions ? `USER COMPACTION FOCUS:\n${input.instructions}` : '',
    input.validationErrors?.length
      ? `THE PREVIOUS CANDIDATE FAILED VALIDATION:\n${input.validationErrors.join('\n')}`
      : '',
    `NEW TRANSCRIPT SEGMENT:\n${input.transcript}`,
    input.outputFormat === 'legacy_markdown' ? 'Return only the updated Markdown checkpoint.' : '',
  ].filter(Boolean).join('\n\n');

export const validateCompactionSummary = (
  summary: string,
  maxTokens: number,
) => {
  const trimmed = redactCompactionText(summary.trim());
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

export const projectCompaction = (input: {
  budget: ModelContextBudget;
  fixedTokens?: number;
  previousCheckpointTokens?: number;
  sourceTokens: number;
  retainedTokens: number;
  pendingTokens?: number;
  candidateTokens: number;
}): CompactionProjection => {
  const fixedTokens = Math.max(0, input.fixedTokens ?? 0);
  const pendingTokens = Math.max(0, input.pendingTokens ?? 0);
  const previousCheckpointTokens = Math.max(0, input.previousCheckpointTokens ?? 0);
  const tokensBefore = fixedTokens + previousCheckpointTokens + input.sourceTokens + input.retainedTokens +
    pendingTokens;
  const tokensAfter = fixedTokens + input.candidateTokens + input.retainedTokens + pendingTokens;
  const reclaimedTokens = tokensBefore - tokensAfter;
  const headroomTokens = input.budget.contextLimitTokens - tokensAfter;
  const minimumGainTokens = input.budget.retryDeltaTokens;
  const hardCeilingTokens = Math.floor(input.budget.advertisedContextTokens * 0.95);
  const reason = tokensAfter >= hardCeilingTokens
    ? 'hard_ceiling' as const
    : reclaimedTokens < minimumGainTokens
    ? 'insufficient_gain' as const
    : headroomTokens < minimumGainTokens
    ? 'insufficient_headroom' as const
    : undefined;
  return {
    tokensBefore,
    tokensAfter,
    reclaimedTokens,
    headroomTokens,
    minimumGainTokens,
    hardCeilingTokens,
    accepted: reason === undefined,
    ...(reason ? { reason } : {}),
  };
};

const estimatedTextTokens = (value: string) => Math.ceil(value.length / 4) + 4;

export const batchCompactionTranscripts = (
  messages: MastraDBMessage[],
  inputCapacity: number,
) => {
  if (!Number.isFinite(inputCapacity) || inputCapacity <= 0) {
    throw new Error('Compaction input capacity must be positive.');
  }
  const batches: string[] = [];
  let sections: string[] = [];
  let tokens = 0;
  const flush = () => {
    if (!sections.length) return;
    batches.push(sections.join('\n\n'));
    sections = [];
    tokens = 0;
  };

  for (const message of messages) {
    const serialized = serializeCompactionMessages([message]);
    const messageTokens = estimatedTextTokens(serialized);
    if (messageTokens <= inputCapacity) {
      if (sections.length && tokens + messageTokens > inputCapacity) flush();
      sections.push(serialized);
      tokens += messageTokens;
      continue;
    }

    flush();
    const headerReserve = 80;
    const segmentChars = Math.max(256, (inputCapacity - headerReserve) * 4);
    const segmentCount = Math.ceil(serialized.length / segmentChars);
    for (let index = 0; index < segmentCount; index += 1) {
      batches.push([
        `--- oversized message ${message.id} segment ${index + 1}/${segmentCount} ---`,
        serialized.slice(index * segmentChars, (index + 1) * segmentChars),
      ].join('\n'));
    }
  }
  flush();
  return batches;
};

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

  async processInputStep(args: ProcessInputStepArgs): Promise<ProcessInputStepResult | undefined> {
    if (args.stepNumber === 0) return undefined;
    const runtime = getThreadCompactionStepRuntime(args.requestContext);
    if (!runtime) return undefined;
    const checkpoint = await runtime.compactIfNeeded({
      messages: args.messages,
      stepNumber: args.stepNumber,
      abortSignal: args.abortSignal,
    });
    if (!checkpoint) return undefined;

    const firstRetainedIndex = checkpoint.firstRetainedMessageId
      ? args.messages.findIndex((message) => message.id === checkpoint.firstRetainedMessageId)
      : -1;
    const compactedThroughIndex = checkpoint.compactedThroughMessageId
      ? args.messages.findIndex((message) => message.id === checkpoint.compactedThroughMessageId)
      : -1;
    const retainedAt = firstRetainedIndex >= 0
      ? firstRetainedIndex
      : compactedThroughIndex >= 0
      ? compactedThroughIndex + 1
      : -1;
    return retainedAt > 0 ? { messages: args.messages.slice(retainedAt) } : undefined;
  }

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
        compactionId: checkpoint.id,
        origin: checkpoint.trigger === 'manual' ? 'manual' : 'pre_run',
        trigger: checkpoint.trigger,
        generation: checkpoint.generation,
        mode: checkpoint.compactionMode,
        tokensBefore: checkpoint.projectionBeforeTokens ?? checkpoint.sourceTokens,
        tokensAfter: checkpoint.projectionAfterTokens ?? checkpoint.projectedTokens,
        reclaimedTokens: checkpoint.reclaimedTokens,
      },
    },
  ],
  status: { type: 'complete' as const },
  metadata: {
    createdAt: checkpoint.completedAt ?? checkpoint.createdAt,
    weaveDisplay: {
      kind: 'thread_compaction',
      compactionId: checkpoint.id,
      trigger: checkpoint.trigger,
      generation: checkpoint.generation,
    },
  },
});
