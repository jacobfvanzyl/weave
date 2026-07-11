CREATE TABLE IF NOT EXISTS weave.thread_compactions (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  previous_compaction_id TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'automatic')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  instructions TEXT,
  summary TEXT,
  compacted_through_message_id TEXT,
  compacted_through_created_at TIMESTAMPTZ,
  compacted_message_count INTEGER,
  first_retained_message_id TEXT,
  conversation_model TEXT NOT NULL,
  compaction_model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  advertised_context_tokens INTEGER NOT NULL,
  context_limit_percent DOUBLE PRECISION NOT NULL,
  context_limit_tokens INTEGER NOT NULL,
  recent_tail_tokens INTEGER NOT NULL,
  retry_delta_tokens INTEGER NOT NULL,
  compaction_advertised_context_tokens INTEGER NOT NULL,
  compaction_context_limit_tokens INTEGER NOT NULL,
  summary_output_tokens INTEGER NOT NULL,
  source_tokens INTEGER,
  summary_tokens INTEGER,
  projected_tokens INTEGER,
  source_fingerprint TEXT,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (resource_id, thread_id, generation)
);

CREATE UNIQUE INDEX IF NOT EXISTS thread_compactions_one_running_idx
  ON weave.thread_compactions (resource_id, thread_id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS thread_compactions_resource_thread_created_idx
  ON weave.thread_compactions (resource_id, thread_id, created_at DESC);
