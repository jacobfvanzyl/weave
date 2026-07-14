ALTER TABLE weave.thread_compactions
  ADD COLUMN IF NOT EXISTS checkpoint_json JSONB,
  ADD COLUMN IF NOT EXISTS compaction_mode TEXT,
  ADD COLUMN IF NOT EXISTS projection_before_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS projection_after_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS reclaimed_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS decision_reason TEXT;

ALTER TABLE weave.thread_compactions
  DROP CONSTRAINT IF EXISTS thread_compactions_status_check;

ALTER TABLE weave.thread_compactions
  ADD CONSTRAINT thread_compactions_status_check
  CHECK (status IN ('running', 'completed', 'rejected', 'failed', 'cancelled'));

ALTER TABLE weave.thread_compactions
  DROP CONSTRAINT IF EXISTS thread_compactions_mode_check;

ALTER TABLE weave.thread_compactions
  ADD CONSTRAINT thread_compactions_mode_check
  CHECK (compaction_mode IS NULL OR compaction_mode IN ('incremental', 'rebuild'));
