-- PatchDub schema v1: workspaces, actors, editions, revisions, cues.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT 'ta',
  retention_days INTEGER NOT NULL DEFAULT 90,
  created_at TEXT NOT NULL
);

CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('producer','editor','reviewer','distributor','operator')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE editions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL DEFAULT '',
  source_locale TEXT NOT NULL,
  target_locale TEXT NOT NULL,
  active_revision_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  edition_id TEXT NOT NULL REFERENCES editions(id),
  workspace_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('source','target')),
  label TEXT NOT NULL DEFAULT '',
  source_revision_id TEXT,
  input_sha256 TEXT NOT NULL,
  artifact_path TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  imported_at TEXT NOT NULL,
  UNIQUE (edition_id, kind, idempotency_key)
);

CREATE TABLE cues (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  workspace_id TEXT NOT NULL,
  cue_id TEXT,
  seq INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  source_text TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  approved_target_text TEXT
);

CREATE INDEX idx_cues_revision ON cues(revision_id, seq);
CREATE INDEX idx_revisions_edition ON revisions(edition_id, kind);
CREATE INDEX idx_actors_workspace ON actors(workspace_id);
