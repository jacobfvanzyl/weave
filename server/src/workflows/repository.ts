import type { Client } from '@libsql/client';
import { getWeaveDb } from '../storage/weave-db';
import { isJsonValue, type JsonValue, optionalString } from '../services/types';
import { validateWorkflowDefinition, type WorkflowDefinition } from './definition';

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type WorkflowRunBackend = 'pending' | 'direct' | 'dbos';

export type StoredWorkflowDefinition = {
  ownerId: string;
  workflowId: string;
  version: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  definition: WorkflowDefinition;
};

export type WorkflowRunRecord = {
  ownerId: string;
  runId: string;
  workflowId: string;
  workflowVersion: string;
  status: WorkflowRunStatus;
  backend: WorkflowRunBackend;
  externalRunId?: string;
  requestId?: string;
  input: JsonValue;
  output?: JsonValue;
  error?: JsonValue;
  definition: WorkflowDefinition;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type WorkflowRunEventRecord = {
  ownerId: string;
  runId: string;
  eventId: string;
  sequence: number;
  type: string;
  data: JsonValue;
  createdAt: string;
};

export type CreateWorkflowRunRecordInput = {
  ownerId: string;
  runId?: string;
  requestId?: string;
  definition: WorkflowDefinition;
  input?: JsonValue;
};

export type ListWorkflowRunsOptions = {
  workflowId?: string;
  limit?: number;
};

export type AppendWorkflowRunEventInput = {
  ownerId: string;
  runId: string;
  eventId?: string;
  type: string;
  data: JsonValue;
};

export type ListWorkflowRunEventsOptions = {
  afterSequence?: number;
  limit?: number;
};

const workflowRunStatuses = new Set<WorkflowRunStatus>(['running', 'completed', 'failed', 'cancelled']);
const workflowRunBackends = new Set<WorkflowRunBackend>(['pending', 'direct', 'dbos']);

const parseJsonColumn = (value: unknown, label: string): JsonValue => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!isJsonValue(parsed)) throw new Error(`${label} is not JSON-safe.`);
  return parsed;
};

const parseDefinitionColumn = (value: unknown): WorkflowDefinition => {
  const definition = parseJsonColumn(value, 'Workflow definition') as WorkflowDefinition;
  validateWorkflowDefinition(definition);
  return definition;
};

const parseOptionalJsonColumn = (value: unknown, label: string) => {
  if (value === undefined || value === null) return undefined;
  return parseJsonColumn(value, label);
};

const parseDefinitionRow = (row: Record<string, unknown>): StoredWorkflowDefinition => {
  const definition = parseDefinitionColumn(row.definition);
  return {
    ownerId: String(row.owner_id),
    workflowId: String(row.workflow_id),
    version: String(row.version),
    name: String(row.name),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    definition,
  };
};

const parseRunRow = (row: Record<string, unknown>): WorkflowRunRecord => {
  const status = String(row.status) as WorkflowRunStatus;
  if (!workflowRunStatuses.has(status)) throw new Error(`Unknown workflow run status: ${status}.`);
  const backend = String(row.backend) as WorkflowRunBackend;
  if (!workflowRunBackends.has(backend)) throw new Error(`Unknown workflow run backend: ${backend}.`);

  return {
    ownerId: String(row.owner_id),
    runId: String(row.run_id),
    workflowId: String(row.workflow_id),
    workflowVersion: String(row.workflow_version),
    status,
    backend,
    externalRunId: optionalString(row.external_run_id),
    requestId: optionalString(row.request_id),
    input: parseJsonColumn(row.input, 'Workflow run input'),
    output: parseOptionalJsonColumn(row.output, 'Workflow run output'),
    error: parseOptionalJsonColumn(row.error, 'Workflow run error'),
    definition: parseDefinitionColumn(row.definition),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: optionalString(row.started_at),
    finishedAt: optionalString(row.finished_at),
  };
};

const parseRunEventRow = (row: Record<string, unknown>): WorkflowRunEventRecord => ({
  ownerId: String(row.owner_id),
  runId: String(row.run_id),
  eventId: String(row.event_id),
  sequence: Number(row.sequence),
  type: String(row.type),
  data: parseJsonColumn(row.data, 'Workflow run event data'),
  createdAt: String(row.created_at),
});

