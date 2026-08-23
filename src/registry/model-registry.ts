import { z } from "zod";
import type {
  CapabilityRequirement,
  ProviderCapabilities,
  ReasoningCapabilityEvidence,
  TokenCountingQuality,
} from "../core/capabilities.js";
import { missingCapabilities } from "../core/capabilities.js";
import type { RouteRecord } from "../core/router.js";
import type { GatewayConfig } from "../config/schema.js";
import { parseCredentialRef } from "../credentials/credential-ref.js";
import { helperRoleFor } from "../profiles/helper-map.js";

/** Classification metadata only. Never a credential, route, or account key. */
export type ModelIdentity = Readonly<{
  accessProviderId: string;
  upstreamModelId: string;
  modelFamily?: string;
}>;

export type ModelLimits = Readonly<{
  contextWindow?: number | undefined;
  maxOutput?: number | undefined;
}>;

/**
 * Compatibility state of one exact access path against the RLY Claude Code
 * compatibility baseline/canary (#24). Deliberately separate from raw
 * capability support: a provider may claim a feature while the access path has
 * not passed the canary matrix.
 */
export type CompatibilityState = "VERIFIED" | "EXPERIMENTAL" | "BROKEN";

export type CompatibilityEvidence = Readonly<{
  state: CompatibilityState;
  /** Tested client/baseline, e.g. `claude-code-2.1.229` or `claude-code-fake-upstream`. */
  baseline: string;
  /** Evidence reference (fixture, canary run, or test path) backing the state. */
  evidenceRef: string;
  /** When the state was last checked. */
  checkedAt: string;
  /**
   * #122: exact Compatibility Claim key (identity + feature) that backs this
   * reviewed state when it exists. Pre-revision-5 rows have no claim reference:
   * their evidence is legacy/untrusted for v2 authority decisions and can
   * never silently satisfy a stronger v2 claim. Promotion of a claim to
   * trusted registry state is owned by #124.
   */
  claimRef?: string;
}>;

export type ModelEvidence = Readonly<{
  logicalId: string;
  identity: ModelIdentity;
  verifiedAt: string;
  fixtureVersion: string;
  tokenCounting: ProviderCapabilities["tokenCounting"];
  capabilities: ProviderCapabilities;
  /** Reviewed operational limits; numeric values only when evidenced. */
  limits: ModelLimits;
  /** Structured reasoning controls sufficient for #70 translation. */
  reasoning: ReasoningCapabilityEvidence;
  /** Canary compatibility state separate from raw capability support. */
  compatibility: CompatibilityEvidence;
}>;

export type RegistryDocument = Readonly<{ registryRevision: number; models: readonly ModelEvidence[] }>;

/**
 * Current registry document schema revision. Bump whenever the trusted document
 * shape changes; older documents migrate through `migrateRegistryDocument`.
 * Revision 5 (#122) adds the optional `claimRef` (exact Compatibility Claim
 * identity) to `CompatibilityEvidence`; pre-revision-5 rows carry no claim
 * reference and are treated as legacy/untrusted for v2 authority decisions.
 */
export const MODEL_REGISTRY_REVISION = 5;

/**
 * Provider-level capability evidence stored on control-plane provider records.
 * Replaces the previous ad-hoc `unknown` so model intelligence is typed end to
 * end. `registryRevision` pins which registry schema the evidence reflects.
 */
export type ProviderCapabilityEvidence = Readonly<{
  registryRevision: number;
  providerId: string;
  evidenceRef: string;
  capabilities: ProviderCapabilities;
  reasoning: ReasoningCapabilityEvidence;
  limits: ModelLimits;
}>;

const reasoningCapabilityEvidenceSchema = z.object({
  supported: z.boolean(),
  controlKind: z.enum(["discrete-effort", "adaptive", "binary", "token-budget", "none"]),
  effortLevels: z.array(z.string()).readonly().optional(),
  adaptive: z.boolean(),
  tokenBudget: z.boolean(),
  reasoningWithTools: z.boolean(),
});

const modelLimitsSchema = z.object({
  contextWindow: z.number().int().positive().optional(),
  maxOutput: z.number().int().positive().optional(),
});

const providerCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  tools: z.boolean(),
  parallelTools: z.boolean(),
  images: z.boolean(),
  reasoning: z.boolean(),
  redactedReasoning: z.boolean(),
  structuredOutput: z.boolean(),
  tokenCounting: z.enum(["upstream", "exact-local", "conservative-estimate", "unsupported"]),
});

export const providerCapabilityEvidenceSchema = z.object({
  registryRevision: z.number().int().nonnegative(),
  providerId: z.string().min(1),
  evidenceRef: z.string().min(1),
  capabilities: providerCapabilitiesSchema,
  reasoning: reasoningCapabilityEvidenceSchema,
  limits: modelLimitsSchema,
});

function conservativeCapabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return Object.freeze({
    streaming: true,
    tools: true,
    parallelTools: false,
    images: false,
    reasoning: true,
    redactedReasoning: false,
    structuredOutput: false,
    tokenCounting: "conservative-estimate",
    ...overrides,
  });
}

/** Conservative reasoning evidence: on/off control only, no invented levels. */
function conservativeReasoning(capabilities: ProviderCapabilities): ReasoningCapabilityEvidence {
  return Object.freeze({
    supported: capabilities.reasoning,
    controlKind: capabilities.reasoning ? ("binary" as const) : ("none" as const),
    adaptive: false,
    tokenBudget: false,
    reasoningWithTools: false,
  });
}

const nvidiaNemotronCapabilities = conservativeCapabilities();
const deepSeekFlashCapabilities = conservativeCapabilities({ tools: false });
const nvidiaNemotronNanoCapabilities = conservativeCapabilities({ images: true });
const openAiGptOssCapabilities = conservativeCapabilities({ structuredOutput: true });
const codexGpt54Capabilities = conservativeCapabilities({ redactedReasoning: true });
const clineSonnet45Capabilities = conservativeCapabilities();

/** Fake-upstream Claude Code E2E evidence path for direct providers. */
const DIRECT_E2E_REF = "tests/e2e/claude-code/direct-provider.e2e.test.ts";
const CODEX_E2E_REF = "tests/e2e/claude-code/codex-oauth.e2e.test.ts";
const CLINE_E2E_REF = "tests/e2e/claude-code/cline-interop.e2e.test.ts";

/**
 * Builds one canonical reviewed evidence entry. All shipped entries carry
 * `EXPERIMENTAL` compatibility: they are backed by Claude Code fake-upstream
 * E2E evidence, not the #24 canary matrix against a real client baseline.
 */
export function reviewedModel(input: Readonly<{
  accessProviderId: string;
  upstreamModelId: string;
  modelFamily?: string;
  verifiedAt: string;
  fixtureVersion: string;
  capabilities: ProviderCapabilities;
  compatibility?: Readonly<{
    state?: CompatibilityState;
    baseline?: string;
    evidenceRef: string;
    checkedAt?: string;
    /** #122: exact Compatibility Claim key backing this reviewed state. */
    claimRef?: string;
  }>;
  limits?: ModelLimits;
  reasoning?: ReasoningCapabilityEvidence;
}>): ModelEvidence {
  const capabilities = input.capabilities;
  const compatibility = input.compatibility ?? { evidenceRef: input.fixtureVersion };
  return Object.freeze({
    logicalId: `${input.accessProviderId}/${input.upstreamModelId}`,
    identity: Object.freeze({
      accessProviderId: input.accessProviderId,
      upstreamModelId: input.upstreamModelId,
      ...(input.modelFamily === undefined ? {} : { modelFamily: input.modelFamily }),
    }),
    verifiedAt: input.verifiedAt,
    fixtureVersion: input.fixtureVersion,
    tokenCounting: capabilities.tokenCounting,
    capabilities,
    limits: Object.freeze(input.limits ?? {}),
    reasoning: input.reasoning ?? conservativeReasoning(capabilities),
    compatibility: Object.freeze({
      state: compatibility.state ?? "EXPERIMENTAL",
      baseline: compatibility.baseline ?? "claude-code-fake-upstream",
      evidenceRef: compatibility.evidenceRef,
      checkedAt: compatibility.checkedAt ?? input.verifiedAt,
      ...(compatibility.claimRef === undefined ? {} : { claimRef: compatibility.claimRef }),
    }),
  });
}

