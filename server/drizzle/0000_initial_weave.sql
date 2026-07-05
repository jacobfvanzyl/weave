CREATE SCHEMA IF NOT EXISTS "weave";
CREATE SCHEMA IF NOT EXISTS "mastra";
CREATE SCHEMA IF NOT EXISTS "dbos";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weave"."legacy_libsql_rows" (
  "source_table" text NOT NULL,
  "source_primary_key" text NOT NULL,
  "row_data" jsonb NOT NULL,
  "imported_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "legacy_libsql_rows_source_table_source_primary_key_pk" PRIMARY KEY("source_table","source_primary_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weave"."portal_settings" (
  "owner_id" text PRIMARY KEY NOT NULL,
  "primary_portal_id" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weave"."portal_tokens" (
  "owner_id" text NOT NULL,
  "portal_id" text NOT NULL,
  "token" text NOT NULL,
  "status" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "portal_tokens_owner_id_portal_id_pk" PRIMARY KEY("owner_id","portal_id"),
  CONSTRAINT "portal_tokens_token_idx" UNIQUE("token"),
  CONSTRAINT "portal_tokens_status_check" CHECK ("weave"."portal_tokens"."status" in ('issued', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weave"."product_projects" (
  "owner_id" text NOT NULL,
  "product" text NOT NULL,
  "project_id" text NOT NULL,
  "project_kind" text NOT NULL,
  "name" text NOT NULL,
  "sort_order" integer,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "data" jsonb NOT NULL,
  CONSTRAINT "product_projects_owner_id_product_project_id_pk" PRIMARY KEY("owner_id","product","project_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weave"."service_bindings" (
  "owner_id" text NOT NULL,
  "binding_id" text NOT NULL,
  "provider_kind" text NOT NULL,
  "scope_kind" text NOT NULL,
  "data" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "service_bindings_owner_id_binding_id_pk" PRIMARY KEY("owner_id","binding_id"),
  CONSTRAINT "service_bindings_provider_kind_check" CHECK ("weave"."service_bindings"."provider_kind" in ('portal', 'client', 'server', 'external'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weave"."workflow_definitions" (
  "owner_id" text NOT NULL,
  "workflow_id" text NOT NULL,
  "version" text NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "definition" jsonb NOT NULL,
  CONSTRAINT "workflow_definitions_owner_id_workflow_id_pk" PRIMARY KEY("owner_id","workflow_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weave"."workflow_run_events" (
  "owner_id" text NOT NULL,
  "run_id" text NOT NULL,
  "event_id" text NOT NULL,
  "sequence" integer NOT NULL,
  "type" text NOT NULL,
  "data" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "workflow_run_events_owner_id_run_id_sequence_pk" PRIMARY KEY("owner_id","run_id","sequence"),
  CONSTRAINT "workflow_run_events_owner_run_event_id_idx" UNIQUE("owner_id","run_id","event_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weave"."workflow_runs" (
  "owner_id" text NOT NULL,
  "run_id" text NOT NULL,
  "workflow_id" text NOT NULL,
  "workflow_version" text NOT NULL,
  "status" text NOT NULL,
  "backend" text NOT NULL,
  "external_run_id" text,
  "request_id" text,
  "input" jsonb NOT NULL,
  "output" jsonb,
  "error" jsonb,
  "definition" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  CONSTRAINT "workflow_runs_owner_id_run_id_pk" PRIMARY KEY("owner_id","run_id"),
  CONSTRAINT "workflow_runs_status_check" CHECK ("weave"."workflow_runs"."status" in ('running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT "workflow_runs_backend_check" CHECK ("weave"."workflow_runs"."backend" in ('pending', 'direct', 'dbos'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_projects_owner_product_updated_idx" ON "weave"."product_projects" USING btree ("owner_id","product","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_projects_owner_project_idx" ON "weave"."product_projects" USING btree ("owner_id","project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_bindings_owner_provider_idx" ON "weave"."service_bindings" USING btree ("owner_id","provider_kind","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_definitions_owner_updated_idx" ON "weave"."workflow_definitions" USING btree ("owner_id","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_run_events_owner_run_created_idx" ON "weave"."workflow_run_events" USING btree ("owner_id","run_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_owner_updated_idx" ON "weave"."workflow_runs" USING btree ("owner_id","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_owner_workflow_idx" ON "weave"."workflow_runs" USING btree ("owner_id","workflow_id","updated_at");
