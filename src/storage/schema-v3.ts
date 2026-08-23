import { createHash } from "node:crypto";

export const SCHEMA_V3_VERSION = 3;

export const SCHEMA_V3_SQL = `
CREATE TABLE ledger_entries (
  event_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  price_snapshot_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_ledger_occurred_at ON ledger_entries(occurred_at);
`;

export const SCHEMA_V3_CHECKSUM = createHash("sha256").update(SCHEMA_V3_SQL).digest("hex");