/** Reviewed evidence only. Provider probes report drift but never mutate this document. */
export const directProviderRegistry: RegistryDocument = Object.freeze({
  registryRevision: MODEL_REGISTRY_REVISION,
  models: Object.freeze([
    reviewedModel({
      accessProviderId: "openrouter", upstreamModelId: "nvidia/nemotron-3.5-lightning:free", modelFamily: "nvidia",
      verifiedAt: "2026-08-13", fixtureVersion: "openai-chat-v1", capabilities: nvidiaNemotronCapabilities,
      compatibility: { evidenceRef: DIRECT_E2E_REF },
    }),
    reviewedModel({
      accessProviderId: "openrouter", upstreamModelId: "nvidia/nemotron-nano-12b-v2-vl:free", modelFamily: "nvidia",
      verifiedAt: "2026-08-13", fixtureVersion: "openai-chat-v1", capabilities: nvidiaNemotronNanoCapabilities,
      compatibility: { evidenceRef: DIRECT_E2E_REF },
    }),
    reviewedModel({
      accessProviderId: "openrouter", upstreamModelId: "openai/gpt-oss-20b:free", modelFamily: "openai",
      verifiedAt: "2026-08-13", fixtureVersion: "openai-chat-v1", capabilities: openAiGptOssCapabilities,
      compatibility: { evidenceRef: DIRECT_E2E_REF },
    }),
    reviewedModel({
      accessProviderId: "openrouter",
      upstreamModelId: "deepseek/deepseek-v4-flash-0731",
      modelFamily: "deepseek",
      verifiedAt: "2026-08-19",
      fixtureVersion: "openai-chat-v1",
      capabilities: conservativeCapabilities(),
      // Catalog model.context_length (2026-08-19). Not top_provider.context_length.
      limits: { contextWindow: 1_310_720, maxOutput: 393_216 },
      compatibility: { evidenceRef: "catalog:openrouter/2026-08-19/deepseek-v4-flash-0731" },
    }),
    reviewedModel({
      accessProviderId: "deepseek", upstreamModelId: "deepseek-v4-flash", modelFamily: "deepseek",
      verifiedAt: "2026-08-13", fixtureVersion: "openai-chat-v1", capabilities: deepSeekFlashCapabilities,
      compatibility: { evidenceRef: DIRECT_E2E_REF },
    }),
    reviewedModel({
      accessProviderId: "codex", upstreamModelId: "gpt-5.4", modelFamily: "openai/codex",
      verifiedAt: "2026-08-14", fixtureVersion: "codex-oauth-chat-v1", capabilities: codexGpt54Capabilities,
      compatibility: { evidenceRef: CODEX_E2E_REF },
    }),
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "claude-sonnet-4-5", modelFamily: "anthropic",
      verifiedAt: "2026-08-14", fixtureVersion: "cline-interop-chat-v1", capabilities: clineSonnet45Capabilities,
      compatibility: { evidenceRef: CLINE_E2E_REF },
    }),
    // ClinePass aggregator tier fixtures (#69): one access provider exposing
    // several upstream families at once. Same canonical shape; family is
    // classification metadata only. These rows back the owner-approved tier
    // fixtures (Terra-parent → Sol, DeepSeek Flash → Pro, Anthropic family).
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "gpt-5.6-terra", modelFamily: "openai/codex",
      verifiedAt: "2026-08-21", fixtureVersion: "cline-interop-chat-v1", capabilities: clineSonnet45Capabilities,
      compatibility: { evidenceRef: CLINE_E2E_REF },
    }),
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "gpt-5.6-sol", modelFamily: "openai/codex",
      verifiedAt: "2026-08-21", fixtureVersion: "cline-interop-chat-v1", capabilities: clineSonnet45Capabilities,
      compatibility: { evidenceRef: CLINE_E2E_REF },
    }),
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "deepseek-v4-pro", modelFamily: "deepseek",
      verifiedAt: "2026-08-21", fixtureVersion: "cline-interop-chat-v1", capabilities: conservativeCapabilities({ tools: false }),
      compatibility: { evidenceRef: CLINE_E2E_REF },
    }),
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "claude-opus-4-8", modelFamily: "anthropic",
      verifiedAt: "2026-08-21", fixtureVersion: "cline-interop-chat-v1", capabilities: clineSonnet45Capabilities,
      compatibility: { evidenceRef: CLINE_E2E_REF },
    }),
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "claude-fable", modelFamily: "anthropic",
      verifiedAt: "2026-08-21", fixtureVersion: "cline-interop-chat-v1", capabilities: clineSonnet45Capabilities,
      compatibility: { evidenceRef: CLINE_E2E_REF },
    }),
  ]),
});

