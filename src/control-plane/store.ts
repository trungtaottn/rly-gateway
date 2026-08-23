import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openMigratedDatabase, type Migration } from "../storage/migrations.js";
import { CREDENTIAL_DIRECTORY } from "../storage/paths.js";
import { LOGICAL_TIERS } from "../routing/model-tiers/types.js";
import { ValidationError } from "./errors.js";
import type { HealthRecord, RouteOutcomeInput } from "./health/types.js";
import { ControlPlaneRepository } from "./repository.js";
import { parseJsonObject } from "./rows.js";
import type {
  AccountRecord,
  AuditEvent,
  Clock,
  CreateAccountInput,
  CreatePoolInput,
  CreateProfileInput,
  CreateProviderInput,
  ManagementActor,
  PolicyRevision,
  PoolRecord,
  ProfileRecord,
  ProviderRecord,
  BindCredentialInput,
  UpdateAccountInput,
  UpdatePoolInput,
  UpdateProfileInput,
  UpdateProviderInput,
} from "./types.js";

export { inspectSchemaColumns } from "./repository.js";

/**
 * Profile model-role keys: existing `primary`/`fast`/`reasoning` roles plus
 * logical tier overrides (#69) — a user may pin a tier target for the profile's
 * provider by adding e.g. `fable: "gpt-5.6-sol"`. Tier targets are validated
 * fail-closed at resolution through #68 exact-pin eligibility.
 */
const MODEL_ROLES = new Set<string>(["primary", "fast", "reasoning", ...LOGICAL_TIERS]);

export class ControlPlaneStore {
  private readonly repo: ControlPlaneRepository;

  private constructor(
    readonly directory: string,
    readonly database: DatabaseSync,
    readonly clock: Clock,
  ) {
    this.repo = new ControlPlaneRepository(database);
  }

  public static async open(
    directory: string,
    options: Readonly<{ clock?: Clock; migrations?: readonly Migration[] }> = {},
  ): Promise<ControlPlaneStore> {
    const database = await openMigratedDatabase(directory, options.migrations);
    return new ControlPlaneStore(directory, database, options.clock ?? (() => new Date()));
  }

  public close(): void {
    if (this.database.isOpen) this.database.close();
  }

  public listProviders(): ProviderRecord[] {
    return this.repo.listProviders();
  }

