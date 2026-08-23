import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { NotFoundError, UniquenessError, ValidationError, VersionConflictError } from "./errors.js";
import type { HealthRecord } from "./health/types.js";
import {
  encodeJson,
  mapAccount,
  mapAudit,
  mapHealth,
  mapMembership,
  mapPool,
  mapProfile,
  mapProvider,
  type SqlRow,
} from "./rows.js";
import type {
  AccountRecord,
  AuditEvent,
  ManagementActor,
  PolicyRevision,
  PoolRecord,
  ProfileRecord,
  ProviderRecord,
} from "./types.js";

export class ControlPlaneRepository {
  private readonly statementCache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  public constructor(readonly database: DatabaseSync) {}

  private prepare(sql: string): ReturnType<DatabaseSync["prepare"]> {
    const cached = this.statementCache.get(sql);
    if (cached) return cached;
    const stmt = this.database.prepare(sql);
    this.statementCache.set(sql, stmt);
    return stmt;
  }

  public listProviders(): ProviderRecord[] {
    return this.prepare("SELECT * FROM providers ORDER BY name").all().map((row) => mapProvider(row as SqlRow));
  }

  public providerById(id: string): ProviderRecord {
    const row = this.prepare("SELECT * FROM providers WHERE id = ?").get(id) as SqlRow | undefined;
    if (!row) throw new NotFoundError("provider");
    return mapProvider(row);
  }

  public insertProvider(record: ProviderRecord): void {
    try {
      this.prepare(
        "INSERT INTO providers (id, name, integration_mode, endpoint_policy, capability_evidence, required_terms_revision, provenance_ref, enabled, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        record.id, record.name, record.integrationMode, record.endpointPolicy ?? null, encodeJson(record.capabilityEvidence),
        record.requiredTermsRevision ?? null, record.provenanceRef ?? null, record.enabled ? 1 : 0, record.version,
        record.createdAt, record.updatedAt,
      );
    } catch (error) {
      rethrowConstraint(error, "provider name already exists");
    }
  }

  public replaceProvider(current: ProviderRecord, next: ProviderRecord): void {
    try {
      const result = this.prepare(
        "UPDATE providers SET name = ?, integration_mode = ?, endpoint_policy = ?, capability_evidence = ?, required_terms_revision = ?, provenance_ref = ?, enabled = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?",
      ).run(
        next.name, next.integrationMode, next.endpointPolicy ?? null, encodeJson(next.capabilityEvidence),
        next.requiredTermsRevision ?? null, next.provenanceRef ?? null, next.enabled ? 1 : 0, next.version, next.updatedAt,
        current.id, current.version,
      );
      if (result.changes === 0) throw new VersionConflictError("provider");
    } catch (error) {
      rethrowConstraint(error, "provider name already exists");
    }
  }

  public deleteProvider(id: string, version: number): void {
    const result = this.prepare("DELETE FROM providers WHERE id = ? AND version = ?").run(id, version);
    if (result.changes === 0) throw new VersionConflictError("provider");
  }


  public listAccounts(): AccountRecord[] {
    return this.prepare("SELECT * FROM accounts ORDER BY pseudonym").all().map((row) => mapAccount(row as SqlRow));
  }

  public accountById(id: string): AccountRecord {
    const row = this.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as SqlRow | undefined;
    if (!row) throw new NotFoundError("account");
    return mapAccount(row);
  }

  public insertAccount(record: AccountRecord): void {
    try {
      this.prepare(
        "INSERT INTO accounts (id, pseudonym, provider_id, credential_handle, credential_generation, state, pause_reason, quota_class, cooldown_until, terms_revision, terms_acknowledged_revision, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        record.id, record.pseudonym, record.providerId, record.credentialHandle, record.credentialGeneration, record.state,
        record.pauseReason ?? null, record.quotaClass, record.cooldownUntil ?? null, record.termsRevision ?? null,
        record.termsAcknowledgedRevision ?? null, record.version, record.createdAt, record.updatedAt,
      );
    } catch (error) {
      rethrowConstraint(error, "account already exists for this provider");
    }
  }

  public replaceAccount(current: AccountRecord, next: AccountRecord): void {
    const result = this.prepare(
      "UPDATE accounts SET credential_handle = ?, credential_generation = ?, state = ?, pause_reason = ?, quota_class = ?, cooldown_until = ?, terms_revision = ?, terms_acknowledged_revision = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?",
    ).run(
      next.credentialHandle, next.credentialGeneration, next.state, next.pauseReason ?? null, next.quotaClass,
      next.cooldownUntil ?? null, next.termsRevision ?? null, next.termsAcknowledgedRevision ?? null, next.version,
      next.updatedAt, current.id, current.version,
    );
    if (result.changes === 0) throw new VersionConflictError("account");
  }