/** Exact `(providerId, modelId)` evidence only. Never match another provider by upstream id. */
export function findModelEvidence(registry: RegistryDocument, providerId: string, modelId: string): ModelEvidence | undefined {
  return registry.models.find((model) => model.logicalId === `${providerId}/${modelId}`);
}

/** Models available for one access provider. Deterministic document order; no account or credential access. */
export function modelsForProvider(registry: RegistryDocument, providerId: string): readonly ModelEvidence[] {
  return registry.models.filter((model) => model.identity.accessProviderId === providerId);
}

/** Models classified into one upstream/model family. Classification metadata only. */
export function modelsForFamily(registry: RegistryDocument, modelFamily: string): readonly ModelEvidence[] {
  return registry.models.filter((model) => model.identity.modelFamily === modelFamily);
}

export type CapabilityPredicate = (capabilities: ProviderCapabilities) => boolean;

/** Models whose capability evidence satisfies a predicate. Deterministic document order. */
export function modelsSatisfying(registry: RegistryDocument, predicate: CapabilityPredicate): readonly ModelEvidence[] {
  return registry.models.filter((model) => predicate(model.capabilities));
}

/** Models that prove every required protocol capability. Reuses `missingCapabilities` (no DEFAULT_CAPABILITIES fallback). */
export function modelsRequiringCapabilities(
  registry: RegistryDocument,
  required: readonly CapabilityRequirement[],
): readonly ModelEvidence[] {
  return registry.models.filter((model) => missingCapabilities(model.capabilities, required).length === 0);
}

/** Models with a compatibility state in the accepted set. Canary state, separate from raw capability support. */
export function modelsWithCompatibility(
  registry: RegistryDocument,
  state: CompatibilityState | readonly CompatibilityState[],
): readonly ModelEvidence[] {
  const accepted = new Set(typeof state === "string" ? [state] : state);
  return registry.models.filter((model) => accepted.has(model.compatibility.state));
}

/** Config selects an evidence-backed route; unknown models have no route. */
export function routesFromConfig(config: GatewayConfig, registry: RegistryDocument = directProviderRegistry): ReadonlyMap<string, RouteRecord> {
  const records: [string, RouteRecord][] = [];
  for (const [role, route] of Object.entries(config.routes)) {
    if (route === undefined) continue;
    const evidence = findModelEvidence(registry, route.provider, route.model);
    if (!evidence) continue;
    records.push([role, Object.freeze({
      role,
      providerId: route.provider,
      modelId: route.model,
      adapterId: `${route.provider}-direct`,
      credentialRef: Object.freeze(parseCredentialRef(route.credential)),
      capabilities: Object.freeze({ ...evidence.capabilities }),
      reasoningEvidence: evidence.reasoning,
    })]);
  }
  return new Map(records);
}

export function resolveConfiguredRoute(routes: ReadonlyMap<string, RouteRecord>, requestedModel: string): RouteRecord | undefined {
  const explicit = routes.get(requestedModel) ?? [...routes.values()].find((route) => route.modelId === requestedModel);
  if (explicit) return explicit;
  const helperRole = helperRoleFor(requestedModel);
  if (helperRole) return routes.get(helperRole);
  return undefined;
}

// ---------------------------------------------------------------------------
// Discovery / proposal boundary (#23)
// Provider adapters and catalog sources report what they observe. Discovery
// results are untrusted/proposed until reviewed; they never mutate the trusted
// reviewed registry document in place.
// ---------------------------------------------------------------------------

export type DiscoveryCandidate = Readonly<{
  accessProviderId: string;
  upstreamModelId: string;
  modelFamily?: string;
  observedLimits?: ModelLimits;
  /**
   * Provider-reported (declared) metadata. Discovered only, never trusted:
   * a provider claim does not become runtime capability evidence until a
   * reviewed/canary promotion (#23, #24).
   */
  declared?: Readonly<{
    tools?: boolean;
    reasoning?: boolean;
    contextWindow?: number;
    maxOutput?: number;
  }>;
}>;

