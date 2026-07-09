CREATE TABLE IF NOT EXISTS "weave"."attachments" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_id" text,
  "thread_id" text,
  "original_name" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "object_bucket" text NOT NULL,
  "object_key" text NOT NULL,
  "stored_name" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_thread_created_idx" ON "weave"."attachments" USING btree ("thread_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_original_name_mime_idx" ON "weave"."attachments" USING btree ("original_name","mime_type","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_owner_created_idx" ON "weave"."attachments" USING btree ("owner_id","created_at");
