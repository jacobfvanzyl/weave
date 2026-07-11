CREATE TABLE IF NOT EXISTS "weave"."user_artifacts" (
  "owner_id" text NOT NULL,
  "artifact_kind" text NOT NULL,
  "name" text NOT NULL,
  "object_bucket" text NOT NULL,
  "object_key" text NOT NULL,
  "object_prefix" text,
  "content_hash" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "metadata" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "user_artifacts_owner_kind_name_pk" PRIMARY KEY("owner_id","artifact_kind","name"),
  CONSTRAINT "user_artifacts_kind_check" CHECK ("artifact_kind" in ('prompt', 'skill'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_artifacts_owner_kind_updated_idx" ON "weave"."user_artifacts" USING btree ("owner_id","artifact_kind","updated_at");
