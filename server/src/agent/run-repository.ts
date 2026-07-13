import { getWeaveDb, type WeaveDbClient } from '../storage/postgres';
import type { ExecutionProfile } from './execution-policy';

export const agentRunStatuses = [
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;

export type AgentRunRecordStatus = typeof agentRunStatuses[number];

export type AgentRunSafeCheckpointV1 = {
  version: 1;
  boundary: 'model' | 'tool_result' | 'approval';
  sequence: number;
  toolCallId?: string;
  resumable: boolean;
  recordedAt: string;
};

export type AgentRunRecordV1 = {
  version: 1;
  runId: string;
  resourceId: string;
  threadId: string;
  mastraRunId: string;
  status: AgentRunRecordStatus;
  executionProfile: ExecutionProfile;
  model?: string;
  metadata: Record<string, unknown>;
  safeCheckpoint?: AgentRunSafeCheckpointV1;
  lastSequence: number;
  error?: string;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentRunEventV1 = {
  version: 1;
  runId: string;
  sequence: number;
  eventId: string;
  eventType: string;
  data: unknown;
  idempotencyKey?: string;
  createdAt: string;
};

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};

const optionalString = (value: unknown) => typeof value === 'string' && value ? value : undefined;

const recordFromRow = (row: Record<string, unknown>): AgentRunRecordV1 => ({
  version: 1,
  runId: String(row.run_id),
  resourceId: String(row.resource_id),
  threadId: String(row.thread_id),
  mastraRunId: String(row.mastra_run_id),
  status: String(row.status) as AgentRunRecordStatus,
  executionProfile: String(row.execution_profile) as ExecutionProfile,
  model: optionalString(row.model),
  metadata: parseJson(row.metadata, {}),
  safeCheckpoint: parseJson<AgentRunSafeCheckpointV1 | undefined>(row.safe_checkpoint, undefined),
  lastSequence: Number(row.last_sequence),
  error: optionalString(row.error),
  startedAt: String(row.started_at),
  completedAt: optionalString(row.completed_at),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

const eventFromRow = (row: Record<string, unknown>): AgentRunEventV1 => ({
  version: 1,
  runId: String(row.run_id),
  sequence: Number(row.sequence),
  eventId: String(row.event_id),
  eventType: String(row.event_type),
  data: parseJson(row.data, null),
  idempotencyKey: optionalString(row.idempotency_key),
  createdAt: String(row.created_at),
});

const selectRunColumns = `
  run_id, resource_id, thread_id, mastra_run_id, status, execution_profile, model, metadata,
  safe_checkpoint, last_sequence, error, started_at, completed_at, created_at, updated_at
`;

export class AgentRunRepository {
  constructor(private readonly getDb: () => Promise<WeaveDbClient> = getWeaveDb) {}

  async create(input: {
    runId: string;
    resourceId: string;
    threadId: string;
    mastraRunId: string;
    executionProfile: ExecutionProfile;
    model?: string;
    metadata?: Record<string, unknown>;
    startedAt: string;
  }) {
    const db = await this.getDb();
    await db.execute({
      sql: `insert into agent_runs (
        run_id, resource_id, thread_id, mastra_run_id, status, execution_profile, model, metadata,
        last_sequence, started_at, created_at, updated_at
      ) values (?, ?, ?, ?, 'running', ?, ?, ?::jsonb, 0, ?, ?, ?)`,
      args: [
        input.runId,
        input.resourceId,
        input.threadId,
        input.mastraRunId,
        input.executionProfile,
        input.model,
        JSON.stringify(input.metadata ?? {}),
        input.startedAt,
        input.startedAt,
        input.startedAt,
      ],
    });
    return this.get(input.runId);
  }

  async get(runId: string) {
    const db = await this.getDb();
    const result = await db.execute({
      sql: `select ${selectRunColumns} from agent_runs where run_id = ? limit 1`,
      args: [runId],
    });
    return result.rows[0] ? recordFromRow(result.rows[0]) : undefined;
  }

  async latest(resourceId: string, threadId: string) {
    const db = await this.getDb();
    const result = await db.execute({
      sql: `select ${selectRunColumns} from agent_runs
        where resource_id = ? and thread_id = ? order by started_at desc limit 1`,
      args: [resourceId, threadId],
    });
    return result.rows[0] ? recordFromRow(result.rows[0]) : undefined;
  }

  async appendEvent(input: {
    runId: string;
    sequence: number;
    eventType: string;
    data: unknown;
    eventId?: string;
    idempotencyKey?: string;
    checkpoint?: AgentRunSafeCheckpointV1;
    status?: AgentRunRecordStatus;
  }) {
    const db = await this.getDb();
    const now = new Date().toISOString();
    await db.batch([
      {
        sql: `insert into agent_run_events (
          run_id, sequence, event_id, event_type, data, idempotency_key, created_at
        ) values (?, ?, ?, ?, ?::jsonb, ?, ?) on conflict (run_id, sequence) do nothing`,
        args: [
          input.runId,
          input.sequence,
          input.eventId ?? crypto.randomUUID(),
          input.eventType,
          JSON.stringify(input.data ?? null),
          input.idempotencyKey,
          now,
        ],
      },
      {
        sql: `update agent_runs set last_sequence = greatest(last_sequence, ?),
          safe_checkpoint = coalesce(?::jsonb, safe_checkpoint), status = coalesce(?, status), updated_at = ?
          where run_id = ?`,
        args: [
          input.sequence,
          input.checkpoint ? JSON.stringify(input.checkpoint) : null,
          input.status,
          now,
          input.runId,
        ],
      },
    ], 'write');
  }

  async settle(
    runId: string,
    status: Extract<AgentRunRecordStatus, 'completed' | 'failed' | 'cancelled'>,
    error?: string,
  ) {
    const db = await this.getDb();
    await db.execute({
      sql: `update agent_runs set status = ?, error = ?, completed_at = now(), updated_at = now()
        where run_id = ? and status in ('running', 'awaiting_approval', 'interrupted')`,
      args: [status, error?.slice(0, 2000), runId],
    });
  }

  async markRunning(runId: string) {
    const db = await this.getDb();
    await db.execute({
      sql: `update agent_runs set status = 'running', updated_at = now()
        where run_id = ? and status in ('awaiting_approval', 'interrupted')`,
      args: [runId],
    });
  }

  async interruptActiveRuns() {
    const db = await this.getDb();
    return await db.execute(`update agent_runs set status = 'interrupted', updated_at = now()
      where status = 'running'`);
  }

  async interrupt(runId: string) {
    const db = await this.getDb();
    await db.execute({
      sql: `update agent_runs set status = 'interrupted', updated_at = now()
        where run_id = ? and status = 'running'`,
      args: [runId],
    });
    return this.get(runId);
  }

  async events(runId: string, afterSequence = 0, limit = 10_000) {
    const db = await this.getDb();
    const result = await db.execute({
      sql: `select run_id, sequence, event_id, event_type, data, idempotency_key, created_at
        from agent_run_events where run_id = ? and sequence > ? order by sequence asc limit ?`,
      args: [runId, Math.max(0, afterSequence), Math.min(10_000, Math.max(1, limit))],
    });
    return result.rows.map(eventFromRow);
  }
}

export const agentRunRepository = new AgentRunRepository();
