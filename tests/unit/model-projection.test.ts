import { describe, expect, it } from "vitest";
import type { ProviderCapabilities } from "../../src/core/capabilities.js";
import type { PolicyRevision, ProfileRecord, ProviderRecord } from "../../src/control-plane/types.js";
import {
  MODEL_REGISTRY_REVISION,
  directProviderRegistry,
  findModelEvidence,
  reviewedModel,
  type RegistryDocument,
} from "../../src/registry/model-registry.js";
import {
  compileModelUniverseSnapshot,
  createModelProjectionTrace,
  humanizeModelId,
  projectModelUniverse,
  projectionFor,
  projectionIdFor,
  providerDisplayName,
  resolveProjection,
} from "../../src/routing/model-projection/project.js";
import { isProjectionId, RLY_MODEL_PREFIX, type ModelProjection } from "../../src/routing/model-projection/types.js";

function capabilities(): ProviderCapabilities {
  return Object.freeze({
    streaming: true,
    tools: true,
    parallelTools: false,
    images: false,
    reasoning: true,
    redactedReasoning: false,
    structuredOutput: false,
    tokenCounting: "conservative-estimate",
  });
}

const VERIFIED = Object.freeze({ state: "VERIFIED" as const, baseline: "claude-code-2.1.229", evidenceRef: "verify-1", checkedAt: "2026-08-21" });
const EXPERIMENTAL = Object.freeze({ state: "EXPERIMENTAL" as const, baseline: "claude-code-fake-upstream", evidenceRef: "e2e-1", checkedAt: "2026-08-21" });
const BROKEN = Object.freeze({ state: "BROKEN" as const, baseline: "claude-code-2.1.229", evidenceRef: "canary-9", checkedAt: "2026-08-21" });

const registry: RegistryDocument = Object.freeze({
  registryRevision: MODEL_REGISTRY_REVISION,
  models: Object.freeze([
    reviewedModel({
      accessProviderId: "codex", upstreamModelId: "gpt-5.6-sol", modelFamily: "openai/codex",
      verifiedAt: "2026-08-21", fixtureVersion: "codex-oauth-chat-v1", capabilities: capabilities(),
      compatibility: VERIFIED,
    }),
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "gpt-5.6-sol", modelFamily: "openai/codex",
      verifiedAt: "2026-08-21", fixtureVersion: "cline-interop-chat-v1", capabilities: capabilities(),
      compatibility: VERIFIED,
    }),
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "deepseek-v4-pro", modelFamily: "deepseek",
      verifiedAt: "2026-08-21", fixtureVersion: "cline-interop-chat-v1", capabilities: capabilities(),
      compatibility: VERIFIED,
    }),
    reviewedModel({
      accessProviderId: "deepseek", upstreamModelId: "deepseek-v4-pro", modelFamily: "deepseek",
      verifiedAt: "2026-08-21", fixtureVersion: "openai-chat-v1", capabilities: capabilities(),
      compatibility: EXPERIMENTAL,
    }),
    reviewedModel({
      accessProviderId: "deepseek", upstreamModelId: "deepseek-v4-flash", modelFamily: "deepseek",
      verifiedAt: "2026-08-21", fixtureVersion: "openai-chat-v1", capabilities: capabilities(),
      compatibility: BROKEN,
    }),
  ]),
});

function provider(id: string, name: string, enabled = true): ProviderRecord {
  return Object.freeze({
    id, name, integrationMode: "oauth", endpointPolicy: "http://127.0.0.1:0", capabilityEvidence: undefined,
    requiredTermsRevision: undefined, provenanceRef: undefined, enabled, version: 1, createdAt: "2026-08-21", updatedAt: "2026-08-21",
  });
}

function policy(input: Readonly<{
  providers: ProviderRecord[];
  pools: PolicyRevision["snapshot"]["pools"];
  accounts: PolicyRevision["snapshot"]["accounts"];
  profiles: PolicyRevision["snapshot"]["profiles"];
  revision?: number;
}>): PolicyRevision {
  return Object.freeze({
    revision: input.revision ?? 7,
    hash: "policy-hash",
    createdAt: "2026-08-21",
    snapshot: Object.freeze({
      providers: Object.freeze(input.providers),
      accounts: Object.freeze(input.accounts),
      pools: Object.freeze(input.pools),
      profiles: Object.freeze(input.profiles),
    }),
  });
}

