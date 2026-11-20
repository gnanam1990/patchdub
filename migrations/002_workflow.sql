-- PatchDub schema v2: alignment, plans, patches, purchases, findings, reviews,
-- exports, outbox, operations, local provider order book, audit log.

CREATE TABLE alignments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  old_revision_id TEXT NOT NULL,
  new_revision_id TEXT NOT NULL,
  group_key TEXT NOT NULL,
  old_cue_ids TEXT NOT NULL,
  new_cue_ids TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('unchanged','retime','edit','insertion','deletion','ambiguous')),
  reason TEXT NOT NULL,
  confidence REAL NOT NULL,
  resolver TEXT,
  status TEXT NOT NULL DEFAULT 'auto' CHECK (status IN ('auto','needs_review','resolved')),
  created_at TEXT NOT NULL,
  UNIQUE (new_revision_id, group_key)
);

CREATE TABLE glossaries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  digest TEXT NOT NULL,
  terms TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE repair_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  new_revision_id TEXT NOT NULL,
  glossary_id TEXT,
  glossary_digest TEXT,
  unit_price_minor INTEGER NOT NULL,
  total_minor INTEGER NOT NULL,
  cap_minor INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('ready','approved','cap_exceeded','translating','stale','blocked_ambiguous')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE plan_items (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES repair_plans(id),
  group_key TEXT NOT NULL,
  new_cue_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  price_minor INTEGER NOT NULL,
  seq INTEGER NOT NULL
);

CREATE TABLE patches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES repair_plans(id),
  group_key TEXT NOT NULL,
  new_cue_id TEXT NOT NULL,
  change_kind TEXT NOT NULL,
  source_text TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '[]',
  glossary_digest TEXT,
  expected_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  variant_text TEXT,
  variant_hash TEXT,
  approved_by TEXT,
  approved_digest TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  patch_id TEXT NOT NULL REFERENCES patches(id),
  plan_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  order_key TEXT NOT NULL UNIQUE,
  quote_minor INTEGER NOT NULL,
  amount_minor INTEGER,
  token TEXT NOT NULL DEFAULT 'CREDITS',
  decimals INTEGER NOT NULL DEFAULT 0,
  rail TEXT NOT NULL DEFAULT 'local-emulator',
  external_ref TEXT,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved','dispatched','settled','unknown','reconciled','failed','cancelled')),
  receipt TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_orders (
  external_ref TEXT PRIMARY KEY,
  order_key TEXT NOT NULL,
  items TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  token TEXT NOT NULL,
  state TEXT NOT NULL,
  receipt TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  patch_id TEXT NOT NULL REFERENCES patches(id),
  cue_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'block',
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  source_offset_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_digest TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_findings_patch ON findings(patch_id, status);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  patch_id TEXT NOT NULL REFERENCES patches(id),
  variant_hash TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('approve','reject')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  edition_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('draft','final')),
  artifact_path TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  manifest TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  operation_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX idx_outbox_pending ON outbox(status, kind);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  resource_id TEXT,
  response TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
