import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { z } from "zod";
import { ValidationError } from "../control-plane/errors.js";
import { ensurePrivateDirectory } from "../storage/private-files.js";
import { estimateCost, snapshotIdFor } from "./price-registry.js";

const ledgerGroupBySchema = z.enum(["model", "provider"]);
const ledgerQuerySchema = z.object({
  since: z.string().min(1).optional(),
  groupBy: ledgerGroupBySchema.optional(),
});

export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

export type LedgerRow = Readonly<{
  eventId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  priceSnapshotId: string;
  occurredAt: string;
}>;

export type LedgerGroup = Readonly<{
  provider: string;
  model: string;
  totalCost: number;
  count: number;
  inputTokens: number;
  outputTokens: number;
}>;

let ledgerDb: DatabaseSync | undefined;
let ledgerDirectory: string | undefined;
const pending: LedgerRow[] = [];
let flushing = false;

function ledgerPath(directory: string): string {
  return join(directory, "ledger.sqlite");
}

function openDatabase(directory: string): DatabaseSync {
  if (ledgerDb !== undefined && ledgerDirectory === directory && ledgerDb.isOpen) return ledgerDb;
  if (ledgerDb !== undefined) {
    try { ledgerDb.close(); } catch { void 0; }
    ledgerDb = undefined;
  }
  // Ensure private dir 0700 parity with control-plane store
  // Caller ensures directory via ensurePrivateDirectory; we do best-effort sync open.
  const db = new DatabaseSync(ledgerPath(directory));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      event_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      price_snapshot_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_ledger_occurred_at ON ledger_entries(occurred_at);
  `);
  ledgerDb = db;
  ledgerDirectory = directory;
  return db;
}

export async function openLedger(directory: string): Promise<DatabaseSync> {
  await ensurePrivateDirectory(directory);
  return openDatabase(directory);
}

function flush(directory: string): void {
  if (pending.length === 0 || flushing) return;
  flushing = true;
  const rows = pending.splice(0, pending.length);
  try {
    const db = openDatabase(directory);
    const stmt = db.prepare(
      `INSERT INTO ledger_entries(event_id, provider, model, input_tokens, output_tokens, cost_usd, price_snapshot_id, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cost_usd = excluded.cost_usd,
         price_snapshot_id = excluded.price_snapshot_id`,
    );
    for (const row of rows) {
      assertSecretFreeRow(row);
      stmt.run(row.eventId, row.provider, row.model, row.inputTokens, row.outputTokens, row.costUsd, row.priceSnapshotId, row.occurredAt);
    }
  } finally {
    flushing = false;
    if (pending.length > 0) flush(directory);
  }
}

function assertSecretFreeRow(row: LedgerRow): void {
  const blob = JSON.stringify(row);
  if (/\bBearer\b|\bsk-/.test(blob)) throw new Error("ledger row must be secret-free");
}

export type AppendInput = Readonly<{
  eventId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  occurredAt?: string;
  priceSnapshotId?: string;
}>;

export async function appendEntry(directory: string, input: AppendInput): Promise<void> {
  await ensurePrivateDirectory(directory);
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const snapshot = input.priceSnapshotId ?? snapshotIdFor(`${input.provider}/${input.model}`, new Date(occurredAt), directory);
  const cost = input.provider && input.model ? estimateCost({ model: `${input.provider}/${input.model}`, inputTokens: input.inputTokens, outputTokens: input.outputTokens, at: new Date(occurredAt), directory }) : 0;
  const row: LedgerRow = {
    eventId: input.eventId,
    provider: input.provider,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    costUsd: cost,
    priceSnapshotId: snapshot,
    occurredAt,
  };
  pending.push(row);
  flush(directory);
}

/** Synchronous variant for tests and terminal UPSERT without async queue delay. */
export function appendEntrySync(directory: string, input: AppendInput): void {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const snapshot = input.priceSnapshotId ?? snapshotIdFor(`${input.provider}/${input.model}`, new Date(occurredAt), directory);
  const cost = estimateCost({ model: `${input.provider}/${input.model}`, inputTokens: input.inputTokens, outputTokens: input.outputTokens, at: new Date(occurredAt), directory });
  const db = openDatabase(directory);
  const stmt = db.prepare(
    `INSERT INTO ledger_entries(event_id, provider, model, input_tokens, output_tokens, cost_usd, price_snapshot_id, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       cost_usd = excluded.cost_usd,
       price_snapshot_id = excluded.price_snapshot_id`,
  );
  assertSecretFreeRow({ eventId: input.eventId, provider: input.provider, model: input.model, inputTokens: input.inputTokens, outputTokens: input.outputTokens, costUsd: cost, priceSnapshotId: snapshot, occurredAt });
  stmt.run(input.eventId, input.provider, input.model, input.inputTokens, input.outputTokens, cost, snapshot, occurredAt);
}

export async function queryLedger(directory: string, query: LedgerQuery = {}): Promise<readonly LedgerGroup[]> {
  const parsed = ledgerQuerySchema.safeParse(query);
  if (!parsed.success) throw new ValidationError("invalid ledger groupBy");
  await ensurePrivateDirectory(directory);
  const db = openDatabase(directory);
  const since = parsed.data.since;
  const where = since ? "WHERE occurred_at >= ?" : "";
  const params: string[] = since ? [since] : [];
  const groupBy = parsed.data.groupBy;
  if (groupBy === "provider") {
    const stmt = db.prepare(`SELECT provider, model, SUM(cost_usd) as totalCost, COUNT(*) as count, SUM(input_tokens) as inputTokens, SUM(output_tokens) as outputTokens FROM ledger_entries ${where} GROUP BY provider`);
    return stmt.all(...params) as LedgerGroup[];
  }
  const stmt = db.prepare(`SELECT provider, model, SUM(cost_usd) as totalCost, COUNT(*) as count, SUM(input_tokens) as inputTokens, SUM(output_tokens) as outputTokens FROM ledger_entries ${where} GROUP BY provider, model`);
  return stmt.all(...params) as LedgerGroup[];
}

export async function pruneLedger(directory: string, before: string): Promise<number> {
  await ensurePrivateDirectory(directory);
  const db = openDatabase(directory);
  const stmt = db.prepare("DELETE FROM ledger_entries WHERE occurred_at < ?");
  const result = stmt.run(before);
  return result.changes as number;
}

export function closeLedger(): void {
  if (ledgerDb !== undefined) {
    try { ledgerDb.close(); } catch { void 0; }
    ledgerDb = undefined;
    ledgerDirectory = undefined;
  }
}