function account(id: string, providerId: string, state: "ready" | "paused" | "unready" = "ready") {
  return Object.freeze({
    id, pseudonym: `acct-${id}`, providerId, credentialHandle: `handle-${id}`, credentialGeneration: 1,
    state, pauseReason: undefined, quotaClass: "unknown", cooldownUntil: undefined, termsRevision: undefined,
    termsAcknowledgedRevision: undefined, version: 1, createdAt: "2026-08-21", updatedAt: "2026-08-21",
  });
}

function pool(id: string, providerId: string, accountIds: readonly string[]) {
  return Object.freeze({
    id, name: `pool-${id}`, providerId, strategy: "fill-first" as const, affinity: undefined,
    retryBudget: 1, memberships: Object.freeze(accountIds.map((accountId) => Object.freeze({ poolId: id, accountId, pinOrder: undefined }))),
    version: 1, createdAt: "2026-08-21", updatedAt: "2026-08-21",
  });
}

function profile(input: Readonly<{ name: string; poolId: string; providerId?: string }>): ProfileRecord {
  return Object.freeze({
    id: `profile-${input.name}`, name: input.name, harness: "claude", providerId: input.providerId, poolId: input.poolId,
    modelRoles: Object.freeze({ primary: "gpt-5.6-sol", fast: "gpt-5.6-sol", reasoning: "gpt-5.6-sol" }),
    capabilityPolicy: undefined, launchPolicy: undefined, version: 1, createdAt: "2026-08-21", updatedAt: "2026-08-21",
  });
}

const codexProvider = provider("p-codex", "codex");
const clineProvider = provider("p-cline", "cline");
const deepseekProvider = provider("p-deepseek", "deepseek");
const codexPool = pool("pool-codex", "p-codex", ["a-codex"]);
const clinePool = pool("pool-cline", "p-cline", ["a-cline"]);
const deepseekPool = pool("pool-deepseek", "p-deepseek", ["a-deepseek"]);
const codexAccount = account("a-codex", "p-codex");
const clineAccount = account("a-cline", "p-cline");
const deepseekAccount = account("a-deepseek", "p-deepseek");

const multiProviderPolicy = policy({
  providers: [codexProvider, clineProvider, deepseekProvider],
  pools: [codexPool, clinePool, deepseekPool],
  accounts: [codexAccount, clineAccount, deepseekAccount],
  profiles: [profile({ name: "work", poolId: "pool-codex", providerId: "p-codex" })],
});

describe("model projection ids", () => {
  it("uses the Claude-compatible prefix and a stable provider-scoped key", () => {
    const id = projectionIdFor("codex", "gpt-5.6-sol");
    expect(id.startsWith(`${RLY_MODEL_PREFIX}codex-`)).toBe(true);
    expect(isProjectionId(id)).toBe(true);
    // Deterministic.
    expect(projectionIdFor("codex", "gpt-5.6-sol")).toBe(id);
    // Same upstream model through two providers => distinct ids.
    expect(projectionIdFor("cline", "gpt-5.6-sol")).not.toBe(id);
  });

  it("never lets a non-projection model id be treated as one", () => {
    expect(isProjectionId("claude-sonnet-4-5")).toBe(false);
    expect(isProjectionId("rly/codex/gpt-5.6-sol")).toBe(false);
    expect(isProjectionId("anthropic-foo")).toBe(false);
  });

  it("humanizes presentation labels deterministically", () => {
    expect(humanizeModelId("gpt-5.6-sol")).toBe("GPT 5.6 Sol");
    expect(humanizeModelId("deepseek-v4-pro")).toBe("Deepseek V4 Pro");
    expect(providerDisplayName("cline")).toBe("ClinePass");
    expect(providerDisplayName("codex")).toBe("Codex");
  });
});

