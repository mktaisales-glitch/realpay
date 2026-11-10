import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

/* ######################################################################
 * SQLite schema. One file, no ORM. Amounts are integer cents.
 * The ledger table is append-only: triggers reject UPDATE and DELETE.
 * ###################################################################### */

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  title TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  contractor_name TEXT NOT NULL,
  owner_token_hash TEXT NOT NULL,
  contractor_token_hash TEXT NOT NULL,
  retention_bps INTEGER NOT NULL,
  retention_days INTEGER NOT NULL,
  auto_release_max_cents INTEGER NOT NULL,
  min_confidence REAL NOT NULL,
  site_lat REAL,
  site_lng REAL,
  site_radius_m INTEGER NOT NULL DEFAULT 500,
  clock_offset_days INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  checklist TEXT NOT NULL,
  proof_type TEXT NOT NULL,
  upfront_label TEXT NOT NULL,
  held_label TEXT NOT NULL,
  upfront_cents INTEGER NOT NULL,
  held_cents INTEGER NOT NULL,
  supplier_email TEXT NOT NULL,
  contractor_email TEXT NOT NULL,
  planned_start TEXT NOT NULL,
  planned_end TEXT NOT NULL,
  forecast_start TEXT NOT NULL,
  forecast_end TEXT NOT NULL,
  status TEXT NOT NULL,
  order_id TEXT,
  authorization_id TEXT,
  auth_expires_at TEXT,
  upfront_capture_id TEXT,
  held_capture_id TEXT,
  paypal_fee_cents INTEGER NOT NULL DEFAULT 0,
  retention_cents INTEGER NOT NULL DEFAULT 0,
  retention_release_at TEXT,
  retention_status TEXT NOT NULL DEFAULT 'none',
  dispute_id TEXT,
  dispute_status TEXT,
  released_at TEXT,
  UNIQUE (project_id, seq)
);

CREATE TABLE IF NOT EXISTS proofs (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  note TEXT,
  exif TEXT NOT NULL,
  flags TEXT NOT NULL,
  verdict TEXT,
  decision TEXT NOT NULL,
  decision_reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proofs_by_sha ON proofs(sha256);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  kind TEXT NOT NULL,
  receiver TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  batch_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (milestone_id, kind)
);

CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  milestone_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  amount_cents INTEGER,
  paypal_ref TEXT,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_by_project ON ledger(project_id, seq);
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger
  BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger
  BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  resource_id TEXT,
  verified INTEGER NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_usage (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider)
);

CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key TEXT PRIMARY KEY,
  verdict TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDatabase(filePath: string): Db {
  if (filePath !== ":memory:") {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
