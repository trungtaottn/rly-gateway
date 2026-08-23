import type { ControlPlaneStore } from "../../control-plane/store.js";
import { isAbortError } from "./retry.js";

export const ADAPTIVE_ALPHA = 0.3;
export const ADAPTIVE_MIN_SAMPLES = 5;
export const ADAPTIVE_MAX_LATENCY_MS = 5000;
export const ADAPTIVE_RATE_LIMIT_MS = 5000;

export type AdaptiveHealth = Readonly<{
  accountId: string;
  ewma: number;
  errors: number;
  total: number;
  updatedAt: string;
}>;

function quotaPenalty(quotaClass: string | undefined): number {
  switch (quotaClass) {
    case "healthy": return 0;
    case "warning": return 10;
    case "unknown": return 20;
    case "exhausted": return 100;
    default: return 20;
  }
}

export function winsorizeLatency(latencyMs: number): number {
  return Math.min(latencyMs, ADAPTIVE_MAX_LATENCY_MS);
}

export function computeScore(health: AdaptiveHealth | undefined, quotaClass: string | undefined): number {
  if (!health || health.total < ADAPTIVE_MIN_SAMPLES) return quotaPenalty(quotaClass);
  const errorRate = health.total === 0 ? 0 : health.errors / health.total;
  return health.ewma * 0.6 + errorRate * 40 + quotaPenalty(quotaClass);
}

export function shouldUseAdaptive(candidates: readonly { accountId: string }[], healthMap: ReadonlyMap<string, AdaptiveHealth>): boolean {
  // Use adaptive only when at least one candidate has enough samples
  for (const c of candidates) {
    const h = healthMap.get(c.accountId);
    if (h && h.total >= ADAPTIVE_MIN_SAMPLES) return true;
  }
  return false;
}

export function ensureAdaptiveTable(store: ControlPlaneStore): void {
  store.database.exec(`
    CREATE TABLE IF NOT EXISTS pool_health (
      account_id TEXT PRIMARY KEY,
      ewma REAL NOT NULL,
      errors INTEGER NOT NULL,
      total INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
}

export function getAdaptiveHealth(store: ControlPlaneStore, accountId: string): AdaptiveHealth | undefined {
  ensureAdaptiveTable(store);
  const row = store.database.prepare("SELECT account_id as accountId, ewma, errors, total, updated_at as updatedAt FROM pool_health WHERE account_id = ?").get(accountId) as AdaptiveHealth | undefined;
  return row;
}

export function getAdaptiveHealthMap(store: ControlPlaneStore, accountIds: readonly string[]): ReadonlyMap<string, AdaptiveHealth> {
  ensureAdaptiveTable(store);
  const map = new Map<string, AdaptiveHealth>();
  for (const id of accountIds) {
    const h = getAdaptiveHealth(store, id);
    if (h) map.set(id, h);
  }
  return map;
}

const lastWriteAt = new Map<string, number>();

export function updateAdaptiveHealth(
  store: ControlPlaneStore,
  accountId: string,
  latencyMs: number,
  success: boolean,
  now: Date = new Date(),
  error?: unknown,
): void {
  if (error !== undefined && isAbortError(error)) return;
  const nowMs = now.getTime();
  if (success) {
    const last = lastWriteAt.get(accountId) ?? 0;
    if (nowMs - last < ADAPTIVE_RATE_LIMIT_MS) return;
    lastWriteAt.set(accountId, nowMs);
  }

  ensureAdaptiveTable(store);
  const current = getAdaptiveHealth(store, accountId);
  const latency = winsorizeLatency(latencyMs);
  const nextEwma = current ? current.ewma * (1 - ADAPTIVE_ALPHA) + latency * ADAPTIVE_ALPHA : latency;
  const nextTotal = (current?.total ?? 0) + 1;
  const nextErrors = (current?.errors ?? 0) + (success ? 0 : 1);
  const updatedAt = now.toISOString();

  // Atomic UPSERT
  store.database.prepare(`
    INSERT INTO pool_health(account_id, ewma, errors, total, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET ewma=excluded.ewma, errors=excluded.errors, total=excluded.total, updated_at=excluded.updated_at
  `).run(accountId, nextEwma, nextErrors, nextTotal, updatedAt);
}

export function resetRateLimit(): void {
  lastWriteAt.clear();
}