const requireOwnerId = (ownerId: string) => {
  const normalized = optionalString(ownerId);
  if (!normalized) throw new Error('ownerId is required.');
  return normalized;
};

const requireWorkflowId = (workflowId: string) => {
  const normalized = optionalString(workflowId);
  if (!normalized) throw new Error('workflowId is required.');
  return normalized;
};

const requireRunId = (runId: string) => {
  const normalized = optionalString(runId);
  if (!normalized) throw new Error('runId is required.');
  return normalized;
};

const requireEventId = (eventId: string) => {
  const normalized = optionalString(eventId);
  if (!normalized) throw new Error('eventId is required.');
  return normalized;
};

const requireEventType = (type: string) => {
  const normalized = optionalString(type);
  if (!normalized) throw new Error('Workflow run event type is required.');
  return normalized;
};

export interface WorkflowRepository {
  saveDefinition(ownerId: string, definition: WorkflowDefinition): Promise<StoredWorkflowDefinition>;
  getDefinition(ownerId: string, workflowId: string): Promise<StoredWorkflowDefinition | undefined>;
  listDefinitions(ownerId: string): Promise<StoredWorkflowDefinition[]>;
  deleteDefinition(ownerId: string, workflowId: string): Promise<boolean>;
  createRun(input: CreateWorkflowRunRecordInput): Promise<WorkflowRunRecord>;
  updateRunStarted(
    ownerId: string,
    runId: string,
    input: { backend: Exclude<WorkflowRunBackend, 'pending'>; externalRunId?: string },
  ): Promise<WorkflowRunRecord | undefined>;
  completeRun(ownerId: string, runId: string, output: JsonValue): Promise<WorkflowRunRecord | undefined>;
  failRun(ownerId: string, runId: string, error: JsonValue): Promise<WorkflowRunRecord | undefined>;
  cancelRun(ownerId: string, runId: string, error?: JsonValue): Promise<WorkflowRunRecord | undefined>;
  getRun(ownerId: string, runId: string): Promise<WorkflowRunRecord | undefined>;
  listRuns(ownerId: string, options?: ListWorkflowRunsOptions): Promise<WorkflowRunRecord[]>;
  appendRunEvent(input: AppendWorkflowRunEventInput): Promise<WorkflowRunEventRecord>;
  listRunEvents(
    ownerId: string,
    runId: string,
    options?: ListWorkflowRunEventsOptions,
  ): Promise<WorkflowRunEventRecord[]>;
}

export class LibsqlWorkflowRepository implements WorkflowRepository {
  constructor(private readonly getClient: () => Promise<Client> = getWeaveDb) {}

  async saveDefinition(ownerId: string, definition: WorkflowDefinition) {
    const normalizedOwnerId = requireOwnerId(ownerId);
    validateWorkflowDefinition(definition);
    const at = new Date().toISOString();
    const db = await this.getClient();
    await db.execute({
      sql: `INSERT INTO weave_workflow_definitions (
          owner_id, workflow_id, version, name, created_at, updated_at, definition
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, workflow_id) DO UPDATE SET
          version = excluded.version,
          name = excluded.name,
          updated_at = excluded.updated_at,
          definition = excluded.definition`,
      args: [
        normalizedOwnerId,
        definition.id,
        definition.version,
        definition.name,
        at,
        at,
        JSON.stringify(definition),
      ],
    });

    const stored = await this.getDefinition(normalizedOwnerId, definition.id);
    if (!stored) throw new Error('Workflow definition was not saved.');
    return stored;
  }

  async getDefinition(ownerId: string, workflowId: string) {
    const db = await this.getClient();
    const result = await db.execute({
      sql: `SELECT owner_id, workflow_id, version, name, created_at, updated_at, definition
        FROM weave_workflow_definitions
        WHERE owner_id = ? AND workflow_id = ?
        LIMIT 1`,
      args: [requireOwnerId(ownerId), requireWorkflowId(workflowId)],
    });
    const row = result.rows[0];
    return row ? parseDefinitionRow(row as Record<string, unknown>) : undefined;
  }

  async listDefinitions(ownerId: string) {
    const db = await this.getClient();
    const result = await db.execute({
      sql: `SELECT owner_id, workflow_id, version, name, created_at, updated_at, definition
        FROM weave_workflow_definitions
        WHERE owner_id = ?
        ORDER BY updated_at DESC`,
      args: [requireOwnerId(ownerId)],
    });
    return result.rows.map((row) => parseDefinitionRow(row as Record<string, unknown>));
  }

