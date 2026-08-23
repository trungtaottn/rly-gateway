/**
 * Deterministic model projection engine (#72, ECR authority by #124).
 *
 * Pure, secret-free, no account/credential access:
 * - `projectModelUniverse` projects the trusted registry through a session's
 *   pinned provider->pool bindings into Claude-compatible entries.
 * - `resolveProjection` is the explicit reverse mapping (projection id ->
 *   exact access-provider/model target + pool). Routing never parses ids.
 * - `compileModelUniverseSnapshot` pins a session's model universe from the
 *   control-plane policy at launch-session issue time.
 *
 * #124: when an Effective Compatibility Registry snapshot is supplied it is
 * the projection compatibility AUTHORITY: paths lacking effective trusted
 * claims for the required Claude/Codex features are excluded by default;
 * quarantine excludes even with the explicit opt-in; the static
 * `model.compatibility.state` becomes seed/reference data only.
 */

import { createHash } from "node:crypto";
import type { PolicyRevision, ProfileRecord } from "../../control-plane/types.js";
import {
  findModelEvidence,
  modelsForProvider,
  type ModelEvidence,
  type RegistryDocument,
} from "../../registry/model-registry.js";
import { requiredFeaturesForEvidence } from "../../compatibility/features.js";
import type { ClaimFeature } from "../../canary/claim.js";
import type { EffectiveCompatibility } from "../../compatibility/types.js";
import {
  isProjectionId,
  RLY_MODEL_PREFIX,
  type ModelProjection,
  type ModelProjectionTrace,
  type ModelUniverseSnapshot,
  type ProviderPoolBinding,
} from "./types.js";

/** #124: ECR snapshot keyed by registry logicalId → per-feature answers. */
export type EffectiveProjectionSnapshot = ReadonlyMap<string, ReadonlyMap<ClaimFeature, EffectiveCompatibility>>;

/**
 * Presentation-only provider labels. Never used for routing; two providers
 * exposing the same upstream model get distinct display labels because
 * auth/pool/endpoint/terms are different execution paths.
 */
const PROVIDER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  codex: "Codex",
  cline: "ClinePass",
  gemini: "Gemini",
  antigravity: "Antigravity",
  claude: "Claude",
  "opencode-go": "OpenCode Go",
  alibaba: "Alibaba",
});

/**
 * Presentation-only model labels for the reviewed registry entries. Pure
 * cosmetic: an unknown model falls back to `humanizeModelId`. Never used for
 * routing; the reverse mapping owns routing.
 */
const MODEL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.4": "GPT-5.4",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-fable": "Claude Fable",
  "nvidia/nemotron-3.5-lightning:free": "NVIDIA Nemotron 3.5 Lightning (Free)",
  "nvidia/nemotron-nano-12b-v2-vl:free": "NVIDIA Nemotron Nano 12B V2 VL (Free)",
  "openai/gpt-oss-20b:free": "OpenAI GPT-OSS 20B (Free)",
  "deepseek/deepseek-v4-flash-0731": "DeepSeek V4 Flash 0731",
});

const ACRONYMS = new Set(["gpt", "api", "ai", "cli", "ui", "json", "oss", "vl", "id"]);

/** Deterministic, presentation-only fallback humanizer for unknown model ids. */
export function humanizeModelId(upstreamModelId: string): string {
  const tokens = upstreamModelId.split(/[-_/:]+/).filter((token) => token.length > 0);
  return tokens.map((token) => {
    if (/^\d/.test(token)) return token;
    const lower = token.toLowerCase();
    if (ACRONYMS.has(lower)) return lower.toUpperCase();
    return token.charAt(0).toUpperCase() + token.slice(1);
  }).join(" ");
}

/** Deterministic presentation label for a provider name. Never a routing key. */
export function providerDisplayName(providerName: string): string {
  return PROVIDER_LABELS[providerName] ?? humanizeModelId(providerName);
}

/** Deterministic presentation label for one exact upstream model id. */
export function modelDisplayName(upstreamModelId: string): string {
  return MODEL_LABELS[upstreamModelId] ?? humanizeModelId(upstreamModelId);
}

/**
 * Stable projection id: `claude-rly-<provider-slug>-<stable-key>`. The slug
 * keeps the provider family visible to the user; the stable key is a short
 * hash of `(providerName, upstreamModelId)` so the same upstream model through
 * two access providers always gets two distinct ids. Ids are handles only —
 * `resolveProjection` owns the reverse mapping.
 */
export function projectionIdFor(providerName: string, upstreamModelId: string): string {
  const slug = providerSlug(providerName);
  const stableKey = createHash("sha256")
    .update(`${providerName}\u0000${upstreamModelId}`)
    .digest("hex")
    .slice(0, 12);
  return `${RLY_MODEL_PREFIX}${slug}-${stableKey}`;
}

function providerSlug(providerName: string): string {
  const slug = providerName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length === 0 ? "provider" : slug;
}

