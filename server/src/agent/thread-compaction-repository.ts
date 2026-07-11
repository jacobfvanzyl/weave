import type { ModelContextBudget } from './context-budget';
import { getWeaveDb, type WeaveDbClient } from '../storage/postgres';

export type ThreadCompactionTrigger = 'manual' | 'automatic';
export type ThreadCompactionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type ThreadCompactionRecord = {
  id: string;
  resourceId: string;
  threadId: string;
  generation: number;
  previousCompactionId?: string;
  trigger: ThreadCompactionTrigger;
  status: ThreadCompactionStatus;
  instructions?: string;
  summary?: string;
  compactedThroughMessageId?: string;
  compactedThroughCreatedAt?: string;
  compactedMessageCount?: number;
  firstRetainedMessageId?: string;
  conversationModel: string;
  compactionModel: string;
  reasoningEffort: string;
  advertisedContextTokens: number;
  contextLimitPercent: number;
  contextLimitTokens: number;
  recentTailTokens: number;
  retryDeltaTokens: number;
  compactionAdvertisedContextTokens: number;
  compactionContextLimitTokens: number;
  summaryOutputTokens: number;
  sourceTokens?: number;
  summaryTokens?: number;
  projectedTokens?: number;
  sourceFingerprint?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

const optionalString = (value: unknown) => typeof value === 'string' && value ? value : undefined;
const optionalNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const sanitizedError = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|Bearer\s+[^\s,;]+)\b/gi, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(0, 2000);