describe("projection limits", () => {
  it("copies numeric registry limits onto the projection and omits empty limits", () => {
    const evidence = findModelEvidence(directProviderRegistry, "openrouter", "deepseek/deepseek-v4-flash-0731");
    if (evidence === undefined) throw new Error("missing OpenRouter DeepSeek V4 Flash 0731 evidence");
    const binding = Object.freeze({ providerId: "p-or", providerName: "openrouter", poolId: "pool-or" });
    const projection = projectionFor(binding, evidence);
    expect(projection.contextWindow).toBe(1_310_720);
    expect(projection.maxOutput).toBe(393_216);
    expect(projection.displayName).toBe("DeepSeek V4 Flash 0731 (OpenRouter)");

    const unlimited = findModelEvidence(directProviderRegistry, "openrouter", "nvidia/nemotron-3.5-lightning:free");
    if (unlimited === undefined) throw new Error("missing OpenRouter Nemotron evidence");
    const bare = projectionFor(binding, unlimited);
    expect(bare).not.toHaveProperty("contextWindow");
    expect(bare).not.toHaveProperty("maxOutput");
  });
});

describe("model universe projection", () => {
  it("projects VERIFIED models from every pinned binding and nothing else", () => {
    const snapshot = compileModelUniverseSnapshot(multiProviderPolicy, registry, {
      profile: profile({ name: "work", poolId: "pool-codex", providerId: "p-codex" }),
    });
    expect(snapshot.policyRevision).toBe(7);
    expect(snapshot.registryRevision).toBe(MODEL_REGISTRY_REVISION);
    expect(snapshot.bindings.map((binding) => binding.providerName)).toEqual(["cline", "codex", "deepseek"]);
    const projections = projectModelUniverse(registry, snapshot);
    const ids = projections.map((entry) => entry.id);
    // Same upstream model through two providers => two distinct selectable targets.
    const solIds = projections.filter((entry) => entry.upstreamModelId === "gpt-5.6-sol");
    expect(solIds).toHaveLength(2);
    expect(solIds.map((entry) => entry.displayName).sort()).toEqual([
      "GPT-5.6 Sol (ClinePass)",
      "GPT-5.6 Sol (Codex)",
    ]);
    // BROKEN never projected; EXPERIMENTAL excluded by default policy (the
    // deepseek provider has only EXPERIMENTAL/BROKEN evidence, so it is absent).
    expect(projections.some((entry) => entry.upstreamModelId === "deepseek-v4-flash")).toBe(false);
    expect(projections.some((entry) => entry.providerName === "deepseek")).toBe(false);
    expect(new Set(ids).size).toBe(ids.length);
    // Deterministic: identical inputs produce identical catalogues.
    expect(projectModelUniverse(registry, snapshot).map((entry) => entry.id)).toEqual(ids);
    // Every discoverable id satisfies the Claude Code discovery filter.
    for (const id of ids) expect(id.startsWith("claude") || id.startsWith("anthropic")).toBe(true);
  });

  it("exposes EXPERIMENTAL models only through the explicit opt-in", () => {
    const snapshot = compileModelUniverseSnapshot(multiProviderPolicy, registry, {
      experimentalModels: true,
    });
    const projections = projectModelUniverse(registry, snapshot);
    const proIds = projections.filter((entry) => entry.upstreamModelId === "deepseek-v4-pro");
    expect(proIds.map((entry) => entry.providerName).sort()).toEqual(["cline", "deepseek"]);
    // BROKEN is never projected even with the opt-in.
    expect(projections.some((entry) => entry.upstreamModelId === "deepseek-v4-flash")).toBe(false);
  });

  it("pins bindings deterministically: profile pool + single-default-pool providers only", () => {
    // deepseek has two pools => no explicit profile binding => excluded.
    const secondDeepseekPool = pool("pool-deepseek-2", "p-deepseek", ["a-deepseek"]);
    const policyWithTwoDeepseekPools = policy({
      providers: [codexProvider, clineProvider, deepseekProvider],
      pools: [codexPool, clinePool, deepseekPool, secondDeepseekPool],
      accounts: [codexAccount, clineAccount, deepseekAccount],
      profiles: [profile({ name: "work", poolId: "pool-codex", providerId: "p-codex" })],
    });
    const snapshot = compileModelUniverseSnapshot(policyWithTwoDeepseekPools, registry, {
      profile: profile({ name: "work", poolId: "pool-codex", providerId: "p-codex" }),
    });
    expect(snapshot.bindings.map((binding) => binding.providerName)).toEqual(["cline", "codex"]);
  });

  it("excludes providers with no ready accounts or disabled providers", () => {
    const pausedPolicy = policy({
      providers: [codexProvider, clineProvider, deepseekProvider],
      pools: [codexPool, clinePool, deepseekPool],
      accounts: [account("a-codex", "p-codex"), account("a-cline", "p-cline", "paused"), deepseekAccount],
      profiles: [profile({ name: "work", poolId: "pool-codex", providerId: "p-codex" })],
    });
    const snapshot = compileModelUniverseSnapshot(pausedPolicy, registry, {
      profile: profile({ name: "work", poolId: "pool-codex", providerId: "p-codex" }),
    });
    expect(snapshot.bindings.map((binding) => binding.providerName)).toEqual(["codex", "deepseek"]);

    const disabledPolicy = policy({
      providers: [codexProvider, provider("p-cline", "cline", false), deepseekProvider],
      pools: [codexPool, clinePool, deepseekPool],
      accounts: [codexAccount, clineAccount, deepseekAccount],
      profiles: [profile({ name: "work", poolId: "pool-codex", providerId: "p-codex" })],
    });
    const disabledSnapshot = compileModelUniverseSnapshot(disabledPolicy, registry, {
      profile: profile({ name: "work", poolId: "pool-codex", providerId: "p-codex" }),
    });
    expect(disabledSnapshot.bindings.map((binding) => binding.providerName)).toEqual(["codex", "deepseek"]);
  });

  it("excludes env accounts that are missing credentials or terms", () => {
    const openrouter = Object.freeze({
      ...provider("p-or", "openrouter"),
      integrationMode: "direct" as const,
      requiredTermsRevision: "terms-1",
    });
    const envAccount = Object.freeze({
      ...account("a-or", "p-or"),
      credentialHandle: "env:OPENROUTER_API_KEY",
    });
    const envPool = pool("pool-or", "p-or", ["a-or"]);
    const envPolicy = policy({
      providers: [codexProvider, openrouter],
      pools: [codexPool, envPool],
      accounts: [codexAccount, envAccount],
      profiles: [profile({ name: "work", poolId: "pool-or", providerId: "p-or" })],
    });
    const missing = compileModelUniverseSnapshot(envPolicy, registry, {
      profile: profile({ name: "work", poolId: "pool-or", providerId: "p-or" }),
      environment: {},
    });
    expect(missing.bindings.map((binding) => binding.providerName)).toEqual(["codex"]);
    const presentUnacked = compileModelUniverseSnapshot(envPolicy, registry, {
      profile: profile({ name: "work", poolId: "pool-or", providerId: "p-or" }),
      environment: { OPENROUTER_API_KEY: "fixture-key" },
    });
    expect(presentUnacked.bindings.map((binding) => binding.providerName)).toEqual(["codex"]);
    const ackedAccount = Object.freeze({ ...envAccount, termsAcknowledgedRevision: "terms-1" });
    const ackedPolicy = policy({
      providers: [codexProvider, openrouter],
      pools: [codexPool, envPool],
      accounts: [codexAccount, ackedAccount],
      profiles: [profile({ name: "work", poolId: "pool-or", providerId: "p-or" })],
    });
    const runnable = compileModelUniverseSnapshot(ackedPolicy, registry, {
      profile: profile({ name: "work", poolId: "pool-or", providerId: "p-or" }),
      environment: { OPENROUTER_API_KEY: "fixture-key" },
    });
    expect(runnable.bindings.map((binding) => binding.providerName)).toEqual(["codex", "openrouter"]);
  });

  it("compiles the same universe without a profile (instance-token surface)", () => {
    const snapshot = compileModelUniverseSnapshot(multiProviderPolicy, registry);
    expect(snapshot.bindings.map((binding) => binding.providerName)).toEqual(["cline", "codex", "deepseek"]);
  });
});

