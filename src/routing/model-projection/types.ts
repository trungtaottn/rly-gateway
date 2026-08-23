/**
 * RLY model projection through the Claude gateway (#72).
 *
 * The trusted model universe (`src/registry/model-registry.ts`, #67) is
 * exposed to Claude Code through the official Anthropic Messages discovery
 * surface (`GET /v1/models`). Every discoverable entry is a **projection**: a
 * stable, Claude-compatible user-selection handle plus an explicit reverse
 * mapping to one exact access-provider/model target and one provider pool.
 *
 * Projection ids are transport/user-selection handles ONLY. Routing never
 * derives security or routing decisions by parsing id string segments; the
 * reverse mapping (`resolveProjection`) is the only bridge between a
 * projection id and its physical target, and it fails closed when the target
 * no longer has trusted evidence.
 */

import type { CompatibilityState } from "../../registry/model-registry.js";

/**
 * Prefix for RLY-only gateway model ids (#74/#72). Claude Code's gateway
 * discovery only adds models whose returned id begins with `claude` or
 * `anthropic`, so every RLY projection uses this stable namespace. A model id
 * with this prefix is RLY-owned state: it is persisted only inside the RLY
 * Claude configuration overlay and never leaks into native settings.
 */
export const RLY_MODEL_PREFIX = "claude-rly-";

/** True for RLY-only projection ids; used to route projection requests. */
export function isProjectionId(modelId: string): boolean {
  return modelId.startsWith(RLY_MODEL_PREFIX);
}

/**
 * One explicit provider -> pool binding in a launch-session model universe.
 * A pool is never chosen arbitrarily: bindings come from the profile's own
 * pool (explicit) or from a provider with exactly one eligible default pool
 * (the #66 onboarding convention), and are pinned in the session snapshot.
 */
export type ProviderPoolBinding = Readonly<{
  providerId: string;
  providerName: string;
  poolId: string;
}>;

/**
 * Session-pinned model-universe snapshot (issue #72 scope 5). Pinned at
 * launch-session issue time so a registry/policy change during an active
 * session can never silently remap an already-issued projection id.
 */
export type ModelUniverseSnapshot = Readonly<{
  /** Control-plane policy revision the bindings were compiled from. */
  policyRevision: number;
  policyHash: string;
  /** Trusted registry document revision the projection used. */
  registryRevision: number;
  bindings: readonly ProviderPoolBinding[];
  /** Explicit user policy toggle exposing EXPERIMENTAL compatibility models. */
  experimentalModels: boolean;
}>;

/**
 * #J2 contract A: one frozen profile-route binding captured at launch-session
 * issue time. Profile model roles/policy, the provider→pool execution target
 * (strategy/retry/affinity/memberships) and the provider config are PINNED so
 * a mid-session control-plane edit can never silently change the model or
 * execution target of an active session — the same freeze the projection
 * universe already had. Account state, credentials and ECR compatibility stay
 * live (revocations/pauses/quarantine apply immediately).
 */
export type SessionPolicySnapshot = Readonly<{
  profile: Readonly<{
    id: string;
    name: string;
    harness: "claude" | "codex";
    modelRoles: Readonly<Record<string, string>>;
    capabilityPolicy: unknown;
    launchPolicy: unknown;
  }>;
  pool: Readonly<{
    id: string;
    name: string;
    providerId: string;
    strategy: string;
    retryBudget: number;
    affinity: unknown;
    memberships: readonly Readonly<{ accountId: string }>[];
  }>;
  provider: Readonly<{
    id: string;
    name: string;
    integrationMode: "direct" | "oauth" | "bridge";
    endpointPolicy: string | undefined;
    enabled: boolean;
  }>;
}>;

/**
 * Secret-free projected model entry presented to Claude Code discovery.
 * `id` is the user-selection handle; `upstreamModelId` is the exact physical
 * target under `providerName`. Never contains credentials, account identity,
 * prompts, or responses.
 */
export type ModelProjection = Readonly<{
  id: string;
  displayName: string;
  providerId: string;
  providerName: string;
  poolId: string;
  upstreamModelId: string;
  modelFamily?: string;
  compatibilityState: CompatibilityState;
  /** #124: effective ECR label when the ECR is the projection authority. */
  effectiveLabel?: string;
  /** Registry evidence date; also drives the discovery `created_at` field. */
  verifiedAt: string;
  /** Evidenced context window; omitted when the registry row has no number. */
  contextWindow?: number;
  /** Evidenced max output tokens; omitted when the registry row has no number. */
  maxOutput?: number;
}>;

/**
 * Secret-free allowlisted routing metadata for one projection decision
 * (route-trace). Shows the projection id/display target as routing metadata
 * and then the exact access-provider/model decision; never credentials,
 * account identity, prompts, or responses.
 */
export type ModelProjectionTrace = Readonly<{
  projectionId: string;
  displayName: string;
  providerId: string;
  upstreamModelId: string;
  poolId: string;
  policyRevision: number;
  registryRevision: number;
}>;
