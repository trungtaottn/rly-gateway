import type { CanonicalEvent } from "../core/canonical-event.js";
import type { CanonicalRequest } from "../core/canonical-request.js";
import type { CapabilityRequirement } from "../core/capabilities.js";
import { agentPseudonym, type AgentContext } from "../core/agent-context.js";
import { reasoningRequestFromWire } from "../core/reasoning.js";
import { decideRoute, type RouteRecord } from "../core/router.js";
import { conservativeTokenCount } from "../core/token-counting.js";
import type { ControlPlaneStore } from "../control-plane/store.js";
import type { AccountRecord, PolicyRevision, PoolRecord, PoolStrategy, ProfileRecord, ProviderRecord } from "../control-plane/types.js";
import type { CredentialBroker } from "../credentials/broker.js";
import { parseCredentialRef } from "../credentials/credential-ref.js";
import type { CanonicalUpstream } from "../protocols/anthropic/fake-upstream.js";
import { adapterIdFor, createProviderAdapter } from "../providers/dispatch.js";
import { ReasoningTranslationError, resolveReasoning } from "../providers/reasoning.js";
import { preflightContextWindow } from "../registry/tokenizer-registry.js";
import { directProviderRegistry, modelsForProvider, type RegistryDocument } from "../registry/model-registry.js";
import type { EffectiveCompatibilityRegistry } from "../compatibility/registry.js";
import type { EffectiveCompatibilityLabel, EffectiveEnforcement } from "../compatibility/types.js";
import { requiredFeaturesForCapabilities } from "../compatibility/features.js";
import type { EffectiveSelectionSnapshot } from "../routing/model-selection/types.js";
import { createModelProjectionTrace, resolveProjection } from "../routing/model-projection/project.js";
import type { ModelProjectionTrace } from "../routing/model-projection/types.js";
import { toRouteDecision, type EffectiveRoute } from "../routing/effective-route.js";
import type { CredentialSnapshot } from "../routing/eligibility/reasons.js";
import { createDecisionTrace } from "../routing/eligibility/trace.js";
import { isModelSelectionError } from "../routing/model-selection/errors.js";
import { createModelSelectionTrace, selectModel } from "../routing/model-selection/selector.js";
import type { ModelSelectionResult, ReasoningRequirement } from "../routing/model-selection/types.js";
import { streamPoolRequest } from "../routing/pools/execute.js";
import type { RouteSelector } from "../routing/pools/selector.js";
import { isTierResolutionError } from "../routing/model-tiers/errors.js";
import { resolveTier } from "../routing/model-tiers/resolver.js";
import { LOGICAL_TIERS, type LogicalTier, type TierResolutionTrace } from "../routing/model-tiers/types.js";
import { isModelIntentError } from "../routing/model-intent/errors.js";
import { classifyModelIntent } from "../routing/model-intent/classify.js";
import type { ClientNativeAlias, ModelIntent, ModelIntentTrace } from "../routing/model-intent/types.js";
// #127: EffectiveModelDecision — the FINAL model-control output before account
// selection. The assembler only records the existing stage outputs (#68/#69/
// #70/#71/#72/#124/#125/#126); it never re-resolves a model/tier/projection
// and never touches accounts or credentials.
import { assembleEffectiveModelDecision, environmentOwnershipSummary, readPersistedViewModel } from "../routing/model-decision/assemble.js";
import type { EffectiveModelDecision } from "../routing/model-decision/types.js";
import { activateProfile, findProfileById, inspectLaunchableProfile, type ActivatedRole } from "./activate.js";
import type { AgentExecutionContextRegistry, ExecutionContext, ParentExecutionReference } from "./agent-contexts.js";
import { ProfileActivationError } from "./errors.js";
import { resolveProfileRole } from "./helper-map.js";
import type { LaunchSession } from "./sessions.js";
import type { AgentTraceLinkage, RouteTraceRing } from "./traces.js";

export type ProfileRouteDependencies = Readonly<{
  store: ControlPlaneStore;
  broker: CredentialBroker;
  selector: RouteSelector;
  traces: RouteTraceRing;
  configFingerprint: string;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  required?: readonly CapabilityRequirement[];
  /** Session-scoped Claude Code agent execution contexts (#71). */
  agentContexts?: AgentExecutionContextRegistry;
  /** #124: Effective Compatibility Registry — the runtime compatibility authority. */
  compatibility?: EffectiveCompatibilityRegistry;
}>;

/** Profile-route dependencies plus an optional trusted registry override (#72). */
export type ProjectedRouteDependencies = ProfileRouteDependencies & Readonly<{ registry?: RegistryDocument }>;

export type ResolvedProfileRoute = Readonly<{
  route: RouteRecord;
  upstream: CanonicalUpstream;
  /** #127: one typed EffectiveModelDecision produced before account selection. */
  decision: EffectiveModelDecision;
}>;