/** One projected entry for an exact binding + trusted evidence. */
export function projectionFor(
  binding: ProviderPoolBinding,
  evidence: ModelEvidence,
  effective?: ReadonlyMap<ClaimFeature, EffectiveCompatibility>,
): ModelProjection {
  const label = effective === undefined ? undefined : worstEffectiveLabel(effective);
  return Object.freeze({
    id: projectionIdFor(binding.providerName, evidence.identity.upstreamModelId),
    displayName: `${modelDisplayName(evidence.identity.upstreamModelId)} (${providerDisplayName(binding.providerName)})`,
    providerId: binding.providerId,
    providerName: binding.providerName,
    poolId: binding.poolId,
    upstreamModelId: evidence.identity.upstreamModelId,
    ...(evidence.identity.modelFamily === undefined ? {} : { modelFamily: evidence.identity.modelFamily }),
    compatibilityState: evidence.compatibility.state,
    ...(label === undefined ? {} : { effectiveLabel: label }),
    verifiedAt: evidence.verifiedAt,
    ...(typeof evidence.limits.contextWindow === "number" ? { contextWindow: evidence.limits.contextWindow } : {}),
    ...(typeof evidence.limits.maxOutput === "number" ? { maxOutput: evidence.limits.maxOutput } : {}),
  });
}

/** Worst effective label across the required RLY features (projection gate). */
export function worstEffectiveLabel(effective: ReadonlyMap<ClaimFeature, EffectiveCompatibility>): string {
  const rank: Readonly<Record<string, number>> = Object.freeze({
    trusted: 0, experimental: 1, stale: 2, untrusted: 3, missing: 4, quarantined: 5,
  });
  let worst: string = "missing";
  for (const result of effective.values()) {
    const candidate = result.effective;
    if ((rank[candidate] ?? 9) > (rank[worst] ?? 9)) worst = candidate;
  }
  return worst;
}

/**
 * Projects the trusted registry through a session's pinned bindings.
 * Deterministic: sorted by provider name, then registry document order per
 * provider.
 *
 * Without an ECR snapshot the legacy seed mapping applies (`BROKEN` never
 * projected; `EXPERIMENTAL` only with the explicit opt-in). With a snapshot
 * the ECR is the authority: quarantined paths are NEVER projected, trusted
 * paths project by default, and evidence-backed experimental/stale paths
 * project only with the explicit opt-in.
 */
export function projectModelUniverse(
  registry: RegistryDocument,
  snapshot: ModelUniverseSnapshot,
  effective?: EffectiveProjectionSnapshot,
): readonly ModelProjection[] {
  const projections: ModelProjection[] = [];
  const bindings = [...snapshot.bindings].sort((left, right) => left.providerName.localeCompare(right.providerName));
  for (const binding of bindings) {
    for (const evidence of modelsForProvider(registry, binding.providerName)) {
      if (effective === undefined) {
        if (evidence.compatibility.state === "BROKEN") continue;
        if (evidence.compatibility.state === "EXPERIMENTAL" && !snapshot.experimentalModels) continue;
        projections.push(projectionFor(binding, evidence));
        continue;
      }
      const effectiveForModel = effective.get(evidence.logicalId);
      if (effectiveForModel === undefined || effectiveForModel.size === 0) {
        // No ECR data: seed mapping only (runtime facade always populates rows).
        if (evidence.compatibility.state === "BROKEN") continue;
        if (evidence.compatibility.state === "EXPERIMENTAL" && !snapshot.experimentalModels) continue;
        projections.push(projectionFor(binding, evidence));
        continue;
      }
      if (projectionEligible(evidence, effectiveForModel, snapshot.experimentalModels)) {
        projections.push(projectionFor(binding, evidence, effectiveForModel));
      }
    }
  }
  return Object.freeze(projections);
}

/**
 * ECR-driven projection gate (#124). Required RLY features must be effectively
 * trusted by default; quarantine excludes even with the explicit opt-in.
 */
function projectionEligible(
  evidence: ModelEvidence,
  effective: ReadonlyMap<ClaimFeature, EffectiveCompatibility>,
  experimentalModels: boolean,
): boolean {
  const features = requiredFeaturesForEvidence(evidence);
  const results = features
    .map((feature) => effective.get(feature))
    .filter((result): result is EffectiveCompatibility => result !== undefined);
  if (results.some((result) => result.quarantine === "active" || result.effective === "quarantined")) return false;
  if (results.every((result) => result.effective === "trusted")) return true;
  if (!experimentalModels) return false;
  // Explicit opt-in may expose evidence-backed experimental/stale paths but
  // NEVER untrusted (rejected/contradicted/failed) or missing paths.
  return results.every((result) => result.effective === "experimental" || result.effective === "stale");
}

/**
 * Explicit reverse mapping: projection id -> one exact trusted evidence target
 * plus its pinned pool binding. Re-derived per request from the session's
 * pinned snapshot and the CURRENT registry, so a model removed or marked
 * BROKEN/EXPERIMENTAL-ineligible in a newer registry revision fails closed
 * (returns undefined) instead of substituting another model. Routing never
 * parses the id string.
 */