  public deleteAccount(current: AccountRecord): void {
    this.prepare("DELETE FROM memberships WHERE account_id = ?").run(current.id);
    this.prepare("DELETE FROM health WHERE account_id = ?").run(current.id);
    this.prepare("DELETE FROM terms_acknowledgements WHERE account_id = ?").run(current.id);
    this.prepare("DELETE FROM pool_health WHERE account_id = ?").run(current.id);
    const result = this.prepare("DELETE FROM accounts WHERE id = ? AND version = ?").run(current.id, current.version);
    if (result.changes === 0) throw new VersionConflictError("account");
  }


  public insertAccountHealth(accountId: string): void {
    this.prepare(
      "INSERT INTO health (account_id, last_outcome, last_outcome_at, consecutive_failures, cooldown_until) VALUES (?, NULL, NULL, 0, NULL)",
    ).run(accountId);
  }

  public healthById(accountId: string): HealthRecord | undefined {
    const row = this.prepare("SELECT * FROM health WHERE account_id = ?").get(accountId) as SqlRow | undefined;
    return row === undefined ? undefined : mapHealth(row);
  }

  public listHealth(): HealthRecord[] {
    return this.prepare("SELECT * FROM health").all().map((row) => mapHealth(row as SqlRow));
  }

  public replaceHealth(record: HealthRecord): void {
    this.prepare(
      "INSERT INTO health (account_id, last_outcome, last_outcome_at, consecutive_failures, cooldown_until) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET last_outcome = excluded.last_outcome, last_outcome_at = excluded.last_outcome_at, consecutive_failures = excluded.consecutive_failures, cooldown_until = excluded.cooldown_until",
    ).run(
      record.accountId,
      record.lastOutcome ?? null,
      record.lastOutcomeAt ?? null,
      record.consecutiveFailures,
      record.cooldownUntil ?? null,
    );
  }

  public upsertTermsAcknowledgement(accountId: string, providerId: string, revision: string, acknowledgedAt: string): void {
    this.prepare(
      "INSERT OR REPLACE INTO terms_acknowledgements (account_id, provider_id, terms_revision, acknowledged_at) VALUES (?, ?, ?, ?)",
    ).run(accountId, providerId, revision, acknowledgedAt);
  }

  public listPools(): PoolRecord[] {
    return this.prepare("SELECT * FROM pools ORDER BY name").all().map((row) => this.hydratePool(row as SqlRow));
  }

  public poolById(id: string): PoolRecord {
    const row = this.prepare("SELECT * FROM pools WHERE id = ?").get(id) as SqlRow | undefined;
    if (!row) throw new NotFoundError("pool");
    return this.hydratePool(row);
  }

