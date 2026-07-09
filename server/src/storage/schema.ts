import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, unique } from 'drizzle-orm/pg-core';

export const weaveSchema = pgSchema('weave');

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
};

export const productProjects = weaveSchema.table(
  'product_projects',
  {
    ownerId: text('owner_id').notNull(),
    product: text('product').notNull(),
    projectId: text('project_id').notNull(),
    projectKind: text('project_kind').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order'),
    ...timestamps,
    data: jsonb('data').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.product, table.projectId] }),
    index('product_projects_owner_product_updated_idx').on(table.ownerId, table.product, table.updatedAt),
    index('product_projects_owner_project_idx').on(table.ownerId, table.projectId),
  ],
);

export const attachments = weaveSchema.table(
  'attachments',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id'),
    threadId: text('thread_id'),
    originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    objectBucket: text('object_bucket').notNull(),
    objectKey: text('object_key').notNull(),
    storedName: text('stored_name').notNull(),
    ...timestamps,
  },
  (table) => [
    index('attachments_thread_created_idx').on(table.threadId, table.createdAt),
    index('attachments_original_name_mime_idx').on(table.originalName, table.mimeType, table.createdAt),
    index('attachments_owner_created_idx').on(table.ownerId, table.createdAt),
  ],
);

export const serviceBindings = weaveSchema.table(
  'service_bindings',
  {
    ownerId: text('owner_id').notNull(),
    bindingId: text('binding_id').notNull(),
    providerKind: text('provider_kind').notNull(),
    scopeKind: text('scope_kind').notNull(),
    data: jsonb('data').notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.bindingId] }),
    index('service_bindings_owner_provider_idx').on(table.ownerId, table.providerKind, table.updatedAt),
    check(
      'service_bindings_provider_kind_check',
      sql`${table.providerKind} in ('portal', 'client', 'server', 'external')`,
    ),
  ],
);

export const portalSettings = weaveSchema.table('portal_settings', {
  ownerId: text('owner_id').primaryKey(),
  primaryPortalId: text('primary_portal_id'),
  ...timestamps,
});

export const portalTokens = weaveSchema.table(
  'portal_tokens',
  {
    ownerId: text('owner_id').notNull(),
    portalId: text('portal_id').notNull(),
    token: text('token').notNull(),
    status: text('status').notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.portalId] }),
    unique('portal_tokens_token_idx').on(table.token),
    check('portal_tokens_status_check', sql`${table.status} in ('issued', 'revoked')`),
  ],
);

export const workflowDefinitions = weaveSchema.table(
  'workflow_definitions',
  {
    ownerId: text('owner_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    version: text('version').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    definition: jsonb('definition').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.workflowId] }),
    index('workflow_definitions_owner_updated_idx').on(table.ownerId, table.updatedAt),
  ],
);

export const workflowRuns = weaveSchema.table(
  'workflow_runs',
  {
    ownerId: text('owner_id').notNull(),
    runId: text('run_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    workflowVersion: text('workflow_version').notNull(),
    status: text('status').notNull(),
    backend: text('backend').notNull(),
    externalRunId: text('external_run_id'),
    requestId: text('request_id'),
    input: jsonb('input').notNull(),
    output: jsonb('output'),
    error: jsonb('error'),
    definition: jsonb('definition').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.runId] }),
    index('workflow_runs_owner_updated_idx').on(table.ownerId, table.updatedAt),
    index('workflow_runs_owner_workflow_idx').on(table.ownerId, table.workflowId, table.updatedAt),
    check('workflow_runs_status_check', sql`${table.status} in ('running', 'completed', 'failed', 'cancelled')`),
    check('workflow_runs_backend_check', sql`${table.backend} in ('pending', 'direct', 'dbos')`),
  ],
);

export const workflowRunEvents = weaveSchema.table(
  'workflow_run_events',
  {
    ownerId: text('owner_id').notNull(),
    runId: text('run_id').notNull(),
    eventId: text('event_id').notNull(),
    sequence: integer('sequence').notNull(),
    type: text('type').notNull(),
    data: jsonb('data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.runId, table.sequence] }),
    unique('workflow_run_events_owner_run_event_id_idx').on(table.ownerId, table.runId, table.eventId),
    index('workflow_run_events_owner_run_created_idx').on(table.ownerId, table.runId, table.createdAt),
  ],
);

export const legacyLibsqlRows = weaveSchema.table(
  'legacy_libsql_rows',
  {
    sourceTable: text('source_table').notNull(),
    sourcePrimaryKey: text('source_primary_key').notNull(),
    rowData: jsonb('row_data').notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceTable, table.sourcePrimaryKey] }),
  ],
);