export type DiscoverySnapshot = Readonly<{
  /** Adapter/catalog source identifier. */
  source: string;
  discoveredAt: string;
  /** Catalogue source version when the adapter provides one (e.g. provider endpoint revision). */
  catalogueVersion?: string;
  models: readonly DiscoveryCandidate[];
}>;

export type ProposedCandidate = Readonly<{
  identity: ModelIdentity;
  proposedAt: string;
  reason: "no-exact-evidence";
  observedLimits?: ModelLimits;
}>;

export type RegistryProposal = Readonly<{
  known: readonly ModelEvidence[];
  proposed: readonly ProposedCandidate[];
}>;

/**
 * Diffs a discovery snapshot against reviewed evidence. Exact known access
 * paths are returned as `known` evidence; everything else is returned as a
 * `proposed` candidate for the #23 propose-only review workflow. Never writes
 * to or mutates the trusted registry.
 */
export function proposeRegistryChanges(
  snapshot: DiscoverySnapshot,
  registry: RegistryDocument = directProviderRegistry,
): RegistryProposal {
  const known: ModelEvidence[] = [];
  const proposed: ProposedCandidate[] = [];
  for (const candidate of snapshot.models) {
    const evidence = findModelEvidence(registry, candidate.accessProviderId, candidate.upstreamModelId);
    if (evidence) {
      known.push(evidence);
      continue;
    }
    proposed.push(Object.freeze({
      identity: Object.freeze({
        accessProviderId: candidate.accessProviderId,
        upstreamModelId: candidate.upstreamModelId,
        ...(candidate.modelFamily === undefined ? {} : { modelFamily: candidate.modelFamily }),
      }),
      proposedAt: snapshot.discoveredAt,
      reason: "no-exact-evidence" as const,
      ...(candidate.observedLimits === undefined ? {} : { observedLimits: Object.freeze(candidate.observedLimits) }),
    }));
  }
  return Object.freeze({ known: Object.freeze(known), proposed: Object.freeze(proposed) });
}

// ---------------------------------------------------------------------------
// Migration path
// Older/static registry documents (pre-revision 4) upgrade through this
// function; downstream code never casts model intelligence from `unknown`.
// ---------------------------------------------------------------------------

export type LegacyModelEvidence = Readonly<{
  logicalId: string;
  upstreamId: string;
  verifiedAt: string;
  fixtureVersion: string;
  tokenCounting: TokenCountingQuality;
  capabilities: ProviderCapabilities;
}>;

export type LegacyRegistryDocument = Readonly<{ registryRevision: number; models: readonly LegacyModelEvidence[] }>;

/**
 * Upgrades a legacy registry document to the current canonical shape. The
 * legacy `logicalId` encodes the access provider (`<provider>/<model>`), which
 * is preserved as `identity.accessProviderId`; `modelFamily` is unknown for
 * legacy entries and stays undefined rather than guessed. Compatibility state
 * is conservatively `EXPERIMENTAL` because no #24 canary evidence existed in
 * the legacy shape; pre-revision-5 legacy rows carry no `claimRef` and are
 * untrusted for v2 claim authority. A migrated document is not a replacement
 * for a reviewed re-validation; it only carries the evidence the legacy entry
 * already had.
 */
export function migrateRegistryDocument(
  document: LegacyRegistryDocument,
  revision: number = MODEL_REGISTRY_REVISION,
): RegistryDocument {
  return Object.freeze({
    registryRevision: revision,
    models: Object.freeze(document.models.map((model) => {
      const sep = model.logicalId.indexOf("/");
      const accessProviderId = sep === -1 ? model.logicalId : model.logicalId.slice(0, sep);
      const capabilities = model.capabilities;
      return Object.freeze({
        logicalId: model.logicalId,
        identity: Object.freeze({
          accessProviderId,
          upstreamModelId: model.upstreamId,
        }),
        verifiedAt: model.verifiedAt,
        fixtureVersion: model.fixtureVersion,
        tokenCounting: model.tokenCounting,
        capabilities,
        limits: Object.freeze({}),
        reasoning: conservativeReasoning(capabilities),
        compatibility: Object.freeze({
          state: "EXPERIMENTAL",
          baseline: "claude-code-fake-upstream",
          evidenceRef: model.fixtureVersion,
          checkedAt: model.verifiedAt,
        }),
      });
    })),
  });
}