function requireProjection(rows: readonly ModelProjection[], providerName: string, modelId: string) {
  const entry = rows.find((item) => item.providerName === providerName && item.upstreamModelId === modelId);
  if (entry === undefined) throw new Error(`missing projection ${providerName}/${modelId}`);
  return entry;
}

describe("reverse projection mapping", () => {
  it("resolves a projection id to one exact evidence target and pinned pool", () => {
    const snapshot = compileModelUniverseSnapshot(multiProviderPolicy, registry, {
      profile: profile({ name: "work", poolId: "pool-codex", providerId: "p-codex" }),
    });
    const projections = projectModelUniverse(registry, snapshot);
    const codexSol = requireProjection(projections, "codex", "gpt-5.6-sol");
    const clineSol = requireProjection(projections, "cline", "gpt-5.6-sol");
    const resolvedCodex = resolveProjection(codexSol.id, snapshot, registry);
    expect(resolvedCodex?.binding.poolId).toBe("pool-codex");
    expect(resolvedCodex?.evidence.identity.upstreamModelId).toBe("gpt-5.6-sol");
    const resolvedCline = resolveProjection(clineSol.id, snapshot, registry);
    expect(resolvedCline?.binding.poolId).toBe("pool-cline");
    // The same id always resolves to the same canonical target.
    expect(resolveProjection(codexSol.id, snapshot, registry)?.evidence.logicalId)
      .toBe(resolvedCodex?.evidence.logicalId);
  });

  it("fails closed for unknown, removed, or ineligible projection ids", () => {
    const snapshot = compileModelUniverseSnapshot(multiProviderPolicy, registry, {
      profile: profile({ name: "work", poolId: "pool-codex", providerId: "p-codex" }),
    });
    expect(resolveProjection(`${RLY_MODEL_PREFIX}codex-000000000000`, snapshot, registry)).toBeUndefined();
    expect(resolveProjection("claude-sonnet-4-5", snapshot, registry)).toBeUndefined();
    // A BROKEN model is never discoverable, so its projection never resolves.
    const brokenId = projectionIdFor("deepseek", "deepseek-v4-flash");
    expect(resolveProjection(brokenId, snapshot, registry)).toBeUndefined();
    // EXPERIMENTAL without the opt-in is not discoverable either.
    const experimentalId = projectionIdFor("deepseek", "deepseek-v4-pro");
    expect(resolveProjection(experimentalId, snapshot, registry)).toBeUndefined();
  });

  it("does not silently remap when a model is removed from the registry", () => {
    const snapshot = compileModelUniverseSnapshot(multiProviderPolicy, registry, {
      profile: profile({ name: "work", poolId: "pool-codex", providerId: "p-codex" }),
    });
    const codexSol = requireProjection(projectModelUniverse(registry, snapshot), "codex", "gpt-5.6-sol");
    const registryWithoutSol: RegistryDocument = Object.freeze({
      registryRevision: MODEL_REGISTRY_REVISION + 1,
      models: Object.freeze(registry.models.filter((entry) => entry.identity.upstreamModelId !== "gpt-5.6-sol")),
    });
    // The projection id no longer resolves: explicit failure, never a substitute.
    expect(resolveProjection(codexSol.id, snapshot, registryWithoutSol)).toBeUndefined();
  });

  it("builds a secret-free projection trace for diagnostics", () => {
    const snapshot = compileModelUniverseSnapshot(multiProviderPolicy, registry, {
      profile: profile({ name: "work", poolId: "pool-codex", providerId: "p-codex" }),
    });
    const codexSol = requireProjection(projectModelUniverse(registry, snapshot), "codex", "gpt-5.6-sol");
    const trace = createModelProjectionTrace(codexSol, snapshot);
    expect(trace).toMatchObject({
      projectionId: codexSol.id,
      providerId: "p-codex",
      upstreamModelId: "gpt-5.6-sol",
      poolId: "pool-codex",
      policyRevision: 7,
      registryRevision: MODEL_REGISTRY_REVISION,
    });
    expect(JSON.stringify(trace)).not.toMatch(/token|secret|authorization|email|prompt|response|identity/i);
  });
});
