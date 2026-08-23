import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ControlPlaneStore } from "../control-plane/store.js";

export type GovernanceKey = Readonly<{
  id: string;
  name: string;
  prefix: string;
  hash: string;
  profileId?: string;
  poolId?: string;
  budgetUsd?: number;
  rpmLimit?: number;
  allowedModels?: readonly string[];
  createdAt: string;
  revokedAt?: string;
}>;

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function secureEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function ensureKeysTable(store: ControlPlaneStore): void {
  store.database.exec(`
    CREATE TABLE IF NOT EXISTS governance_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      hash TEXT NOT NULL,
      profile_id TEXT,
      pool_id TEXT,
      budget_usd REAL,
      rpm_limit INTEGER,
      allowed_models TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_governance_keys_hash ON governance_keys(hash);
    CREATE TABLE IF NOT EXISTS key_usage (
      key_id TEXT PRIMARY KEY REFERENCES governance_keys(id),
      spent_usd REAL NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      window_start TEXT NOT NULL
    ) STRICT;
  `);
}

export function createGovernanceKey(
  store: ControlPlaneStore,
  input: Readonly<{ name: string; profileId?: string; poolId?: string; budgetUsd?: number; rpmLimit?: number; allowedModels?: readonly string[] }>,
): Readonly<{ key: GovernanceKey; secret: string }> {
  ensureKeysTable(store);
  const id = randomBytes(12).toString("hex");
  const secret = `rly_${randomBytes(24).toString("hex")}`;
  const hash = hashSecret(secret);
  const now = new Date().toISOString();
  const allowed = input.allowedModels ? JSON.stringify(input.allowedModels) : null;
  store.database.prepare(`
    INSERT INTO governance_keys(id, name, prefix, hash, profile_id, pool_id, budget_usd, rpm_limit, allowed_models, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.name, "rly_", hash, input.profileId ?? null, input.poolId ?? null, input.budgetUsd ?? null, input.rpmLimit ?? null, allowed, now);
  store.database.prepare(`INSERT INTO key_usage(key_id, spent_usd, request_count, window_start) VALUES (?, 0, 0, ?)`).run(id, now);
  const key: GovernanceKey = {
    id,
    name: input.name,
    prefix: "rly_",
    hash,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    ...(input.poolId ? { poolId: input.poolId } : {}),
    ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
    ...(input.rpmLimit !== undefined ? { rpmLimit: input.rpmLimit } : {}),
    ...(input.allowedModels ? { allowedModels: input.allowedModels } : {}),
    createdAt: now,
  };
  return { key, secret };
}

export function listGovernanceKeys(store: ControlPlaneStore): readonly GovernanceKey[] {
  ensureKeysTable(store);
  const rows = store.database.prepare("SELECT id, name, prefix, hash, profile_id as profileId, pool_id as poolId, budget_usd as budgetUsd, rpm_limit as rpmLimit, allowed_models as allowedModels, created_at as createdAt, revoked_at as revokedAt FROM governance_keys").all() as Array<{
    id: string; name: string; prefix: string; hash: string; profileId: string | null; poolId: string | null; budgetUsd: number | null; rpmLimit: number | null; allowedModels: string | null; createdAt: string; revokedAt: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    hash: r.hash,
    ...(r.profileId ? { profileId: r.profileId } : {}),
    ...(r.poolId ? { poolId: r.poolId } : {}),
    ...(r.budgetUsd !== null ? { budgetUsd: r.budgetUsd } : {}),
    ...(r.rpmLimit !== null ? { rpmLimit: r.rpmLimit } : {}),
    ...(r.allowedModels ? { allowedModels: JSON.parse(r.allowedModels) as string[] } : {}),
    createdAt: r.createdAt,
    ...(r.revokedAt ? { revokedAt: r.revokedAt } : {}),
  }));
}

export function verifyGovernanceKey(store: ControlPlaneStore, bearer: string): GovernanceKey | undefined {
  if (!bearer.startsWith("rly_")) return undefined;
  const hash = hashSecret(bearer);
  ensureKeysTable(store);
  const row = store.database.prepare("SELECT id, name, prefix, hash, profile_id as profileId, pool_id as poolId, budget_usd as budgetUsd, rpm_limit as rpmLimit, allowed_models as allowedModels, created_at as createdAt, revoked_at as revokedAt FROM governance_keys WHERE hash = ?").get(hash) as {
    id: string; name: string; prefix: string; hash: string; profileId: string | null; poolId: string | null; budgetUsd: number | null; rpmLimit: number | null; allowedModels: string | null; createdAt: string; revokedAt: string | null;
  } | undefined;
  if (row !== undefined && secureEqual(row.hash, hash)) {
    const r = row;
      if (r.revokedAt) return undefined;
      return {
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        hash: r.hash,
        ...(r.profileId ? { profileId: r.profileId } : {}),
        ...(r.poolId ? { poolId: r.poolId } : {}),
        ...(r.budgetUsd !== null ? { budgetUsd: r.budgetUsd } : {}),
        ...(r.rpmLimit !== null ? { rpmLimit: r.rpmLimit } : {}),
        ...(r.allowedModels ? { allowedModels: JSON.parse(r.allowedModels) as string[] } : {}),
        createdAt: r.createdAt,
        ...(r.revokedAt ? { revokedAt: r.revokedAt } : {}),
      };
    }
  return undefined;
}

export function revokeGovernanceKey(store: ControlPlaneStore, id: string): void {
  ensureKeysTable(store);
  const now = new Date().toISOString();
  store.database.prepare("UPDATE governance_keys SET revoked_at = ? WHERE id = ?").run(now, id);
}

export function checkBudget(store: ControlPlaneStore, key: GovernanceKey, costUsd: number): boolean {
  if (key.budgetUsd === undefined) return true;
  ensureKeysTable(store);
  const row = store.database.prepare("SELECT spent_usd as spent FROM key_usage WHERE key_id = ?").get(key.id) as { spent: number } | undefined;
  const spent = row?.spent ?? 0;
  return spent + costUsd <= key.budgetUsd;
}

// P0-4: ledger terminal cost should be recorded via this with actual costUsd (gateway onResponse will call with ledger cost)
export function recordKeyUsage(store: ControlPlaneStore, keyId: string, costUsd: number): void {
  ensureKeysTable(store);
  store.database.prepare("UPDATE key_usage SET spent_usd = spent_usd + ?, request_count = request_count + 1 WHERE key_id = ?").run(costUsd, keyId);
}

export function checkRpm(store: ControlPlaneStore, key: GovernanceKey): boolean {
  if (key.rpmLimit === undefined) return true;
  ensureKeysTable(store);
  const row = store.database.prepare("SELECT request_count as count, window_start as windowStart FROM key_usage WHERE key_id = ?").get(key.id) as { count: number; windowStart: string } | undefined;
  if (!row) return true;
  const windowStart = new Date(row.windowStart).getTime();
  const now = Date.now();
  if (now - windowStart > 60_000) {
    store.database.prepare("UPDATE key_usage SET request_count = 0, window_start = ? WHERE key_id = ?").run(new Date().toISOString(), key.id);
    return true;
  }
  return row.count < key.rpmLimit;
}
