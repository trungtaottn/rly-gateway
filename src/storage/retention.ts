import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ControlPlaneStore } from "../control-plane/store.js";
import { CredentialStore } from "../credentials/store.js";
import { ResponseContinuationStore } from "../protocols/openai-responses/continuation.js";
import { controlPlanePaths } from "./paths.js";
import {
  ensurePrivateDirectory,
  isNotFound,
  readPrivateTextIfPresent,
  removePrivateFileIfPresent,
  writePrivateTextAtomically,
} from "./private-files.js";

export const RETENTION_POLICY_VERSION = 1;

export type RetentionClassName = "logs" | "audit" | "continuation" | "backups" | "expiredCredentials" | "ledger";

export type RetentionClass = Readonly<{
  owner: string;
  maxAgeMs: number;
}>;

export type RetentionPolicy = Readonly<{
  version: number;
  classes: Readonly<Record<RetentionClassName, RetentionClass>>;
}>;

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  version: RETENTION_POLICY_VERSION,
  classes: {
    logs: { owner: "runtime", maxAgeMs: 7 * 24 * 60 * 60 * 1000 },
    audit: { owner: "control-plane", maxAgeMs: 30 * 24 * 60 * 60 * 1000 },
    continuation: { owner: "responses", maxAgeMs: 24 * 60 * 60 * 1000 },
    backups: { owner: "storage", maxAgeMs: 14 * 24 * 60 * 60 * 1000 },
    expiredCredentials: { owner: "credential-broker", maxAgeMs: 0 },
    ledger: { owner: "ledger", maxAgeMs: 90 * 24 * 60 * 60 * 1000 },
  },
};

export class RetentionPolicyError extends Error {
  override name = "RetentionPolicyError";
}

export type RetentionClassResult = Readonly<{
  className: RetentionClassName;
  deleted: number;
}>;

export type RetentionRun = Readonly<{
  policyVersion: number;
  applied: readonly RetentionClassResult[];
  resumed: boolean;
}>;

const CLASS_ORDER: readonly RetentionClassName[] = ["logs", "audit", "continuation", "backups", "expiredCredentials", "ledger"];

export function assertRetentionPolicy(policy: RetentionPolicy): void {
  if (policy.version < 1) throw new RetentionPolicyError("retention policy version is missing");
  for (const className of CLASS_ORDER) {
    const item = policy.classes[className];
    if (!item.owner || item.maxAgeMs < 0) {
      throw new RetentionPolicyError(`retention class ${className} lacks an owner or duration`);
    }
  }
}

type Marker = Readonly<{ remaining: RetentionClassName[]; policyVersion: number }>;

async function readMarker(path: string): Promise<Marker | undefined> {
  const raw = await readPrivateTextIfPresent(path);
  if (raw === undefined) return undefined;
  const parsed = JSON.parse(raw) as Marker;
  if (!Array.isArray(parsed.remaining)) return undefined;
  return parsed;
}

async function mtimeMs(path: string): Promise<number | undefined> {
  try {
    return (await lstat(path)).mtimeMs;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function deleteOlderFiles(directory: string, cutoffMs: number): Promise<number> {
  try {
    await ensurePrivateDirectory(directory);
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const modified = await mtimeMs(path);
    if (modified !== undefined && modified < cutoffMs) {
      await removePrivateFileIfPresent(path);
      deleted += 1;
    }
  }
  return deleted;
}

async function deleteOlderContinuations(directory: string, cutoffMs: number): Promise<number> {
  const store = new ResponseContinuationStore(directory);
  let deleted = 0;
  for (const id of await store.list()) {
    const record = await store.get(id);
    if (record && Date.parse(record.createdAt) < cutoffMs) {
      await store.remove(id);
      deleted += 1;
    }
  }
  return deleted;
}

async function deleteOlderAudit(directory: string, cutoffMs: number): Promise<number> {
  try {
    const store = await ControlPlaneStore.open(directory);
    try {
      return store.deleteAuditOlderThan(new Date(cutoffMs).toISOString());
    } finally {
      store.close();
    }
  } catch {
    return 0;
  }
}

async function deleteExpiredCredentials(directory: string, cutoffMs: number): Promise<number> {
  const credentials = await CredentialStore.open(directory);
  return deleteOlderFiles(credentials.paths().credentialQuarantine, cutoffMs);
}

async function deleteOlderLedger(directory: string, cutoffMs: number): Promise<number> {
  try {
    const { pruneLedger } = await import("../ledger/sqlite.js");
    const iso = new Date(cutoffMs).toISOString();
    return await pruneLedger(directory, iso);
  } catch { return 0; }
}

async function applyClass(
  directory: string,
  policy: RetentionPolicy,
  className: RetentionClassName,
  now: Date,
): Promise<number> {
  const cutoff = now.getTime() - policy.classes[className].maxAgeMs;
  const paths = controlPlanePaths(directory);
  switch (className) {
    case "logs":
      return deleteOlderFiles(paths.logs, cutoff);
    case "backups":
      return deleteOlderFiles(paths.backups, cutoff);
    case "continuation":
      return deleteOlderContinuations(directory, cutoff);
    case "audit":
      return deleteOlderAudit(directory, cutoff);
    case "expiredCredentials":
      return deleteExpiredCredentials(directory, cutoff);
    case "ledger":
      return deleteOlderLedger(directory, cutoff);
  }
}

/** Applies the versioned retention policy and resumes after an interrupted run. */
export async function applyRetentionPolicy(
  directory: string,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
  now = new Date(),
): Promise<RetentionRun> {
  assertRetentionPolicy(policy);
  const paths = controlPlanePaths(directory);
  await ensurePrivateDirectory(paths.directory);
  const existing = await readMarker(paths.retentionMarker);
  const remaining = existing?.remaining ?? [...CLASS_ORDER];
  const applied: RetentionClassResult[] = [];
  await writePrivateTextAtomically(paths.retentionMarker, `${JSON.stringify({ remaining, policyVersion: policy.version })}\n`);
  for (const [index, className] of remaining.entries()) {
    const deleted = await applyClass(directory, policy, className, now);
    applied.push({ className, deleted });
    const next = remaining.slice(index + 1);
    if (next.length === 0) await removePrivateFileIfPresent(paths.retentionMarker);
    else await writePrivateTextAtomically(paths.retentionMarker, `${JSON.stringify({ remaining: next, policyVersion: policy.version })}\n`);
  }
  return { policyVersion: policy.version, applied, resumed: existing !== undefined };
}
