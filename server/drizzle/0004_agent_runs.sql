CREATE TABLE IF NOT EXISTS weave.agent_runs (
  run_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  mastra_run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'interrupted'
  )),
  execution_profile TEXT NOT NULL CHECK (execution_profile IN ('observe', 'workspace', 'host')),
  model TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  safe_checkpoint JSONB,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_resource_thread_active_idx
  ON weave.agent_runs (resource_id, thread_id)
  WHERE status IN ('running', 'awaiting_approval');

CREATE INDEX IF NOT EXISTS agent_runs_resource_thread_updated_idx
  ON weave.agent_runs (resource_id, thread_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS weave.agent_run_events (
  run_id TEXT NOT NULL REFERENCES weave.agent_runs(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  data JSONB NOT NULL,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, sequence),
  UNIQUE (run_id, event_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_run_events_idempotency_idx
  ON weave.agent_run_events (run_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_run_events_run_created_idx
  ON weave.agent_run_events (run_id, created_at);