export function resolveProjection(
  projectionId: string,
  snapshot: ModelUniverseSnapshot,
  registry: RegistryDocument,
  effective?: EffectiveProjectionSnapshot,
): Readonly<{ projection: ModelProjection; binding: ProviderPoolBinding; evidence: ModelEvidence }> | undefined {
  if (!isProjectionId(projectionId)) return undefined;
  for (const projection of projectModelUniverse(registry, snapshot, effective)) {
    if (projection.id !== projectionId) continue;
    const binding = snapshot.bindings.find(
      (candidate) => candidate.providerName === projection.providerName && candidate.poolId === projection.poolId,
    );
    if (binding === undefined) return undefined;
    const evidence = findModelEvidence(registry, projection.providerName, projection.upstreamModelId);
    if (evidence === undefined) return undefined;
    return Object.freeze({ projection, binding, evidence });
  }
  return undefined;
}

/** Secret-free allowlisted routing metadata for the route trace. */
export function createModelProjectionTrace(
  projection: ModelProjection,
  snapshot: ModelUniverseSnapshot,
): ModelProjectionTrace {
  return Object.freeze({
    projectionId: projection.id,
    displayName: projection.displayName,
    providerId: projection.providerId,
    upstreamModelId: projection.upstreamModelId,
    poolId: projection.poolId,
    policyRevision: snapshot.policyRevision,
    registryRevision: snapshot.registryRevision,
  });
}

/**
 * Compiles a session's model-universe snapshot from the control-plane policy
 * (issue #72 scope 5). Bindings, deterministically:
 * 1. the profile's own explicit pool -> provider binding (when its provider is
 *    enabled and the pool has at least one runnable account);
 * 2. every other enabled provider with exactly one eligible pool (>=1 runnable
 *    account) — the #66 "one default pool per configured provider" convention.
 * A provider with multiple pools and no explicit profile binding is excluded:
 * RLY never chooses an arbitrary pool at discovery or request time.
 *
 * Runnable means persisted `ready` AND live-present (env handles probe the
 * injected environment) AND terms-acknowledged when the provider requires it.
 * Discovery therefore uses the same eligibility snapshot as routing: a pool
 * without a runnable account is not advertised.
 */
export function compileModelUniverseSnapshot(
  policy: PolicyRevision,
  registry: RegistryDocument,
  input: Readonly<{
    profile?: ProfileRecord;
    experimentalModels?: boolean;
    environment?: NodeJS.ProcessEnv;
  }> = {},
): ModelUniverseSnapshot {
  const pools = policy.snapshot.pools;
  const providers = policy.snapshot.providers;
  const environment = input.environment ?? process.env;
  const runnableAccountIds = new Set(
    policy.snapshot.accounts
      .filter((account) => accountIsRunnable(
        account,
        providers.find((item) => item.id === account.providerId),
        environment,
      ))
      .map((account) => account.id),
  );
  const poolIsEligible = (poolId: string): boolean => {
    const pool = pools.find((item) => item.id === poolId);
    if (pool === undefined) return false;
    return pool.memberships.some((membership) => runnableAccountIds.has(membership.accountId));
  };
  const bindings = new Map<string, ProviderPoolBinding>();
  const addBinding = (poolId: string, provider: PolicyRevision["snapshot"]["providers"][number]): void => {
    bindings.set(provider.id, {
      providerId: provider.id,
      providerName: provider.name,
      poolId,
    });
  };
  // 1. Explicit profile binding.
  const profilePoolId = input.profile?.poolId;
  if (profilePoolId !== undefined) {
    const pool = pools.find((item) => item.id === profilePoolId);
    const provider = pool === undefined ? undefined : providers.find((item) => item.id === pool.providerId);
    if (pool !== undefined && provider !== undefined && provider.enabled && poolIsEligible(pool.id)) {
      addBinding(pool.id, provider);
    }
  }
  // 2. Other enabled providers with exactly one eligible default pool.
  for (const provider of providers) {
    if (bindings.has(provider.id) || !provider.enabled) continue;
    const eligiblePools = pools.filter((pool) => pool.providerId === provider.id && poolIsEligible(pool.id));
    const defaultPool = eligiblePools.length === 1 ? eligiblePools[0] : undefined;
    if (defaultPool !== undefined) addBinding(defaultPool.id, provider);
  }
  return Object.freeze({
    policyRevision: policy.revision,
    policyHash: policy.hash,
    registryRevision: registry.registryRevision,
    bindings: Object.freeze(
      [...bindings.values()].sort((left, right) => left.providerName.localeCompare(right.providerName)),
    ),
    experimentalModels: input.experimentalModels ?? false,
  });
}

/** Secret-free discovery eligibility: persisted ready + env presence + terms. */
function accountIsRunnable(
  account: PolicyRevision["snapshot"]["accounts"][number],
  provider: PolicyRevision["snapshot"]["providers"][number] | undefined,
  environment: NodeJS.ProcessEnv,
): boolean {
  if (account.state !== "ready") return false;
  if (provider?.requiredTermsRevision && provider.requiredTermsRevision !== account.termsAcknowledgedRevision) {
    return false;
  }
  if (account.credentialHandle.startsWith("env:")) {
    const name = account.credentialHandle.slice(4);
    if (!environment[name]) return false;
  }
  return true;
}