  public createProvider(input: CreateProviderInput, actor: ManagementActor): ProviderRecord {
    return this.mutate(actor, "provider.create", "provider", () => {
      const now = this.now();
      const record: ProviderRecord = {
        id: randomUUID(),
        name: requiredName(input.name),
        integrationMode: input.integrationMode,
        endpointPolicy: input.endpointPolicy,
        capabilityEvidence: input.capabilityEvidence,
        requiredTermsRevision: input.requiredTermsRevision,
        provenanceRef: input.provenanceRef,
        enabled: true,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.repo.insertProvider(record);
      return record;
    });
  }

  public updateProvider(id: string, version: number, input: UpdateProviderInput, actor: ManagementActor): ProviderRecord {
    return this.mutate(actor, "provider.update", "provider", () => {
      const current = this.repo.providerById(id);
      const next: ProviderRecord = {
        ...current,
        name: input.name === undefined ? current.name : requiredName(input.name),
        integrationMode: input.integrationMode ?? current.integrationMode,
        endpointPolicy: input.endpointPolicy ?? current.endpointPolicy,
        capabilityEvidence: input.capabilityEvidence ?? current.capabilityEvidence,
        requiredTermsRevision: input.requiredTermsRevision ?? current.requiredTermsRevision,
        provenanceRef: input.provenanceRef ?? current.provenanceRef,
        enabled: input.enabled ?? current.enabled,
        version: current.version + 1,
        updatedAt: this.now(),
      };
      this.repo.replaceProvider(current, next);
      return next;
    }, id, version);
  }

  public deleteProvider(id: string, version: number, actor: ManagementActor): { id: string } {
    return this.mutate(actor, "provider.delete", "provider", () => {
      this.repo.providerById(id);
      if (this.repo.listAccounts().some((account) => account.providerId === id)) {
        throw new ValidationError("provider still has accounts");
      }
      if (this.repo.listPools().some((pool) => pool.providerId === id)) {
        throw new ValidationError("provider still has pools");
      }
      if (this.repo.listProfiles().some((profile) => profile.providerId === id)) {
        throw new ValidationError("provider still has profiles");
      }
      this.repo.deleteProvider(id, version);
      return { id };
    }, id, version);
  }


  public listAccounts(): AccountRecord[] {
    return this.repo.listAccounts();
  }

  public getAccount(id: string): AccountRecord {
    return this.repo.accountById(id);
  }

  public bindCredential(id: string, version: number, input: BindCredentialInput, actor: ManagementActor): AccountRecord {
    return this.mutate(actor, "account.bind-credential", "account", () => {
      const current = this.repo.accountById(id);
      const next: AccountRecord = {
        ...current,
        credentialHandle: requiredName(input.credentialHandle),
        credentialGeneration: input.credentialGeneration,
        state: input.state,
        pauseReason: input.state === "paused" ? current.pauseReason : undefined,
        version: current.version + 1,
        updatedAt: this.now(),
      };
      if (next.credentialGeneration < 0) throw new ValidationError("credential generation must be >= 0");
      this.repo.replaceAccount(current, next);
      return next;
    }, id, version);
  }

  public createAccount(input: CreateAccountInput, actor: ManagementActor): AccountRecord {
    return this.mutate(actor, "account.create", "account", () => {
      this.repo.providerById(input.providerId);
      const now = this.now();
      const record: AccountRecord = {
        id: randomUUID(),
        pseudonym: requiredName(input.pseudonym),
        providerId: input.providerId,
        credentialHandle: requiredName(input.credentialHandle),
        credentialGeneration: 0,
        state: input.state ?? "unready",
        pauseReason: undefined,
        quotaClass: input.quotaClass ?? "unknown",
        cooldownUntil: undefined,
        termsRevision: undefined,
        termsAcknowledgedRevision: undefined,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.repo.insertAccount(record);
      this.repo.insertAccountHealth(record.id);
      return record;
    });
  }

  public updateAccount(id: string, version: number, input: UpdateAccountInput, actor: ManagementActor): AccountRecord {
    return this.mutate(actor, "account.update", "account", () => {
      const current = this.repo.accountById(id);
      const state = input.state ?? current.state;
      const next: AccountRecord = {
        ...current,
        state,
        pauseReason: state === "paused" ? (input.pauseReason ?? current.pauseReason) : undefined,
        quotaClass: input.quotaClass ?? current.quotaClass,
        version: current.version + 1,
        updatedAt: this.now(),
      };
      this.repo.replaceAccount(current, next);
      return next;
    }, id, version);
  }

  public deleteAccount(id: string, version: number, actor: ManagementActor): { id: string } {
    return this.mutate(actor, "account.delete", "account", () => {
      const current = this.repo.accountById(id);
      this.repo.deleteAccount(current);
      const stillUsed = this.repo.listAccounts().some((a) => a.credentialHandle === current.credentialHandle);
      if (!stillUsed) {
        try { unlinkSync(join(this.directory, CREDENTIAL_DIRECTORY, `${current.credentialHandle}.json`)); } catch { void 0; }
        try { unlinkSync(join(this.directory, CREDENTIAL_DIRECTORY, `${current.credentialHandle}.bak`)); } catch { void 0; }
      }
      return { id };
    }, id, version);
  }


  public acknowledgeTerms(id: string, version: number, termsRevision: string, actor: ManagementActor): AccountRecord {
    return this.mutate(actor, "account.acknowledge-terms", "account", () => {
      const current = this.repo.accountById(id);
      const provider = this.repo.providerById(current.providerId);
      const revision = requiredName(termsRevision);
      if (provider.requiredTermsRevision !== undefined && provider.requiredTermsRevision !== revision) {
        throw new ValidationError("terms revision does not match the provider requirement");
      }
      const now = this.now();
      this.repo.upsertTermsAcknowledgement(current.id, current.providerId, revision, now);
      const next: AccountRecord = {
        ...current,
        termsRevision: revision,
        termsAcknowledgedRevision: revision,
        version: current.version + 1,
        updatedAt: now,
      };
      this.repo.replaceAccount(current, next);
      return next;
    }, id, version);
  }

  public listPools(): PoolRecord[] {
    return this.repo.listPools();
  }

  public createPool(input: CreatePoolInput, actor: ManagementActor): PoolRecord {
    return this.mutate(actor, "pool.create", "pool", () => {
      const provider = this.repo.providerById(input.providerId);
      const now = this.now();
      const record: PoolRecord = {
        id: randomUUID(),
        name: requiredName(input.name),
        providerId: provider.id,
        strategy: input.strategy,
        affinity: input.affinity,
        retryBudget: input.retryBudget ?? 1,
        memberships: [],
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      if (record.retryBudget < 0) throw new ValidationError("retry budget must be >= 0");
      this.repo.insertPool(record);
      this.repo.replaceMemberships(record.id, record.providerId, input.accountIds ?? []);
      return this.repo.poolById(record.id);
    });
  }

  public updatePool(id: string, version: number, input: UpdatePoolInput, actor: ManagementActor): PoolRecord {
    return this.mutate(actor, "pool.update", "pool", () => {
      const current = this.repo.poolById(id);
      const retryBudget = input.retryBudget ?? current.retryBudget;
      if (retryBudget < 0) throw new ValidationError("retry budget must be >= 0");
      this.repo.replacePool(current, {
        name: input.name === undefined ? current.name : requiredName(input.name),
        strategy: input.strategy ?? current.strategy,
        affinity: input.affinity ?? current.affinity,
        retryBudget,
        version: current.version + 1,
        updatedAt: this.now(),
      });
      if (input.accountIds !== undefined) this.repo.replaceMemberships(current.id, current.providerId, input.accountIds);
      return this.repo.poolById(current.id);
    }, id, version);
  }

  public deletePool(id: string, version: number, actor: ManagementActor): { id: string } {
    return this.mutate(actor, "pool.delete", "pool", () => {
      const current = this.repo.poolById(id);
      if (this.repo.listProfiles().some((profile) => profile.poolId === id)) {
        throw new ValidationError("pool is referenced by profiles");
      }
      this.repo.deletePool(current);
      return { id };
    }, id, version);
  }


  public listProfiles(): ProfileRecord[] {
    return this.repo.listProfiles();
  }

  public createProfile(input: CreateProfileInput, actor: ManagementActor): ProfileRecord {
    return this.mutate(actor, "profile.create", "profile", () => {
      this.assertProfileRefs(input.providerId, input.poolId);
      const now = this.now();
      const record: ProfileRecord = {
        id: randomUUID(),
        name: requiredName(input.name),
        harness: input.harness,
        providerId: input.providerId,
        poolId: input.poolId,
        modelRoles: validateModelRoles(input.modelRoles),
        capabilityPolicy: input.capabilityPolicy,
        launchPolicy: input.launchPolicy,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.repo.insertProfile(record);
      return record;
    });
  }

  public updateProfile(id: string, version: number, input: UpdateProfileInput, actor: ManagementActor): ProfileRecord {
    return this.mutate(actor, "profile.update", "profile", () => {
      const current = this.repo.profileById(id);
      const providerId = input.providerId ?? current.providerId;
      const poolId = input.poolId ?? current.poolId;
      this.assertProfileRefs(providerId, poolId);
      const next: ProfileRecord = {
        ...current,
        name: input.name === undefined ? current.name : requiredName(input.name),
        harness: input.harness ?? current.harness,
        providerId,
        poolId,
        modelRoles: input.modelRoles === undefined ? current.modelRoles : validateModelRoles(input.modelRoles),
        capabilityPolicy: input.capabilityPolicy ?? current.capabilityPolicy,
        launchPolicy: input.launchPolicy ?? current.launchPolicy,
        version: current.version + 1,
        updatedAt: this.now(),
      };
      this.repo.replaceProfile(current, next);
      return next;
    }, id, version);
  }

  public currentPolicy(): PolicyRevision | undefined {
    return this.repo.currentPolicy();
  }

  public currentTime(): Date {
    return this.clock();
  }

  public getHealth(accountId: string): HealthRecord | undefined {
    return this.repo.healthById(accountId);
  }

  public listHealth(): HealthRecord[] {
    return this.repo.listHealth();
  }

  public recordRouteOutcome(
    accountId: string,
    input: RouteOutcomeInput,
    actor: ManagementActor = "system",
  ): AccountRecord {
    return this.mutate(actor, "route.outcome", "account", () => {
      const current = this.repo.accountById(accountId);
      const now = this.now();
      const health = this.repo.healthById(accountId) ?? {
        accountId,
        lastOutcome: undefined,
        lastOutcomeAt: undefined,
        consecutiveFailures: 0,
        cooldownUntil: undefined,
      };
      const success = input.outcome === "success";
      const cooldownUntil = input.cooldownUntil === undefined
        ? current.cooldownUntil
        : input.cooldownUntil ?? undefined;
      const next: AccountRecord = {
        ...current,
        quotaClass: input.quotaClass ?? current.quotaClass,
        cooldownUntil: success ? undefined : cooldownUntil,
        version: current.version + 1,
        updatedAt: now,
      };
      this.repo.replaceAccount(current, next);
      this.repo.replaceHealth({
        accountId,
        lastOutcome: input.outcome,
        lastOutcomeAt: now,
        consecutiveFailures: success ? 0 : health.consecutiveFailures + 1,
        cooldownUntil: success ? undefined : cooldownUntil,
      });
      return next;
    }, accountId, undefined, false);
  }

  public listAudit(limit = 50): AuditEvent[] {
    return this.repo.listAudit(limit);
  }

  public deleteAuditOlderThan(cutoffIso: string): number {
    return this.repo.deleteAuditOlderThan(cutoffIso);
  }

  public recordRejectedAudit(
    actor: ManagementActor,
    action: string,
    resourceType: string,
    resourceId: string | undefined,
    metadata: Readonly<Record<string, unknown>>,
  ): void {
    this.appendAudit(actor, action, resourceType, resourceId, "rejected", metadata);
  }

  private mutate<T extends { id?: string }>(
    actor: ManagementActor,
    action: string,
    resourceType: string,
    work: () => T,
    expectedId?: string,
    expectedVersion?: number,
    publishPolicy = true,
  ): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (expectedId !== undefined && expectedVersion !== undefined) {
        this.repo.assertCurrentVersion(resourceType, expectedId, expectedVersion);
      }
      const result = work();
      if (publishPolicy) this.compilePolicy();
      this.appendAudit(actor, action, resourceType, result.id ?? expectedId, "ok", { version: "version" in result ? result.version : undefined });
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      this.appendAudit(actor, action, resourceType, expectedId, "rejected", {
        code: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
  }

  private compilePolicy(): PolicyRevision {
    const snapshot = {
      providers: this.repo.listProviders(),
      accounts: this.repo.listAccounts(),
      pools: this.repo.listPools(),
      profiles: this.repo.listProfiles(),
    };
    const compiled = canonicalize(snapshot);
    const encoded = JSON.stringify(compiled);
    const hash = createHash("sha256").update(encoded).digest("hex");
    const revision = this.repo.nextPolicyRevision();
    const createdAt = this.now();
    try {
      this.repo.insertPolicyRevision(revision, encoded, hash, createdAt);
      return { revision, hash, createdAt, snapshot };
    } catch (error) {
      const text = error instanceof Error ? error.message : "";
      if (!text.includes("policy_revisions.hash") || !text.includes("UNIQUE")) throw error;
      const distinguished = createHash("sha256").update(`${encoded}\n${String(revision)}`).digest("hex");
      this.repo.insertPolicyRevision(revision, encoded, distinguished, createdAt);
      return { revision, hash: distinguished, createdAt, snapshot };
    }
  }

  private assertProfileRefs(providerId: string | undefined, poolId: string | undefined): void {
    if (providerId === undefined && poolId === undefined) throw new ValidationError("profile requires a provider or pool");
    if (providerId !== undefined) this.repo.providerById(providerId);
    if (poolId !== undefined) this.repo.poolById(poolId);
    if (providerId !== undefined && poolId !== undefined) {
      const pool = this.repo.poolById(poolId);
      if (pool.providerId !== providerId) throw new ValidationError("profile pool must belong to the selected provider");
    }
  }

  private appendAudit(
    actor: ManagementActor,
    action: string,
    resourceType: string,
    resourceId: string | undefined,
    result: "ok" | "rejected",
    metadata: Readonly<Record<string, unknown>>,
  ): void {
    this.repo.appendAudit(
      actor,
      action,
      resourceType,
      resourceId,
      result,
      JSON.stringify(canonicalize(metadata)),
      this.now(),
    );
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function requiredName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ValidationError("name is required");
  return trimmed;
}

function validateModelRoles(roles: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const parsed = parseJsonObject(JSON.stringify(roles));
  for (const key of Object.keys(parsed)) {
    if (!MODEL_ROLES.has(key)) throw new ValidationError("profile model roles must be primary, fast, reasoning, or a logical tier (haiku/sonnet/opus/fable)");
  }
  if (Object.keys(parsed).length === 0) throw new ValidationError("profile requires at least one model role");
  return parsed;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}