  async deleteDefinition(ownerId: string, workflowId: string) {
    const db = await this.getClient();
    const result = await db.execute({
      sql: `DELETE FROM weave_workflow_definitions WHERE owner_id = ? AND workflow_id = ?`,
      args: [requireOwnerId(ownerId), requireWorkflowId(workflowId)],
    });
    return Number(result.rowsAffected ?? 0) > 0;
  }

  async createRun(input: CreateWorkflowRunRecordInput) {
    const ownerId = requireOwnerId(input.ownerId);
    validateWorkflowDefinition(input.definition);
    const runId = optionalString(input.runId) ?? `wrun_${crypto.randomUUID().replace(/-/g, '')}`;
    const at = new Date().toISOString();
    const runInput = input.input ?? null;
    if (!isJsonValue(runInput)) throw new Error('Workflow run input must be JSON-safe.');

    const db = await this.getClient();
    await db.execute({
      sql: `INSERT INTO weave_workflow_runs (
          owner_id, run_id, workflow_id, workflow_version, status, backend, external_run_id, request_id,
          input, output, error, definition, created_at, updated_at, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL)`,
      args: [
        ownerId,
        runId,
        input.definition.id,
        input.definition.version,
        'running',
        'pending',
        null,
        optionalString(input.requestId) ?? null,
        JSON.stringify(runInput),
        JSON.stringify(input.definition),
        at,
        at,
      ],
    });

    const run = await this.getRun(ownerId, runId);
    if (!run) throw new Error('Workflow run was not created.');
    return run;
  }

  async updateRunStarted(
    ownerId: string,
    runId: string,
    input: { backend: Exclude<WorkflowRunBackend, 'pending'>; externalRunId?: string },
  ) {
    const at = new Date().toISOString();
    const db = await this.getClient();
    await db.execute({
      sql: `UPDATE weave_workflow_runs
        SET backend = ?, external_run_id = ?, started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE owner_id = ? AND run_id = ?`,
      args: [
        input.backend,
        optionalString(input.externalRunId) ?? null,
        at,
        at,
        requireOwnerId(ownerId),
        requireRunId(runId),
      ],
    });
    return this.getRun(ownerId, runId);
  }

  completeRun(ownerId: string, runId: string, output: JsonValue) {
    if (!isJsonValue(output)) throw new Error('Workflow run output must be JSON-safe.');
    return this.finishRun(ownerId, runId, 'completed', output, undefined);
  }

  failRun(ownerId: string, runId: string, error: JsonValue) {
    if (!isJsonValue(error)) throw new Error('Workflow run error must be JSON-safe.');
    return this.finishRun(ownerId, runId, 'failed', undefined, error);
  }

  cancelRun(ownerId: string, runId: string, error: JsonValue = { message: 'Workflow run was cancelled.' }) {
    if (!isJsonValue(error)) throw new Error('Workflow run cancellation error must be JSON-safe.');
    return this.finishRun(ownerId, runId, 'cancelled', undefined, error);
  }

  async getRun(ownerId: string, runId: string) {
    const db = await this.getClient();
    const result = await db.execute({
      sql: `SELECT owner_id, run_id, workflow_id, workflow_version, status, backend, external_run_id,
          request_id, input, output, error, definition, created_at, updated_at, started_at, finished_at
        FROM weave_workflow_runs
        WHERE owner_id = ? AND run_id = ?
        LIMIT 1`,
      args: [requireOwnerId(ownerId), requireRunId(runId)],
    });
    const row = result.rows[0];
    return row ? parseRunRow(row as Record<string, unknown>) : undefined;
  }

