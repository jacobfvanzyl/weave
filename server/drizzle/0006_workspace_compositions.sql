CREATE TABLE IF NOT EXISTS weave.workspace_compositions (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  document JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT workspace_compositions_owner_id_workspace_id_pk
    PRIMARY KEY (owner_id, workspace_id),
  CONSTRAINT workspace_compositions_schema_version_check
    CHECK (schema_version > 0),
  CONSTRAINT workspace_compositions_revision_check
    CHECK (revision > 0)
);

CREATE INDEX IF NOT EXISTS workspace_compositions_owner_updated_idx
  ON weave.workspace_compositions (owner_id, updated_at);