const recordFromRow = (row: Record<string, unknown>): ThreadCompactionRecord => ({
  id: String(row.id),
  resourceId: String(row.resource_id),
  threadId: String(row.thread_id),
  generation: Number(row.generation),
  previousCompactionId: optionalString(row.previous_compaction_id),
  trigger: String(row.trigger) as ThreadCompactionTrigger,
  status: String(row.status) as ThreadCompactionStatus,
  instructions: optionalString(row.instructions),
  summary: optionalString(row.summary),
  compactedThroughMessageId: optionalString(row.compacted_through_message_id),
  compactedThroughCreatedAt: optionalString(row.compacted_through_created_at),
  compactedMessageCount: optionalNumber(row.compacted_message_count),
  firstRetainedMessageId: optionalString(row.first_retained_message_id),
  conversationModel: String(row.conversation_model),
  compactionModel: String(row.compaction_model),
  reasoningEffort: String(row.reasoning_effort),
  advertisedContextTokens: Number(row.advertised_context_tokens),
  contextLimitPercent: Number(row.context_limit_percent),
  contextLimitTokens: Number(row.context_limit_tokens),
  recentTailTokens: Number(row.recent_tail_tokens),
  retryDeltaTokens: Number(row.retry_delta_tokens),
  compactionAdvertisedContextTokens: Number(row.compaction_advertised_context_tokens),
  compactionContextLimitTokens: Number(row.compaction_context_limit_tokens),
  summaryOutputTokens: Number(row.summary_output_tokens),
  sourceTokens: optionalNumber(row.source_tokens),
  summaryTokens: optionalNumber(row.summary_tokens),
  projectedTokens: optionalNumber(row.projected_tokens),
  sourceFingerprint: optionalString(row.source_fingerprint),
  error: optionalString(row.error),
  startedAt: String(row.started_at),
  completedAt: optionalString(row.completed_at),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

const selectColumns = `
  id, resource_id, thread_id, generation, previous_compaction_id, trigger, status, instructions, summary,
  compacted_through_message_id, compacted_through_created_at, compacted_message_count,
  first_retained_message_id, conversation_model, compaction_model, reasoning_effort,
  advertised_context_tokens, context_limit_percent, context_limit_tokens, recent_tail_tokens,
  retry_delta_tokens, compaction_advertised_context_tokens, compaction_context_limit_tokens, summary_output_tokens,
  source_tokens, summary_tokens, projected_tokens, source_fingerprint, error,
  started_at, completed_at, created_at, updated_at
`;

export class ThreadCompactionRepository {
  constructor(private readonly getDb: () => Promise<WeaveDbClient> = getWeaveDb) {}

  async latest(resourceId: string, threadId: string, completedOnly = true) {
    const db = await this.getDb();
    const result = await db.execute({
      sql: `select ${selectColumns} from thread_compactions
        where resource_id = ? and thread_id = ? ${completedOnly ? "and status = 'completed'" : ''}
        order by generation desc limit 1`,
      args: [resourceId, threadId],
    });
    return result.rows[0] ? recordFromRow(result.rows[0]) : undefined;
  }

  async completed(resourceId: string, threadId: string) {
    const db = await this.getDb();
    const result = await db.execute({
      sql: `select ${selectColumns} from thread_compactions
        where resource_id = ? and thread_id = ? and status = 'completed'
        order by generation asc`,
      args: [resourceId, threadId],
    });
    return result.rows.map(recordFromRow);
  }

  async begin(input: {
    resourceId: string;
    threadId: string;
    trigger: ThreadCompactionTrigger;
    instructions?: string;
    conversationBudget: ModelContextBudget;
    compactionBudget: ModelContextBudget;
    compactionModel: string;
    reasoningEffort: string;
    sourceTokens: number;
  }) {
    const db = await this.getDb();
    const staleBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await db.execute({
      sql: `update thread_compactions set status = 'failed', error = 'stale compaction job', updated_at = now()
        where resource_id = ? and thread_id = ? and status = 'running' and started_at < ?`,
      args: [input.resourceId, input.threadId, staleBefore],
    });
    const [previous, latestGeneration] = await Promise.all([
      this.latest(input.resourceId, input.threadId),
      this.latest(input.resourceId, input.threadId, false),
    ]);
    const generation = (latestGeneration?.generation ?? 0) + 1;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await db.execute({
        sql: `insert into thread_compactions (
          id, resource_id, thread_id, generation, previous_compaction_id, trigger, status, instructions,
          conversation_model, compaction_model, reasoning_effort, advertised_context_tokens,
          context_limit_percent, context_limit_tokens, recent_tail_tokens, retry_delta_tokens,
          compaction_advertised_context_tokens, compaction_context_limit_tokens, summary_output_tokens,
          source_tokens, started_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          input.resourceId,
          input.threadId,
          generation,
          previous?.id,
          input.trigger,
          input.instructions,
          input.conversationBudget.modelId,
          input.compactionModel,
          input.reasoningEffort,
          input.conversationBudget.advertisedContextTokens,
          input.conversationBudget.contextLimitPercent,
          input.conversationBudget.contextLimitTokens,
          input.conversationBudget.recentTailTokens,
          input.conversationBudget.retryDeltaTokens,
          input.compactionBudget.advertisedContextTokens,
          input.compactionBudget.contextLimitTokens,
          input.compactionBudget.summaryOutputTokens,
          input.sourceTokens,
          now,
          now,
          now,
        ],
      });
    } catch (error) {
      if (String(error).includes('thread_compactions_one_running_idx')) {
        throw Object.assign(new Error('thread compaction is already running'), { status: 409 });
      }
      throw error;
    }
    return (await this.latest(input.resourceId, input.threadId, false))!;
  }

  async complete(id: string, result: {
    summary: string;
    compactedThroughMessageId: string;
    compactedThroughCreatedAt?: string;
    compactedMessageCount: number;
    firstRetainedMessageId?: string;
    sourceTokens: number;
    summaryTokens: number;
    projectedTokens: number;
    sourceFingerprint: string;
  }) {
    const db = await this.getDb();
    await db.execute({
      sql: `update thread_compactions set status = 'completed', summary = ?, compacted_through_message_id = ?,
        compacted_through_created_at = ?, compacted_message_count = ?, first_retained_message_id = ?,
        source_tokens = ?, summary_tokens = ?, projected_tokens = ?, source_fingerprint = ?,
        completed_at = now(), updated_at = now() where id = ? and status = 'running'`,
      args: [
        result.summary,
        result.compactedThroughMessageId,
        result.compactedThroughCreatedAt,
        result.compactedMessageCount,
        result.firstRetainedMessageId,
        result.sourceTokens,
        result.summaryTokens,
        result.projectedTokens,
        result.sourceFingerprint,
        id,
      ],
    });
  }

  async fail(id: string, error: unknown, cancelled = false) {
    const db = await this.getDb();
    const message = sanitizedError(error);
    await db.execute({
      sql: `update thread_compactions set status = ?, error = ?, completed_at = now(), updated_at = now()
        where id = ? and status = 'running'`,
      args: [cancelled ? 'cancelled' : 'failed', message, id],
    });
  }

  async deleteThread(resourceId: string, threadId: string) {
    const db = await this.getDb();
    await db.execute({
      sql: 'delete from thread_compactions where resource_id = ? and thread_id = ?',
      args: [resourceId, threadId],
    });
  }
}

export const threadCompactionRepository = new ThreadCompactionRepository();