export async function resolveProfileRoute(
  canonical: CanonicalRequest,
  session: LaunchSession,
  dependencies: ProfileRouteDependencies,
): Promise<ResolvedProfileRoute> {
  const policy = dependencies.store.currentPolicy();
  if (!policy) throw new ProfileActivationError("profile-not-found");
  // #J2 contract A: profile-route resolution reads the session's FROZEN
  // binding (model roles/policy + provider→pool execution target) overlaid on
  // the live policy for accounts/ECR. A mid-session control-plane edit cannot
  // silently change the model or execution target of an active session; a
  // profile/pool/provider removed mid-session keeps serving the frozen target.
  const sessionPolicy = applySessionBinding(policy, session);
  const named = findProfileById(sessionPolicy.snapshot.profiles, session.profileId)?.name ?? session.profileName;
  const inspected = inspectLaunchableProfile(sessionPolicy.snapshot.profiles, named);
  const pool = sessionPolicy.snapshot.pools.find((item) => item.id === inspected.poolId);
  if (!pool) throw new ProfileActivationError("profile-has-no-pool");
  const provider = sessionPolicy.snapshot.providers.find((item) => item.id === pool.providerId);
  if (!provider) throw new ProfileActivationError("profile-has-no-pool");
  // #71: a subagent request inherits the parent agent's frozen physical
  // model/family for #69 tier family affinity. Parent resolution never
  // mutates the parent's own context: each request resolves independently and
  // only records its own context after success (see below).
  const parentReference = resolveParentExecutionReference(canonical.agent, session, dependencies.agentContexts);
  // #125: classify the incoming selector into a typed model intent BEFORE any
  // routing. The #69 tier resolver is only ever invoked for an explicitly
  // typed tier intent (`rly-tier:*` or a client-native alias mapped through
  // the explicit client-alias contract) — never by bare string equality with
  // a tier name.
  let intent: ModelIntent;
  try {
    intent = classifyIntentForRequest(canonical.requestedModel);
  } catch (error) {
    recordPreSelectionFailure({
      traces: dependencies.traces,
      session,
      policy,
      pool,
      request: canonical,
      error,
      attemptedLogicalId: `${provider.name}/${canonical.requestedModel}`,
      intent: failureIntentTrace(canonical.requestedModel),
    });
    throw error;
  }
  // #124: the Effective Compatibility Registry is the compatibility authority —
  // feature-scoped effective trust/health/freshness/quarantine/enforcement,
  // never the static registry state alone. Resolved once per request and
  // threaded into tier resolution + final exact selection.
  const effectiveSnapshot = await effectiveSnapshotFor(
    dependencies,
    provider.name,
    dependencies.required ?? [],
    canonical,
    directProviderRegistry,
  );
  let intentResolution: ReturnType<typeof resolveModelIntent>;
  try {
    intentResolution = resolveModelIntent(
      intent,
      canonical,
      provider.name,
      inspected.profile,
      dependencies.required ?? [],
      parentReference?.context,
      effectiveSnapshot,
    );
  } catch (error) {
    recordPreSelectionFailure({
      traces: dependencies.traces,
      session,
      policy,
      pool,
      request: canonical,
      error,
      attemptedLogicalId: `${provider.name}/${canonical.requestedModel}`,
      intent: intentTraceFor(intent, {}),
    });
    throw error;
  }
  const resolvedModelId = intentResolution.modelId;
  const resolvedRole = intentResolution.role;
  const tierResolution = intentResolution.tierResolution;
  const intentTrace = intentResolution.intentTrace;
  // Stage 1: deterministic model capability selection (#68) against the trusted
  // registry, BEFORE any account/pool selection. The selected physical model is
  // frozen into the effective request/route; account failover can never change it.
  const reasoningRequest = canonical.inference.reasoning ?? reasoningRequestFromWire({});
  let selection: ModelSelectionResult;
  try {
    selection = selectModelForRequest(
      resolvedModelId,
      provider.name,
      dependencies.required ?? [],
      canonical,
      directProviderRegistry,
      effectiveSnapshot,
      dependencies.compatibility?.policy.allowQuarantineBypass,
    );
  } catch (error) {
    recordPreSelectionFailure({
      traces: dependencies.traces,
      session,
      policy,
      pool,
      request: canonical,
      error,
      attemptedLogicalId: `${provider.name}/${resolvedModelId}`,
    });
    throw error;
  }
  const modelEvidence = selection.model;
  // Stage 1b (#70): translate the canonical reasoning intent into the selected
  // model's native control through the provider-owned boundary, BEFORE account
  // selection, so the decision and trace carry deterministic mapping metadata.
  // Fail-closed: an untranslatable explicit intent never becomes a silent
  // downgrade; the typed reason surfaces on the existing profile error contract.
  let resolvedReasoning: ReturnType<typeof resolveReasoning>;
  try {
    resolvedReasoning = resolveReasoning(reasoningRequest, modelEvidence.reasoning);
  } catch (error) {
    if (error instanceof ReasoningTranslationError) {
      throw new ProfileActivationError(
        "capability-rejected",
        `Reasoning translation failed (${error.code}: ${provider.name}/${modelEvidence.identity.upstreamModelId})`,
        translationFailureCode(error.code),
      );
    }
    throw error;
  }
  // The classifier-computed role/modelId is authoritative for every intent
  // kind (#125): tiers, client-native aliases, exact models, and the
  // inherit/default paths all arrive here pre-resolved, so activateProfile
  // never re-derives a role from the raw selector string (a bare `default` or
  // `inherit` is not a profile role). Capability policy and required
  // capabilities are still validated below, unchanged.
  const activated = activateProfile(sessionPolicy.snapshot.profiles, {
    profileId: session.profileId,
    name: session.profileName,
    requestedModel: canonical.requestedModel,
    required: dependencies.required ?? [],
    baseCapabilities: modelEvidence.capabilities,
    resolved: { role: resolvedRole, modelId: resolvedModelId },
  });
  const capabilities = activated.capabilities;
  const adapterId = adapterIdFor(provider);
  const route: RouteRecord = {
    role: activated.role,
    providerId: provider.name,
    modelId: activated.modelId,
    adapterId,
    credentialRef: { kind: "handle", handle: "cred-profile-policy" },
    capabilities,
    reasoningEvidence: modelEvidence.reasoning,
  };
  decideRoute({
    requestId: canonical.id,
    route,
    required: dependencies.required ?? [],
    configFingerprint: dependencies.configFingerprint,
    resolvedReasoning,
  });
  // #127: assemble the FINAL model-control output BEFORE account selection. The
  // physical provider/model + reasoning policy are frozen here; the pool/
  // account RouteSelector runs downstream against this exact target and
  // account retry/failover can never change it. Persisted-view state (#126)
  // and child env ownership are consumed as decision inputs (never settings
  // content, never credentials/account identity).
  const persistedViewModel = await readPersistedViewModel(dependencies.store.directory, session.viewId);
  const environmentOwnership = environmentOwnershipSummary(dependencies.environment ?? process.env);
  const decision = assembleEffectiveModelDecision({
    requestId: canonical.id,
    profileId: session.profileId,
    profileName: session.profileName,
    viewId: session.viewId,
    intent: intentTrace,
    resolvedModelId: activated.modelId,
    logicalId: modelEvidence.logicalId,
    accessProviderId: provider.name,
    adapterId,
    ...(modelEvidence.identity.modelFamily === undefined ? {} : { modelFamily: modelEvidence.identity.modelFamily }),
    poolId: activated.poolId,
    policyRevision: policy.revision,
    policyHash: policy.hash,
    ...(tierResolution === undefined
      ? { registryRevision: directProviderRegistry.registryRevision }
      : {
          registryRevision: tierResolution.trace.registryRevision,
          mappingRevision: tierResolution.trace.mappingRevision,
        }),
    sessionUniverseRevision: session.modelUniverse.policyRevision,
    experimentalModels: session.modelUniverse.experimentalModels,
    reasoning: resolvedReasoning,
    selection: selection.decision,
    ...(tierResolution === undefined ? {} : { tier: tierResolution.trace }),
    ...(tierResolution === undefined ? {} : { tierAssessments: tierResolution.trace.assessments }),
    ...(intent.kind === "CLIENT_NATIVE_ALIAS" ? { clientAlias: { alias: intent.alias, mappedTier: intent.mappedTier } } : {}),
    ...(parentReference === undefined ? {} : {
      parent: {
        parentModelId: parentReference.context.resolvedModelId,
        ...(parentReference.context.modelFamily === undefined ? {} : { parentModelFamily: parentReference.context.modelFamily }),
        contextSource: parentReference.source,
      },
    }),
    profileRole: activated.role,
    ...(activated.launchPolicy.model === undefined ? {} : { launchPolicyModel: activated.launchPolicy.model }),
    ...(persistedViewModel === undefined ? {} : { persistedViewModel }),
    environmentOwnership,
    ...(effectiveSnapshot === undefined ? {} : { effectiveFeatures: effectiveFeatureAnswers(effectiveSnapshot, modelEvidence.logicalId) }),
  });
  // #71: record the resolved execution context for this agent so nested and
  // subsequent subagents inherit the correct provider/family affinity. The
  // physical model is frozen at this point; credentials/account ids are never
  // stored. Only fully resolved requests (activation + route decision) record.
  const agentContext = canonical.agent;
  if (dependencies.agentContexts !== undefined && agentContext?.claudeSessionId !== undefined && agentContext.agentId !== undefined) {
    dependencies.agentContexts.record(session, {
      claudeSessionId: agentContext.claudeSessionId,
      agentId: agentContext.agentId,
      ...(agentContext.parentAgentId === undefined ? {} : { parentAgentId: agentContext.parentAgentId }),
      role: agentContext.parentAgentId === undefined ? "main" : "subagent",
      accessProviderId: provider.name,
      resolvedModelId: activated.modelId,
      ...(modelEvidence.identity.modelFamily === undefined ? {} : { modelFamily: modelEvidence.identity.modelFamily }),
      ...(tierResolution === undefined ? {} : { effectiveTier: tierResolution.role }),
      ...(tierResolution === undefined ? {} : { mappingRevision: tierResolution.trace.mappingRevision }),
      ...(tierResolution === undefined ? {} : { registryRevision: tierResolution.trace.registryRevision }),
      updatedAt: new Date().toISOString(),
    });
  }
  // #71: allowlisted agent linkage for diagnostics — pseudonyms only, plus the
  // parent model/family that scoped tier resolution. Never prompts or identity.
  const agentLinkage = agentTraceLinkage(agentContext, parentReference);
  const environment = dependencies.environment ?? process.env;
  const members = sessionPolicy.snapshot.accounts.filter((account) => pool.memberships.some((item) => item.accountId === account.id));
  const snapshots = await credentialSnapshots(dependencies, members, environment);
  const effectiveRequest: CanonicalRequest = Object.freeze({
    ...canonical,
    requestedModel: activated.modelId,
    modelRole: activated.role,
  });
  {
    const gate = preflightContextWindow(effectiveRequest, modelEvidence, `${provider.name}/${activated.modelId}`);
    if (gate.exceeded) {
      const error = new ProfileActivationError("context_window_exceeded", `context_window_exceeded: ${String(gate.count)} > ${String(gate.limit ?? 0)}`);
      recordPreSelectionFailure({
        traces: dependencies.traces,
        session,
        policy,
        pool,
        request: canonical,
        error,
        attemptedLogicalId: `${provider.name}/${activated.modelId}`,
        intent: intentTrace,
      });
      throw error;
    }
  }
  // P1: enforce governance allowedModels on resolved physical model (not just requested alias)
  {
    const govKeyId = (canonical as unknown as Record<string, unknown>).__governanceKeyId as string | undefined
      ?? (effectiveRequest as unknown as Record<string, unknown>).__governanceKeyId as string | undefined;
    if (typeof govKeyId === "string" && govKeyId.length > 0) {
      const row = dependencies.store.database.prepare("SELECT allowed_models as allowed FROM governance_keys WHERE id = ?").get(govKeyId) as { allowed: string | null } | undefined;
      const allowed = row?.allowed === null || row?.allowed === undefined ? undefined : JSON.parse(row.allowed) as readonly string[] | undefined;
      if (allowed !== undefined && allowed.length > 0 && !allowed.includes(activated.modelId) && !allowed.includes(`${provider.name}/${activated.modelId}`)) {
        throw new ProfileActivationError("capability-rejected", `model ${activated.modelId} not allowed for this key`);
      }
    }
  }
  return {
    route,
    decision,
    upstream: {
      invoke: (_ignored: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalEvent> => {
        return streamPoolRequest({
          selector: dependencies.selector,
          store: dependencies.store,
          request: effectiveRequest,
          select: {
            poolId: activated.poolId,
            policy: sessionPolicy,
            required: dependencies.required ?? [],
            capabilities,
            modelId: activated.modelId,
            adapterId,
            role: activated.role,
            credentialSnapshots: snapshots,
            sessionKey: session.leaseId,
            reasoningEvidence: modelEvidence.reasoning,
            resolvedReasoning,
          },
          invoke: (selected, invokeSignal) => invokeSelected(
            effectiveRequest,
            selected,
            provider,
            dependencies,
            environment,
            invokeSignal,
          ),
          signal,
          onTrace: (trace) => dependencies.traces.push(trace, session.profileName, selection.decision, resolvedReasoning, tierResolution?.trace, agentLinkage, undefined, intentTrace, decision),
        });
      },
      countTokens: () => Promise.resolve(conservativeTokenCount(effectiveRequest)),
    },
  };
}

/**
 * Routes a request whose model is an RLY projection id (`claude-rly-...`,
 * #72) to one exact access-provider/model target and the pinned provider pool.
 *
 * The projection id is a user-selection handle only: the explicit reverse
 * mapping (`resolveProjection`) yields the exact physical target from the
 * session's pinned model universe, then the existing two-stage boundary runs
 * unchanged — #68 exact model selection + #70 reasoning translation, followed
 * by pool/account selection inside the pinned pool. Fail-closed: an unknown,
 * removed, BROKEN, or EXPERIMENTAL-ineligible projection (or a provider/pool
 * that is no longer in the current policy) raises a typed error and never
 * substitutes another model or provider.
 */
export async function resolveProjectedModelRoute(
  canonical: CanonicalRequest,
  session: LaunchSession,
  dependencies: ProjectedRouteDependencies,
): Promise<ResolvedProfileRoute> {
  const universe = session.modelUniverse;
  const registry = dependencies.registry ?? directProviderRegistry;
  const resolved = resolveProjection(canonical.requestedModel, universe, registry);
  if (resolved === undefined) {
    throw new ProfileActivationError(
      "model-unavailable",
      `RLY projection model is not available in this session (${canonical.requestedModel})`,
    );
  }
  const policy = dependencies.store.currentPolicy();
  if (!policy) throw new ProfileActivationError("profile-not-found");
  // #J2 contract A: the projection target's provider→pool also reads the
  // frozen session binding, so a mid-session edit can never change the
  // execution target of a projection request either.
  const sessionPolicy = applySessionBinding(policy, session);
  const pool = sessionPolicy.snapshot.pools.find((item) => item.id === resolved.binding.poolId);
  const provider = sessionPolicy.snapshot.providers.find((item) => item.id === resolved.binding.providerId);
  if (pool === undefined || provider === undefined || !provider.enabled) {
    throw new ProfileActivationError(
      "model-unavailable",
      `Projection target is no longer available (${resolved.binding.providerName}/${resolved.projection.upstreamModelId})`,
    );
  }
  // Stage 1: deterministic exact model selection (#68) against the trusted
  // registry. Re-validates capabilities/compatibility/reasoning for the exact
  // physical target — a BROKEN or unsupported target fails closed here.
  const reasoningRequest = canonical.inference.reasoning ?? reasoningRequestFromWire({});
  // #124: the Effective Compatibility Registry is the compatibility authority
  // for the exact projected target (feature-scoped, fail-closed).
  const effectiveSnapshot = await effectiveSnapshotFor(
    dependencies,
    provider.name,
    dependencies.required ?? [],
    canonical,
    registry,
  );
  let selection: ModelSelectionResult;
  try {
    selection = selectModelForRequest(
      resolved.evidence.identity.upstreamModelId,
      provider.name,
      dependencies.required ?? [],
      canonical,
      registry,
      effectiveSnapshot,
      dependencies.compatibility?.policy.allowQuarantineBypass,
    );
  } catch (error) {
    recordPreSelectionFailure({
      traces: dependencies.traces,
      session,
      policy,
      pool,
      request: canonical,
      error,
      attemptedLogicalId: resolved.evidence.logicalId,
    });
    throw error;
  }
  const modelEvidence = selection.model;
  // Stage 1b (#70): translate the canonical reasoning intent into the selected
  // model's native control; fail closed on untranslatable explicit intents.
  let resolvedReasoning: ReturnType<typeof resolveReasoning>;
  try {
    resolvedReasoning = resolveReasoning(reasoningRequest, modelEvidence.reasoning);
  } catch (error) {
    if (error instanceof ReasoningTranslationError) {
      throw new ProfileActivationError(
        "capability-rejected",
        `Reasoning translation failed (${error.code}: ${provider.name}/${modelEvidence.identity.upstreamModelId})`,
        translationFailureCode(error.code),
      );
    }
    throw error;
  }
  const capabilities = modelEvidence.capabilities;
  const adapterId = adapterIdFor(provider);
  const route: RouteRecord = {
    role: "unknown",
    providerId: provider.name,
    modelId: modelEvidence.identity.upstreamModelId,
    adapterId,
    credentialRef: { kind: "handle", handle: "cred-profile-policy" },
    capabilities,
    reasoningEvidence: modelEvidence.reasoning,
  };
  decideRoute({
    requestId: canonical.id,
    route,
    required: dependencies.required ?? [],
    configFingerprint: dependencies.configFingerprint,
    resolvedReasoning,
  });
  const environment = dependencies.environment ?? process.env;
  const members = policy.snapshot.accounts.filter((account) => pool.memberships.some((item) => item.accountId === account.id));
  const snapshots = await credentialSnapshots(dependencies, members, environment);
  const effectiveRequest: CanonicalRequest = Object.freeze({
    ...canonical,
    requestedModel: modelEvidence.identity.upstreamModelId,
    modelRole: "unknown",
  });
  const projectionTrace: ModelProjectionTrace = createModelProjectionTrace(resolved.projection, universe);
  const intentTrace: ModelIntentTrace = Object.freeze({
    kind: "EXACT_PROJECTION",
    sourceSelector: canonical.requestedModel,
    source: "projection-namespace",
    modelId: modelEvidence.identity.upstreamModelId,
    role: "unknown",
  });
  {
    const gate = preflightContextWindow(effectiveRequest, modelEvidence, `${provider.name}/${modelEvidence.identity.upstreamModelId}`);
    if (gate.exceeded) {
      const error = new ProfileActivationError("context_window_exceeded", `context_window_exceeded: ${String(gate.count)} > ${String(gate.limit ?? 0)}`);
      recordPreSelectionFailure({
        traces: dependencies.traces,
        session,
        policy,
        pool,
        request: canonical,
        error,
        attemptedLogicalId: modelEvidence.logicalId,
        intent: intentTrace,
      });
      throw error;
    }
  }
  // #127: assemble the FINAL model-control output BEFORE account selection for
  // the exact projected target. The projection reverse-mapping is the only
  // bridge from the selection handle to the frozen physical target (#72); a
  // persisted/foreign projection id is recorded as visible state and the
  // pinned session universe stays authoritative (stale/foreign ids fail
  // closed in `resolveProjection` — never silently remapped).
  const persistedViewModel = await readPersistedViewModel(dependencies.store.directory, session.viewId);
  const environmentOwnership = environmentOwnershipSummary(dependencies.environment ?? process.env);
  const decision = assembleEffectiveModelDecision({
    requestId: canonical.id,
    profileId: session.profileId,
    profileName: session.profileName,
    viewId: session.viewId,
    intent: intentTrace,
    resolvedModelId: modelEvidence.identity.upstreamModelId,
    logicalId: modelEvidence.logicalId,
    accessProviderId: provider.name,
    adapterId,
    ...(modelEvidence.identity.modelFamily === undefined ? {} : { modelFamily: modelEvidence.identity.modelFamily }),
    poolId: resolved.binding.poolId,
    policyRevision: policy.revision,
    policyHash: policy.hash,
    registryRevision: universe.registryRevision,
    sessionUniverseRevision: universe.policyRevision,
    experimentalModels: universe.experimentalModels,
    reasoning: resolvedReasoning,
    selection: selection.decision,
    projection: projectionTrace,
    ...(persistedViewModel === undefined ? {} : { persistedViewModel }),
    environmentOwnership,
    ...(effectiveSnapshot === undefined ? {} : { effectiveFeatures: effectiveFeatureAnswers(effectiveSnapshot, modelEvidence.logicalId) }),
  });
  return {
    route,
    decision,
    upstream: {
      invoke: (_ignored: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalEvent> => {
        return streamPoolRequest({
          selector: dependencies.selector,
          store: dependencies.store,
          request: effectiveRequest,
          select: {
            poolId: resolved.binding.poolId,
            policy: sessionPolicy,
            required: dependencies.required ?? [],
            capabilities,
            modelId: modelEvidence.identity.upstreamModelId,
            adapterId,
            role: "unknown",
            credentialSnapshots: snapshots,
            sessionKey: session.leaseId,
            reasoningEvidence: modelEvidence.reasoning,
            resolvedReasoning,
          },
          invoke: (selected, invokeSignal) => invokeSelected(
            effectiveRequest,
            selected,
            provider,
            dependencies,
            environment,
            invokeSignal,
          ),
          signal,
          onTrace: (trace) => dependencies.traces.push(trace, session.profileName, selection.decision, resolvedReasoning, undefined, undefined, projectionTrace, intentTrace, decision),
        });
      },
      countTokens: () => Promise.resolve(conservativeTokenCount(effectiveRequest)),
    },
  };
}

function envCredentialName(handle: string): string | undefined {
  return handle.startsWith("env:") ? handle.slice(4) : undefined;
}

/** Secret-free pre-account-selection failure evidence for `rly route-trace`. */
function failureIntentTrace(selector: string): ModelIntentTrace {
  if (selector.startsWith("rly-tier:")) {
    return Object.freeze({ kind: "RLY_LOGICAL_TIER", sourceSelector: selector, source: "rly-tier-namespace" });
  }
  return Object.freeze({ kind: "EXACT_CLIENT_MODEL", sourceSelector: selector, source: "exact-model" });
}

function recordPreSelectionFailure(input: Readonly<{
  traces: RouteTraceRing;
  session: LaunchSession;
  policy: PolicyRevision;
  pool: PoolRecord;
  request: CanonicalRequest;
  error: unknown;
  attemptedLogicalId: string;
  intent?: ModelIntentTrace;
}>): void {
  if (!(input.error instanceof ProfileActivationError)) return;
  const reason = input.error.modelFailure ?? input.error.tierFailure ?? input.error.intentFailure ?? input.error.code;
  input.traces.push(
    createDecisionTrace({
      requestId: input.request.id,
      policyRevision: input.policy.revision,
      policyHash: input.policy.hash,
      strategy: input.pool.strategy,
      sourceRule: `model-selection:${reason}`,
      candidates: [],
      decidedAt: new Date().toISOString(),
    }),
    input.session.profileName,
    createModelSelectionTrace({
      source: "exact",
      selectedLogicalId: input.attemptedLogicalId,
      reason,
      candidates: [],
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    input.intent,
  );
}

function translationFailureCode(code: "unsupported-reasoning" | "no-budget-policy"): "reasoning-translation-unsupported" | "reasoning-budget-policy-missing" {
  return code === "no-budget-policy" ? "reasoning-budget-policy-missing" : "reasoning-translation-unsupported";
}

/**
 * Builds the reasoning requirement for #68 eligibility from the canonical
 * request (#70): explicit non-OFF/non-AUTO intents demand reasoning; when the
 * request also uses tools, reasoning must interleave with tool use (#24/#67
 * evidence gate). OFF and AUTO delegate to the decoded capability list.
 */
function reasoningRequirementFrom(request: CanonicalRequest, required: readonly CapabilityRequirement[]): ReasoningRequirement | undefined {
  const reasoning = request.inference.reasoning;
  if (reasoning !== undefined && reasoning.intent !== "OFF" && reasoning.intent !== "AUTO") {
    return { required: true, ...(request.tools.length > 0 ? { withTools: true } : {}) };
  }
  return required.includes("reasoning") ? { required: true } : undefined;
}

/**
 * Parent/current model role order for tier family context (#69): the
 * profile's main model first, then fallback roles, then configured tier
 * overrides. The parent model's registry evidence supplies the model family
 * that scopes a tier request on multi-family access providers.
 */
const PARENT_ROLE_ORDER: readonly string[] = ["primary", "reasoning", "fast", ...LOGICAL_TIERS];

function parentModelForProfile(modelRoles: Readonly<Record<string, string>>): string | undefined {
  for (const role of PARENT_ROLE_ORDER) {
    const modelId = modelRoles[role];
    if (modelId !== undefined) return modelId;
  }
  return undefined;
}

/**
 * Resolves the parent execution context for #69 tier family affinity (#71).
 *
 * A subagent request inherits the parent agent's frozen physical model:
 * exact `(session, parentAgentId)` match first, then the session's main-agent
 * context (the session's current/default context). With no recorded context
 * the caller falls back to the profile default model — the launch session's
 * unambiguous default execution context. The fallback never selects another
 * subagent's context, so one subagent's model can never leak into another's
 * tier resolution. When the profile default itself cannot determine a parent
 * family on a multi-family provider, #69 fails closed (`family-unknown` →
 * `tier-unavailable`) rather than choosing a global strongest model.
 */
function resolveParentExecutionReference(
  agent: AgentContext | undefined,
  session: LaunchSession,
  registry: AgentExecutionContextRegistry | undefined,
): ParentExecutionReference | undefined {
  if (agent === undefined || agent.claudeSessionId === undefined || registry === undefined) return undefined;
  // Main-agent requests have no parent; #69 uses the profile default parent.
  if (agent.parentAgentId === undefined) return undefined;
  const exact = registry.resolve(session, agent.claudeSessionId, agent.parentAgentId);
  if (exact !== undefined) return { context: exact, source: "parent-agent" };
  const main = registry.mainContext(session, agent.claudeSessionId);
  if (main !== undefined) return { context: main, source: "session-default" };
  return undefined;
}

/** Allowlisted agent linkage for the decision trace (#71). */
function agentTraceLinkage(
  agent: AgentContext | undefined,
  parent: ParentExecutionReference | undefined,
): AgentTraceLinkage | undefined {
  if (agent === undefined) return undefined;
  return Object.freeze({
    claudeSessionPseudonym: agentPseudonym(agent.claudeSessionId ?? agent.agentId ?? "session"),
    agentPseudonym: agentPseudonym(agent.agentId ?? agent.claudeSessionId ?? "agent"),
    ...(agent.parentAgentId === undefined ? {} : { parentAgentPseudonym: agentPseudonym(agent.parentAgentId) }),
    contextSource: parent?.source ?? "profile-default",
    ...(parent === undefined ? {} : { parentModelId: parent.context.resolvedModelId }),
    ...(parent === undefined ? {} : { parentModelFamily: parent.context.modelFamily }),
  });
}

/** Classifies a selector into a typed model intent, mapping classification failures onto the profile error contract. */
function classifyIntentForRequest(selector: string): ModelIntent {
  try {
    return classifyModelIntent(selector);
  } catch (error) {
    if (isModelIntentError(error)) {
      throw new ProfileActivationError(
        "role-unmapped",
        `Model intent classification failed (${error.code}: ${selector})`,
        undefined,
        undefined,
        undefined,
        error.code,
      );
    }
    throw error;
  }
}

/**
 * Resolves a typed model intent to one exact physical model target + role.
 *
 * Deterministic precedence (#125):
 * - `RLY_LOGICAL_TIER` → the #69 provider/family tier resolver.
 * - `CLIENT_NATIVE_ALIAS` → the explicit client-alias contract maps the alias
 *   to the equivalent RLY tier, then the #69 resolver runs (deliberate and
 *   traceable, never string equality alone).
 * - `EXACT_CLIENT_MODEL` / `DEFAULT` / `INHERIT` → the existing profile
 *   role/helper/exact-model mapping (#68 path); `INHERIT` prefers the parent's
 *   frozen physical model before the profile default.
 * - `EXACT_PROJECTION` → fail closed: projection selectors are dispatched by
 *   `resolveProjectedModelRoute` before this point.
 */
function resolveModelIntent(
  intent: ModelIntent,
  canonical: CanonicalRequest,
  providerName: string,
  profile: ProfileRecord,
  required: readonly CapabilityRequirement[],
  parent?: ExecutionContext,
  effective?: EffectiveSelectionSnapshot,
): Readonly<{
  role: ActivatedRole;
  modelId: string;
  tierResolution?: Readonly<{ role: LogicalTier; modelId: string; trace: TierResolutionTrace }>;
  intentTrace: ModelIntentTrace;
}> {
  switch (intent.kind) {
    case "RLY_LOGICAL_TIER": {
      const resolution = resolveTierForRequest(intent.tier, canonical, providerName, profile, required, parent, effective);
      return { role: resolution.role, modelId: resolution.modelId, tierResolution: resolution, intentTrace: intentTraceFor(intent, { tier: intent.tier }) };
    }
    case "CLIENT_NATIVE_ALIAS": {
      const resolution = resolveTierForRequest(intent.mappedTier, canonical, providerName, profile, required, parent, effective);
      return { role: resolution.role, modelId: resolution.modelId, tierResolution: resolution, intentTrace: intentTraceFor(intent, { tier: intent.mappedTier, alias: intent.alias }) };
    }
    case "EXACT_PROJECTION": {
      throw new ProfileActivationError("model-unavailable", `Projection selector reached profile resolution (${intent.projectionId})`);
    }
    case "EXACT_CLIENT_MODEL": {
      const mapped = resolveProfileRole(intent.modelId, profile.modelRoles);
      if (mapped === undefined) throw new ProfileActivationError("role-unmapped");
      return { role: mapped.role, modelId: mapped.modelId, intentTrace: intentTraceFor(intent, { modelId: mapped.modelId, role: mapped.role }) };
    }
    case "DEFAULT": {
      const mapped = resolveProfileRole("primary", profile.modelRoles);
      if (mapped === undefined) throw new ProfileActivationError("role-unmapped");
      return { role: mapped.role, modelId: mapped.modelId, intentTrace: intentTraceFor(intent, { modelId: mapped.modelId, role: mapped.role }) };
    }
    case "INHERIT": {
      const modelId = parent?.resolvedModelId ?? profile.modelRoles.primary;
      if (modelId === undefined) throw new ProfileActivationError("role-unmapped");
      const role = parent?.effectiveTier ?? "primary";
      return { role, modelId, intentTrace: intentTraceFor(intent, { modelId, role }) };
    }
  }
}

/** Secret-free allowlisted intent metadata for the route trace (#125). */
function intentTraceFor(
  intent: ModelIntent,
  resolved: Readonly<{ tier?: LogicalTier; alias?: ClientNativeAlias; modelId?: string; role?: string }>,
): ModelIntentTrace {
  return Object.freeze({
    kind: intent.kind,
    sourceSelector: intent.sourceSelector,
    source: intent.source,
    ...(resolved.tier === undefined ? {} : { tier: resolved.tier }),
    ...(resolved.alias === undefined ? {} : { alias: resolved.alias }),
    ...(resolved.modelId === undefined ? {} : { modelId: resolved.modelId }),
    ...(resolved.role === undefined ? {} : { role: resolved.role }),
  });
}

/**
 * Resolves a logical tier request (#69) inside the current execution context:
 * access provider first, then the parent model's family, then trusted tier
 * mapping/capability evidence. The tier target is an exact physical model that
 * then goes through the same #68 exact-selection and #70 reasoning stages.
 * Fail-closed: an unresolvable tier maps onto the existing profile error
 * contract (`tier-unavailable` plus the typed tier reason).
 *
 * #71: a subagent request passes the parent agent's frozen physical
 * model/family (from the execution-context registry) instead of the profile
 * default; the main request keeps the profile default parent (#69).
 *
 * The `tier` parameter is always typed (already classified as RLY_LOGICAL_TIER
 * or a client-native alias mapped through the explicit client-alias contract);
 * this function never re-derives a tier from a bare selector string.
 */
function resolveTierForRequest(
  tier: LogicalTier,
  canonical: CanonicalRequest,
  providerName: string,
  profile: ProfileRecord,
  required: readonly CapabilityRequirement[],
  parent?: ExecutionContext,
  effective?: EffectiveSelectionSnapshot,
): Readonly<{ role: LogicalTier; modelId: string; trace: TierResolutionTrace }> {
  const parentModelId = parent?.resolvedModelId ?? parentModelForProfile(profile.modelRoles);
  const parentFamily = parent?.modelFamily;
  const reasoning = reasoningRequirementFrom(canonical, required);
  try {
    const resolution = resolveTier({
      requestedTier: tier,
      accessProviderId: providerName,
      ...(parentModelId === undefined ? {} : { parentModelId }),
      ...(parentFamily === undefined ? {} : { modelFamily: parentFamily }),
      ...(profile.modelRoles[tier] === undefined ? {} : { explicitUserMapping: profile.modelRoles[tier] }),
      allowCrossFamilyFallback: false,
      allowCrossProviderFallback: false,
    }, {
      requiredCapabilities: required,
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(effective === undefined ? {} : { effective }),
    });
    return Object.freeze({ role: tier, modelId: resolution.model.identity.upstreamModelId, trace: resolution.trace });
  } catch (error) {
    if (isTierResolutionError(error)) {
      throw new ProfileActivationError(
        "tier-unavailable",
        `Tier resolution failed (${error.code}: ${providerName}/${tier})`,
        undefined,
        error.code,
        error.causeCode,
      );
    }
    throw error;
  }
}

/**
 * Runs the deterministic model selection engine (#68) for an exact pinned
 * model, mapping typed selection failures onto the existing profile error
 * contract (`capability-rejected` plus the actionable `modelFailure` reason).
 * #70 additionally fails closed when the canonical reasoning intent cannot be
 * translated for the selected model (unsupported control or missing budget
 * policy), never silently.
 */
function selectModelForRequest(
  modelId: string,
  providerId: string,
  required: readonly CapabilityRequirement[],
  request: CanonicalRequest,
  registry: RegistryDocument = directProviderRegistry,
  effective?: EffectiveSelectionSnapshot,
  allowQuarantineBypass?: boolean,
): ModelSelectionResult {
  try {
    const reasoning = reasoningRequirementFrom(request, required);
    return selectModel({
      accessProviderId: providerId,
      exactModelId: modelId,
      requiredCapabilities: required,
      ...(reasoning === undefined ? {} : { reasoning }),
    }, registry, {
      ...(effective === undefined ? {} : { effective }),
      ...(allowQuarantineBypass === undefined ? {} : { allowQuarantineBypass }),
    });
  } catch (error) {
    if (isModelSelectionError(error)) {
      throw new ProfileActivationError(
        "capability-rejected",
        `Model selection failed (${error.code}: ${providerId}/${modelId})`,
        error.code,
      );
    }
    if (error instanceof ReasoningTranslationError) {
      throw new ProfileActivationError(
        "capability-rejected",
        `Reasoning translation failed (${error.code}: ${providerId}/${modelId})`,
        translationFailureCode(error.code),
      );
    }
    throw error;
  }
}

/**
 * #124: resolves the Effective Compatibility Registry snapshot for one request:
 * every candidate model of the access provider, feature-scoped to the exact
 * required capabilities + reasoning requirement. Returns undefined when no ECR
 * is wired (the caller then falls back to the documented seed mapping).
 */
async function effectiveSnapshotFor(
  dependencies: ProfileRouteDependencies,
  providerId: string,
  required: readonly CapabilityRequirement[],
  request: CanonicalRequest,
  registry: RegistryDocument,
): Promise<EffectiveSelectionSnapshot | undefined> {
  const compatibility = dependencies.compatibility;
  if (compatibility === undefined) return undefined;
  const rows = modelsForProvider(registry, providerId);
  const features = requiredFeaturesForCapabilities(required, reasoningRequirementFrom(request, required));
  return compatibility.snapshotForModels(rows, () => features, { required: false });
}

/**
 * #124: per-feature effective answers for the SELECTED model, extracted from
 * the request's ECR snapshot (logicalId → per-feature EffectiveCompatibility).
 * The decision records only the summary label + enforcement per feature —
 * never the claim stores' internal records.
 */
function effectiveFeatureAnswers(
  snapshot: EffectiveSelectionSnapshot,
  logicalId: string,
): Readonly<Record<string, Readonly<{ effective: EffectiveCompatibilityLabel; enforcement: EffectiveEnforcement }>>> | undefined {
  const perModel = snapshot.get(logicalId);
  if (perModel === undefined || perModel.size === 0) return undefined;
  const entries: [string, Readonly<{ effective: EffectiveCompatibilityLabel; enforcement: EffectiveEnforcement }>][] = [];
  for (const [feature, value] of perModel) {
    const answer: Readonly<{ effective: EffectiveCompatibilityLabel; enforcement: EffectiveEnforcement }> = Object.freeze({
      effective: value.effective,
      enforcement: value.enforcement,
    });
    entries.push([feature, answer]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

async function credentialSnapshots(
  dependencies: ProfileRouteDependencies,
  accounts: readonly AccountRecord[],
  environment: NodeJS.ProcessEnv,
): Promise<ReadonlyMap<string, CredentialSnapshot>> {
  const entries: [string, CredentialSnapshot][] = [];
  for (const account of accounts) {
    entries.push([account.credentialHandle, await snapshotForAccount(account, dependencies, environment)]);
  }
  return new Map(entries);
}

async function snapshotForAccount(
  account: AccountRecord,
  dependencies: ProfileRouteDependencies,
  environment: NodeJS.ProcessEnv,
): Promise<CredentialSnapshot> {
    const envName = envCredentialName(account.credentialHandle);
    if (envName !== undefined) {
      return { present: Boolean(environment[envName]), generation: Math.max(account.credentialGeneration, 1) };
    }
    try {
      const metadata = await dependencies.broker.prepare(account.credentialHandle);
      return {
        present: metadata.generation >= 1,
        generation: metadata.generation,
        ...(metadata.expiresAt === undefined ? {} : { expiresAt: metadata.expiresAt }),
      };
    } catch {
      return { present: false, generation: 0 };
    }
}

async function* invokeSelected(
  request: CanonicalRequest,
  route: EffectiveRoute,
  provider: ProviderRecord,
  dependencies: ProfileRouteDependencies,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): AsyncIterable<CanonicalEvent> {
  const decision = toRouteDecision(route, dependencies.configFingerprint);
  if (provider.integrationMode === "oauth" || provider.integrationMode === "bridge") {
    const scoped = provider.integrationMode === "oauth"
      ? await dependencies.broker.bind(route.credentialHandle, route.credentialGeneration)
      : await dependencies.broker.bind(route.credentialHandle, route.credentialGeneration).catch(() => undefined);
    try {
      const adapter = createProviderAdapter({
        provider,
        request: dependencies.fetch ?? fetch,
        environment,
        ...(scoped === undefined ? {} : {
          accessToken: scoped.accessToken,
          ...(scoped.accountId === undefined ? {} : { accountId: scoped.accountId }),
        }),
      });
      yield* adapter.invoke(request, decision, signal);
    } finally {
      scoped?.dispose();
    }
    return;
  }
  const envName = envCredentialName(route.credentialHandle);
  const envDecision = envName === undefined
    ? decision
    : { ...decision, credentialRef: parseCredentialRef(`env:${envName}`) };
  const adapter = createProviderAdapter({ provider, request: dependencies.fetch ?? fetch, environment });
  yield* adapter.invoke(request, envDecision, signal);
}

/**
 * #J2 contract A: overlays the session's FROZEN binding (profile model
 * roles/policy, provider→pool execution target, provider config) onto the
 * LIVE policy revision. The overlay is authoritative for profile/pool/
 * provider resolution; accounts (state/readiness/credentials) and the ECR
 * stay live so revocations, pauses, and quarantines apply immediately. The
 * returned revision keeps the live `revision`/`hash` (the base policy the
 * session started from) while profile-route routing consumes the frozen
 * targets — a mid-session edit, rename, or removal of the profile/pool/
 * provider can never silently change an active session's model or execution
 * target.
 */
function applySessionBinding(policy: PolicyRevision, session: LaunchSession): PolicyRevision {
  const binding = session.binding;
  const frozenProfile: ProfileRecord = {
    id: binding.profile.id,
    name: binding.profile.name,
    harness: binding.profile.harness,
    providerId: binding.pool.providerId,
    poolId: binding.pool.id,
    modelRoles: binding.profile.modelRoles,
    capabilityPolicy: binding.profile.capabilityPolicy,
    launchPolicy: binding.profile.launchPolicy,
    version: 0,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
  const frozenPool: PoolRecord = {
    id: binding.pool.id,
    name: binding.pool.name,
    providerId: binding.pool.providerId,
    strategy: binding.pool.strategy as PoolStrategy,
    affinity: binding.pool.affinity,
    retryBudget: binding.pool.retryBudget,
    memberships: binding.pool.memberships.map((membership) => ({ poolId: binding.pool.id, accountId: membership.accountId, pinOrder: undefined })),
    version: 0,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
  const frozenProvider: ProviderRecord = {
    id: binding.provider.id,
    name: binding.provider.name,
    integrationMode: binding.provider.integrationMode,
    endpointPolicy: binding.provider.endpointPolicy,
    capabilityEvidence: undefined,
    requiredTermsRevision: undefined,
    provenanceRef: undefined,
    enabled: binding.provider.enabled,
    version: 0,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
  const upsert = <T extends { id: string }>(items: readonly T[], frozen: T): readonly T[] => [
    ...items.filter((item) => item.id !== frozen.id),
    frozen,
  ];
  return Object.freeze({
    ...policy,
    snapshot: Object.freeze({
      ...policy.snapshot,
      profiles: upsert(policy.snapshot.profiles, frozenProfile),
      pools: upsert(policy.snapshot.pools, frozenPool),
      providers: upsert(policy.snapshot.providers, frozenProvider),
    }),
  });
}