  async listRuns(ownerId: string, options: ListWorkflowRunsOptions = {}) {
    const limit = Number.isInteger(options.limit) && options.limit && options.limit > 0
      ? Math.min(options.limit, 200)
      : 50;
    const workflowId = optionalString(options.workflowId);
    const db = await this.getClient();
    const result = await db.execute({
      sql: workflowId
        ? `SELECT owner_id, run_id, workflow_id, workflow_version, status, backend, external_run_id,
            request_id, input, output, error, definition, created_at, updated_at, started_at, finished_at
          FROM weave_workflow_runs
          WHERE owner_id = ? AND workflow_id = ?
          ORDER BY updated_at DESC
          LIMIT ?`
        : `SELECT owner_id, run_id, workflow_id, workflow_version, status, backend, external_run_id,
            request_id, input, output, error, definition, created_at, updated_at, started_at, finished_at
          FROM weave_workflow_runs
          WHERE owner_id = ?
          ORDER BY updated_at DESC
          LIMIT ?`,
      args: workflowId ? [requireOwnerId(ownerId), workflowId, limit] : [requireOwnerId(ownerId), limit],
    });
    return result.rows.map((row) => parseRunRow(row as Record<string, unknown>));
  }

  async appendRunEvent(input: AppendWorkflowRunEventInput) {
    const ownerId = requireOwnerId(input.ownerId);
    const runId = requireRunId(input.runId);
    const eventId = requireEventId(input.eventId ?? `wevt_${crypto.randomUUID().replace(/-/g, '')}`);
    const type = requireEventType(input.type);
    if (!isJsonValue(input.data)) throw new Error('Workflow run event data must be JSON-safe.');

    const at = new Date().toISOString();
    const db = await this.getClient();
    await db.execute({
      sql: `INSERT INTO weave_workflow_run_events (
          owner_id, run_id, event_id, sequence, type, data, created_at
        ) VALUES (
          ?, ?, ?,
          COALESCE((
            SELECT MAX(sequence) + 1 FROM weave_workflow_run_events WHERE owner_id = ? AND run_id = ?
          ), 1),
          ?, ?, ?
        )
        ON CONFLICT(owner_id, run_id, event_id) DO NOTHING`,
      args: [ownerId, runId, eventId, ownerId, runId, type, JSON.stringify(input.data), at],
    });

    const event = await this.getRunEventById(ownerId, runId, eventId);
    if (!event) throw new Error('Workflow run event was not saved.');
    return event;
  }

  async listRunEvents(ownerId: string, runId: string, options: ListWorkflowRunEventsOptions = {}) {
    const limit = Number.isInteger(options.limit) && options.limit && options.limit > 0
      ? Math.min(options.limit, 500)
      : 100;
    const afterSequence = Number.isInteger(options.afterSequence) && options.afterSequence && options.afterSequence > 0
      ? options.afterSequence
      : 0;
    const db = await this.getClient();
    const result = await db.execute({
      sql: `SELECT owner_id, run_id, event_id, sequence, type, data, created_at
        FROM weave_workflow_run_events
        WHERE owner_id = ? AND run_id = ? AND sequence > ?
        ORDER BY sequence ASC
        LIMIT ?`,
      args: [requireOwnerId(ownerId), requireRunId(runId), afterSequence, limit],
    });
    return result.rows.map((row) => parseRunEventRow(row as Record<string, unknown>));
  }

  private async finishRun(
    ownerId: string,
    runId: string,
    status: Extract<WorkflowRunStatus, 'completed' | 'failed' | 'cancelled'>,
    output: JsonValue | undefined,
    error: JsonValue | undefined,
  ) {
    const at = new Date().toISOString();
    const db = await this.getClient();
    await db.execute({
      sql: `UPDATE weave_workflow_runs
        SET status = ?, output = ?, error = ?, finished_at = ?, updated_at = ?
        WHERE owner_id = ? AND run_id = ? AND status = 'running'`,
      args: [
        status,
        output === undefined ? null : JSON.stringify(output),
        error === undefined ? null : JSON.stringify(error),
        at,
        at,
        requireOwnerId(ownerId),
        requireRunId(runId),
      ],
    });
    return this.getRun(ownerId, runId);
  }

  private async getRunEventById(ownerId: string, runId: string, eventId: string) {
    const db = await this.getClient();
    const result = await db.execute({
      sql: `SELECT owner_id, run_id, event_id, sequence, type, data, created_at
        FROM weave_workflow_run_events
        WHERE owner_id = ? AND run_id = ? AND event_id = ?
        LIMIT 1`,
      args: [requireOwnerId(ownerId), requireRunId(runId), requireEventId(eventId)],
    });
    const row = result.rows[0];
    return row ? parseRunEventRow(row as Record<string, unknown>) : undefined;
  }
}

export const workflowRepository = new LibsqlWorkflowRepository();
