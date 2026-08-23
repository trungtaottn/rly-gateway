import { createHash } from "node:crypto";

export const SCHEMA_V4_VERSION = 4;

export const SCHEMA_V4_SQL = `
CREATE TABLE pools_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  strategy TEXT NOT NULL CHECK (strategy IN ('manual', 'round-robin', 'fill-first', 'adaptive')),
  affinity TEXT,
  retry_budget INTEGER NOT NULL DEFAULT 1 CHECK (retry_budget >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
INSERT INTO pools_new SELECT * FROM pools;
DROP TABLE pools;
ALTER TABLE pools_new RENAME TO pools;
CREATE TABLE IF NOT EXISTS pool_health (
  account_id TEXT PRIMARY KEY,
  ewma REAL NOT NULL,
  errors INTEGER NOT NULL,
  total INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`;

export const SCHEMA_V4_CHECKSUM = createHash("sha256").update(SCHEMA_V4_SQL).digest("hex");