  public insertPool(record: PoolRecord): void {
    try {
      this.prepare(
        "INSERT INTO pools (id, name, provider_id, strategy, affinity, retry_budget, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(record.id, record.name, record.providerId, record.strategy, encodeJson(record.affinity), record.retryBudget, record.version, record.createdAt, record.updatedAt);
    } catch (error) {
      rethrowConstraint(error, "pool name already exists");
    }
  }

  public replacePool(
    current: PoolRecord,
    next: Readonly<{
      name: string;
      strategy: PoolRecord["strategy"];
      affinity: unknown;
      retryBudget: number;
      version: number;
      updatedAt: string;
    }>,
  ): void {
    try {
      const result = this.prepare(
        "UPDATE pools SET name = ?, strategy = ?, affinity = ?, retry_budget = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?",
      ).run(
        next.name,
        next.strategy,
        encodeJson(next.affinity),
        next.retryBudget,
        next.version,
        next.updatedAt,
        current.id,
        current.version,
      );
      if (result.changes === 0) throw new VersionConflictError("pool");
    } catch (error) {
      rethrowConstraint(error, "pool name already exists");
    }
  }

  public deletePool(current: PoolRecord): void {
    this.prepare("DELETE FROM memberships WHERE pool_id = ?").run(current.id);
    const result = this.prepare("DELETE FROM pools WHERE id = ? AND version = ?").run(current.id, current.version);
    if (result.changes === 0) throw new VersionConflictError("pool");
  }


  public replaceMemberships(poolId: string, providerId: string, accountIds: readonly string[]): void {
    const unique = new Set(accountIds);
    if (unique.size !== accountIds.length) throw new UniquenessError("pool memberships must be unique");
    this.prepare("DELETE FROM memberships WHERE pool_id = ?").run(poolId);
    accountIds.forEach((accountId, index) => {
      const account = this.accountById(accountId);
      if (account.providerId !== providerId) throw new ValidationError("pool memberships must share the pool provider");
      this.prepare("INSERT INTO memberships (pool_id, account_id, pin_order) VALUES (?, ?, ?)").run(poolId, accountId, index);
    });
  }

  public listProfiles(): ProfileRecord[] {
    return this.prepare("SELECT * FROM profiles ORDER BY name").all().map((row) => mapProfile(row as SqlRow));
  }

  public profileById(id: string): ProfileRecord {
    const row = this.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as SqlRow | undefined;
    if (!row) throw new NotFoundError("profile");
    return mapProfile(row);
  }

  public insertProfile(record: ProfileRecord): void {
    try {
      this.prepare(
        "INSERT INTO profiles (id, name, harness, provider_id, pool_id, model_roles, capability_policy, launch_policy, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        record.id, record.name, record.harness, record.providerId ?? null, record.poolId ?? null,
        JSON.stringify(record.modelRoles), encodeJson(record.capabilityPolicy), encodeJson(record.launchPolicy),
        record.version, record.createdAt, record.updatedAt,
      );
    } catch (error) {
      rethrowConstraint(error, "profile name already exists");
    }
  }

  public replaceProfile(current: ProfileRecord, next: ProfileRecord): void {
    try {
      const result = this.prepare(
        "UPDATE profiles SET name = ?, harness = ?, provider_id = ?, pool_id = ?, model_roles = ?, capability_policy = ?, launch_policy = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?",
      ).run(
        next.name, next.harness, next.providerId ?? null, next.poolId ?? null, JSON.stringify(next.modelRoles),
        encodeJson(next.capabilityPolicy), encodeJson(next.launchPolicy), next.version, next.updatedAt, current.id, current.version,
      );
      if (result.changes === 0) throw new VersionConflictError("profile");
    } catch (error) {
      rethrowConstraint(error, "profile name already exists");
    }
  }

  public currentPolicy(): PolicyRevision | undefined {
    const row = this.prepare("SELECT * FROM policy_revisions ORDER BY revision DESC LIMIT 1").get() as SqlRow | undefined;
    return row === undefined ? undefined : mapPolicy(row);
  }

  public nextPolicyRevision(): number {
    const current = this.prepare("SELECT MAX(revision) AS revision FROM policy_revisions").get() as
      | { revision: number | null }
      | undefined;
    return (current?.revision ?? 0) + 1;
  }

  public insertPolicyRevision(revision: number, encoded: string, hash: string, createdAt: string): void {
    this.prepare(
      "INSERT INTO policy_revisions (revision, compiled_json, hash, created_at) VALUES (?, ?, ?, ?)",
    ).run(revision, encoded, hash, createdAt);
  }

  public listAudit(limit = 50): AuditEvent[] {
    return this.prepare("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?").all(limit).map((row) => mapAudit(row as SqlRow));
  }

  public deleteAuditOlderThan(cutoffIso: string): number {
    const result = this.prepare("DELETE FROM audit_events WHERE created_at < ?").run(cutoffIso);
    return Number(result.changes);
  }

  public appendAudit(
    actor: ManagementActor,
    action: string,
    resourceType: string,
    resourceId: string | undefined,
    result: "ok" | "rejected",
    metadataJson: string,
    createdAt: string,
  ): void {
    this.prepare(
      "INSERT INTO audit_events (id, action, resource_type, resource_id, actor, result, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(randomUUID(), action, resourceType, resourceId ?? null, actor, result, metadataJson, createdAt);
  }

  public assertCurrentVersion(resourceType: string, id: string, version: number): void {
    const table = resourceTable(resourceType);
    const row = this.prepare(`SELECT version FROM ${table} WHERE id = ?`).get(id) as { version: number } | undefined;
    if (!row) throw new NotFoundError(resourceType);
    if (row.version !== version) throw new VersionConflictError(resourceType);
  }

  private hydratePool(row: SqlRow): PoolRecord {
    const memberships = this.prepare("SELECT * FROM memberships WHERE pool_id = ? ORDER BY pin_order").all(String(row["id"]))
      .map((item) => mapMembership(item as SqlRow));
    return mapPool(row, memberships);
  }
}

export function inspectSchemaColumns(database: DatabaseSync): string[] {
  const tables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ name: string }>;
  const columns: string[] = [];
  for (const table of tables) {
    const info = database.prepare(`PRAGMA table_info(${table.name})`).all() as Array<{ name: string }>;
    columns.push(...info.map((column) => column.name));
  }
  return columns;
}

function mapPolicy(row: SqlRow): PolicyRevision {
  const snapshot = JSON.parse(String(row["compiled_json"])) as PolicyRevision["snapshot"];
  return {
    revision: Number(row["revision"]),
    hash: String(row["hash"]),
    createdAt: String(row["created_at"]),
    snapshot,
  };
}

function resourceTable(resourceType: string): "providers" | "accounts" | "pools" | "profiles" {
  if (resourceType === "provider") return "providers";
  if (resourceType === "account") return "accounts";
  if (resourceType === "pool") return "pools";
  if (resourceType === "profile") return "profiles";
  throw new ValidationError("unknown resource type");
}

function rethrowConstraint(error: unknown, message: string): never {
  if (error instanceof VersionConflictError || error instanceof ValidationError || error instanceof NotFoundError || error instanceof UniquenessError) throw error;
  const text = error instanceof Error ? error.message : "";
  if (text.includes("UNIQUE") || text.includes("unique")) throw new UniquenessError(message);
  throw error;
}