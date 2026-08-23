import { describe, expect, it } from "vitest";
import { gatewayConfigSchema } from "../../src/config/schema.js";
import {
  MODEL_REGISTRY_REVISION,
  directProviderRegistry,
  findModelEvidence,
  migrateRegistryDocument,
  modelsForFamily,
  modelsForProvider,
  modelsRequiringCapabilities,
  modelsSatisfying,
  modelsWithCompatibility,
  proposeRegistryChanges,
  providerCapabilityEvidenceSchema,
  resolveConfiguredRoute,
  reviewedModel,
  routesFromConfig,
  type LegacyRegistryDocument,
  type RegistryDocument,
} from "../../src/registry/model-registry.js";

function conservativeCapabilities(overrides: Record<string, boolean> = {}): {
  streaming: boolean; tools: boolean; parallelTools: boolean; images: boolean; reasoning: boolean; redactedReasoning: boolean; structuredOutput: boolean; tokenCounting: "conservative-estimate";
} {
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

/** One aggregator access provider exposing several upstream families at once. */
const aggregatorRegistry: RegistryDocument = Object.freeze({
  registryRevision: MODEL_REGISTRY_REVISION,
  models: Object.freeze([
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "gpt-5.6-terra", modelFamily: "openai/codex",
      verifiedAt: "2026-08-20", fixtureVersion: "cline-interop-chat-v1", capabilities: conservativeCapabilities(),
      compatibility: { state: "VERIFIED", evidenceRef: "cline-verify-1" },
    }),
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "claude-sonnet-4-5", modelFamily: "anthropic",
      verifiedAt: "2026-08-20", fixtureVersion: "cline-interop-chat-v1", capabilities: conservativeCapabilities(),
    }),
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "deepseek-v4-pro", modelFamily: "deepseek",
      verifiedAt: "2026-08-20", fixtureVersion: "cline-interop-chat-v1", capabilities: conservativeCapabilities({ tools: false }),
    }),
  ]),
});

/** Same upstream model id reachable through two access providers: separate entries. */
const sharedUpstreamRegistry: RegistryDocument = Object.freeze({
  registryRevision: MODEL_REGISTRY_REVISION,
  models: Object.freeze([
    reviewedModel({
      accessProviderId: "openrouter", upstreamModelId: "gpt-5.4", modelFamily: "openai/codex",
      verifiedAt: "2026-08-20", fixtureVersion: "openai-chat-v1", capabilities: conservativeCapabilities(),
    }),
    reviewedModel({
      accessProviderId: "codex", upstreamModelId: "gpt-5.4", modelFamily: "openai/codex",
      verifiedAt: "2026-08-20", fixtureVersion: "codex-oauth-chat-v1", capabilities: conservativeCapabilities(),
    }),
  ]),
});

describe("model registry", () => {
  it("maps explicit routes and known Claude internal models to fixed configured roles", () => {
    const config = gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17871 }, routes: { primary: { provider: "openrouter", model: "nvidia/nemotron-3.5-lightning:free", credential: "env:OPENROUTER_API_KEY" }, fast: { provider: "openrouter", model: "nvidia/nemotron-nano-12b-v2-vl:free", credential: "env:OPENROUTER_API_KEY" } } });
    const routes = routesFromConfig(config);
    expect(resolveConfiguredRoute(routes, "primary")?.modelId).toBe("nvidia/nemotron-3.5-lightning:free");
    expect(resolveConfiguredRoute(routes, "nvidia/nemotron-nano-12b-v2-vl:free")?.role).toBe("fast");
    expect(resolveConfiguredRoute(routes, "claude-haiku-4-5")?.role).toBe("fast");
    expect(resolveConfiguredRoute(routes, "claude-sonnet-5")?.role).toBe("primary");
    expect(resolveConfiguredRoute(routes, "claude-opus-4-8")?.role).toBe("primary");
    expect(resolveConfiguredRoute(routes, "claude-haiku-unknown")).toBeUndefined();
    expect(resolveConfiguredRoute(routes, "claude-sonnet-not-real")).toBeUndefined();
    expect(resolveConfiguredRoute(routes, "unknown-model")).toBeUndefined();
    expect(Object.isFrozen(routes.get("primary")?.capabilities)).toBe(true);
    const deepseek = directProviderRegistry.models.find((model) => model.logicalId === "deepseek/deepseek-v4-flash");
    expect(deepseek?.capabilities.tools).toBe(false);
    const codex = directProviderRegistry.models.find((model) => model.logicalId === "codex/gpt-5.4");
    expect(codex?.capabilities.streaming).toBe(true);
    expect(codex?.capabilities.tools).toBe(true);
    expect(codex?.capabilities.images).toBe(false);
    expect(codex?.capabilities.redactedReasoning).toBe(true);
    const cline = directProviderRegistry.models.find((model) => model.logicalId === "cline/claude-sonnet-4-5");
    expect(cline?.capabilities.streaming).toBe(true);
    expect(cline?.capabilities.tools).toBe(true);
    expect(cline?.capabilities.images).toBe(false);
  });

  it("refuses routes that lack reviewed model evidence", () => {
    const config = gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17871 }, routes: { primary: { provider: "openrouter", model: "unreviewed-model", credential: "env:OPENROUTER_API_KEY" } } });
    expect(routesFromConfig(config).size).toBe(0);
  });

  it("does not publish OpenCode Go or Alibaba TOML routes without reviewed model evidence", () => {
    const logicalIds = directProviderRegistry.models.map((model) => model.logicalId);
    expect(logicalIds.some((id) => id.startsWith("opencode-go/") || id.startsWith("alibaba/"))).toBe(false);
    const config = gatewayConfigSchema.parse({
      schemaVersion: 1,
      gateway: { port: 17871 },
      routes: {
        primary: { provider: "opencode-go", model: "go-unreviewed", credential: "env:OPENCODE_API_KEY" },
        fast: { provider: "alibaba", model: "qwen-unreviewed", credential: "env:DASHSCOPE_API_KEY" },
      },
    });
    expect(routesFromConfig(config).size).toBe(0);
  });

  it("ships an EXPERIMENTAL OpenRouter DeepSeek V4 Flash 0731 row with catalog limits", () => {
    const evidence = findModelEvidence(directProviderRegistry, "openrouter", "deepseek/deepseek-v4-flash-0731");
    expect(evidence).toBeDefined();
    expect(evidence?.compatibility.state).toBe("EXPERIMENTAL");
    expect(evidence?.compatibility.baseline).toBe("claude-code-fake-upstream");
    expect(evidence?.compatibility.evidenceRef).toBe("catalog:openrouter/2026-08-19/deepseek-v4-flash-0731");
    expect(evidence?.compatibility.claimRef).toBeUndefined();
    expect(evidence?.identity.modelFamily).toBe("deepseek");
    expect(evidence?.limits).toEqual({ contextWindow: 1_310_720, maxOutput: 393_216 });
    expect(evidence?.capabilities.streaming).toBe(true);
    expect(evidence?.capabilities.tools).toBe(true);
    const config = gatewayConfigSchema.parse({
      schemaVersion: 1,
      gateway: { port: 17871 },
      routes: { primary: { provider: "openrouter", model: "deepseek/deepseek-v4-flash-0731", credential: "env:OPENROUTER_API_KEY" } },
    });
    expect(routesFromConfig(config).get("primary")?.modelId).toBe("deepseek/deepseek-v4-flash-0731");
  });

  it("matches Codex evidence only for exact provider and model ids", () => {
    expect(findModelEvidence(directProviderRegistry, "codex", "gpt-5.4")?.logicalId).toBe("codex/gpt-5.4");
    expect(findModelEvidence(directProviderRegistry, "openrouter", "gpt-5.4")).toBeUndefined();
    expect(findModelEvidence(directProviderRegistry, "codex", "nvidia/nemotron-3.5-lightning:free")).toBeUndefined();
    expect(findModelEvidence(directProviderRegistry, "codex", "gpt-unreviewed")).toBeUndefined();
  });

  it("matches Cline evidence only for exact provider and model ids", () => {
    expect(findModelEvidence(directProviderRegistry, "cline", "claude-sonnet-4-5")?.logicalId).toBe("cline/claude-sonnet-4-5");
    expect(findModelEvidence(directProviderRegistry, "codex", "claude-sonnet-4-5")).toBeUndefined();
    expect(findModelEvidence(directProviderRegistry, "openrouter", "claude-sonnet-4-5")).toBeUndefined();
    expect(findModelEvidence(directProviderRegistry, "cline", "gpt-5.4")).toBeUndefined();
    expect(findModelEvidence(directProviderRegistry, "cline", "gpt-unreviewed")).toBeUndefined();
  });
});

describe("provider model intelligence registry", () => {
  it("distinguishes access provider, exact upstream model id, and model family", () => {
    const codex = findModelEvidence(directProviderRegistry, "codex", "gpt-5.4");
    expect(codex?.identity).toEqual({ accessProviderId: "codex", upstreamModelId: "gpt-5.4", modelFamily: "openai/codex" });
    const cline = findModelEvidence(directProviderRegistry, "cline", "claude-sonnet-4-5");
    expect(cline?.identity).toEqual({ accessProviderId: "cline", upstreamModelId: "claude-sonnet-4-5", modelFamily: "anthropic" });
    const flash = findModelEvidence(directProviderRegistry, "deepseek", "deepseek-v4-flash");
    expect(flash?.identity.modelFamily).toBe("deepseek");
    expect(flash?.logicalId).toBe("deepseek/deepseek-v4-flash");
  });

  it("keeps the same upstream model id reachable through two access providers as separate entries", () => {
    const openrouter = findModelEvidence(sharedUpstreamRegistry, "openrouter", "gpt-5.4");
    const codex = findModelEvidence(sharedUpstreamRegistry, "codex", "gpt-5.4");
    expect(openrouter?.logicalId).toBe("openrouter/gpt-5.4");
    expect(codex?.logicalId).toBe("codex/gpt-5.4");
    expect(openrouter).not.toBe(codex);
    // Exact lookup must fail closed for an access path without its own evidence,
    // even though the same upstream id exists under another provider.
    expect(findModelEvidence(sharedUpstreamRegistry, "cline", "gpt-5.4")).toBeUndefined();
  });

  it("represents one aggregator provider across multiple model families without extra provider records", () => {
    const clineModels = modelsForProvider(aggregatorRegistry, "cline");
    expect(clineModels).toHaveLength(3);
    expect(new Set(clineModels.map((model) => model.identity.modelFamily))).toEqual(new Set(["openai/codex", "anthropic", "deepseek"]));
    expect(new Set(clineModels.map((model) => model.logicalId))).toEqual(new Set(["cline/gpt-5.6-terra", "cline/claude-sonnet-4-5", "cline/deepseek-v4-pro"]));
    // Family scope is classification metadata, not a provider route.
    expect(modelsForFamily(aggregatorRegistry, "deepseek").map((model) => model.identity.accessProviderId)).toEqual(["cline"]);
  });

  it("keeps compatibility state separate from raw capability support", () => {
    const brokenButCapable: RegistryDocument = Object.freeze({
      registryRevision: MODEL_REGISTRY_REVISION,
      models: Object.freeze([
        reviewedModel({
          accessProviderId: "openrouter", upstreamModelId: "claims-everything", verifiedAt: "2026-08-20",
          fixtureVersion: "openai-chat-v1", capabilities: conservativeCapabilities({ images: true, structuredOutput: true }),
          compatibility: { state: "BROKEN", baseline: "claude-code-2.1.229", evidenceRef: "canary-9", checkedAt: "2026-08-21" },
        }),
        reviewedModel({
          accessProviderId: "codex", upstreamModelId: "gpt-5.4", verifiedAt: "2026-08-20",
          fixtureVersion: "codex-oauth-chat-v1", capabilities: conservativeCapabilities(),
          compatibility: { state: "VERIFIED", baseline: "claude-code-2.1.229", evidenceRef: "canary-12", checkedAt: "2026-08-21" },
        }),
      ]),
    });
    const broken = findModelEvidence(brokenButCapable, "openrouter", "claims-everything");
    const verified = findModelEvidence(brokenButCapable, "codex", "gpt-5.4");
    expect(broken?.capabilities.images).toBe(true);
    expect(broken?.capabilities.structuredOutput).toBe(true);
    expect(broken?.compatibility.state).toBe("BROKEN");
    expect(verified?.compatibility).toEqual({
      state: "VERIFIED",
      baseline: "claude-code-2.1.229",
      evidenceRef: "canary-12",
      checkedAt: "2026-08-21",
    });
  });

  it("filters candidates by compatibility state deterministically", () => {
    const withStates: RegistryDocument = Object.freeze({
      registryRevision: MODEL_REGISTRY_REVISION,
      models: Object.freeze([
        reviewedModel({ accessProviderId: "codex", upstreamModelId: "gpt-5.4", verifiedAt: "2026-08-20", fixtureVersion: "f1", capabilities: conservativeCapabilities(), compatibility: { state: "VERIFIED", evidenceRef: "c1" } }),
        reviewedModel({ accessProviderId: "cline", upstreamModelId: "claude-sonnet-4-5", verifiedAt: "2026-08-20", fixtureVersion: "f2", capabilities: conservativeCapabilities() }),
        reviewedModel({ accessProviderId: "openrouter", upstreamModelId: "x/y:free", verifiedAt: "2026-08-20", fixtureVersion: "f3", capabilities: conservativeCapabilities(), compatibility: { state: "BROKEN", evidenceRef: "c3" } }),
      ]),
    });
    expect(modelsWithCompatibility(withStates, "VERIFIED").map((model) => model.logicalId)).toEqual(["codex/gpt-5.4"]);
    expect(modelsWithCompatibility(withStates, ["VERIFIED", "BROKEN"]).map((model) => model.logicalId)).toEqual(["codex/gpt-5.4", "openrouter/x/y:free"]);
    expect(modelsWithCompatibility(withStates, ["EXPERIMENTAL"]).map((model) => model.logicalId)).toEqual(["cline/claude-sonnet-4-5"]);
  });

  it("queries models by provider, family, and capability predicate without account or credential access", () => {
    expect(modelsForProvider(directProviderRegistry, "openrouter").map((model) => model.logicalId)).toEqual([
      "openrouter/nvidia/nemotron-3.5-lightning:free",
      "openrouter/nvidia/nemotron-nano-12b-v2-vl:free",
      "openrouter/openai/gpt-oss-20b:free",
      "openrouter/deepseek/deepseek-v4-flash-0731",
    ]);
    expect(modelsForProvider(directProviderRegistry, "openrouter").every((model) => model.identity.accessProviderId === "openrouter")).toBe(true);
    expect(modelsForFamily(directProviderRegistry, "nvidia").map((model) => model.logicalId)).toEqual([
      "openrouter/nvidia/nemotron-3.5-lightning:free",
      "openrouter/nvidia/nemotron-nano-12b-v2-vl:free",
    ]);
    expect(modelsSatisfying(directProviderRegistry, (capabilities) => capabilities.images).map((model) => model.logicalId)).toEqual([
      "openrouter/nvidia/nemotron-nano-12b-v2-vl:free",
    ]);
    expect(modelsRequiringCapabilities(directProviderRegistry, ["tools", "streaming"]).map((model) => model.logicalId)).toEqual([
      "openrouter/nvidia/nemotron-3.5-lightning:free",
      "openrouter/nvidia/nemotron-nano-12b-v2-vl:free",
      "openrouter/openai/gpt-oss-20b:free",
      "openrouter/deepseek/deepseek-v4-flash-0731",
      "codex/gpt-5.4",
      "cline/claude-sonnet-4-5",
      "cline/gpt-5.6-terra",
      "cline/gpt-5.6-sol",
      "cline/claude-opus-4-8",
      "cline/claude-fable",
    ]);
    expect(modelsRequiringCapabilities(directProviderRegistry, ["tools"]).some((model) => model.identity.accessProviderId === "deepseek")).toBe(false);
  });

  it("carries typed reasoning and limit metadata alongside the protocol flags", () => {
    const codex = findModelEvidence(directProviderRegistry, "codex", "gpt-5.4");
    expect(codex?.reasoning).toEqual({
      supported: true,
      controlKind: "binary",
      adaptive: false,
      tokenBudget: false,
      reasoningWithTools: false,
    });
    // No invented limit numbers on reviewed entries.
    expect(codex?.limits).toEqual({});
    const limited = reviewedModel({
      accessProviderId: "codex", upstreamModelId: "gpt-5.6-sol", verifiedAt: "2026-08-20",
      fixtureVersion: "codex-oauth-chat-v1", capabilities: conservativeCapabilities(),
      limits: { contextWindow: 400_000, maxOutput: 128_000 },
      reasoning: {
        supported: true, controlKind: "discrete-effort", effortLevels: ["low", "medium", "high", "xhigh", "max"],
        adaptive: false, tokenBudget: false, reasoningWithTools: true,
      },
    });
    expect(limited.limits).toEqual({ contextWindow: 400_000, maxOutput: 128_000 });
    expect(limited.reasoning.controlKind).toBe("discrete-effort");
    expect(limited.reasoning.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("bumps the registry document revision and pins the canonical shape of shipped entries", () => {
    expect(directProviderRegistry.registryRevision).toBe(MODEL_REGISTRY_REVISION);
    expect(MODEL_REGISTRY_REVISION).toBeGreaterThan(3); // schema change since v3
    expect(MODEL_REGISTRY_REVISION).toBeGreaterThan(4); // #122: claimRef on compatibility evidence (schema change since v4)
    for (const model of directProviderRegistry.models) {
      expect(model.logicalId).toBe(`${model.identity.accessProviderId}/${model.identity.upstreamModelId}`);
      expect(["VERIFIED", "EXPERIMENTAL", "BROKEN"]).toContain(model.compatibility.state);
      expect(model.compatibility.baseline.length).toBeGreaterThan(0);
      expect(model.compatibility.evidenceRef.length).toBeGreaterThan(0);
      expect(model.compatibility.checkedAt).toBeTruthy();
      expect(model.capabilities.tokenCounting).toBe(model.tokenCounting);
      expect(Object.isFrozen(model.identity)).toBe(true);
      expect(Object.isFrozen(model.compatibility)).toBe(true);
    }
  });

  it("records an optional v2 claim reference on reviewed compatibility evidence (#122)", () => {
    const claimKey = "v2|claude-code|claude-code-2.1.229|anthropic-messages|claude-code-2.1.229-contract-v1|codex-oauth|codex|oauth|anthropic-messages|gpt-5.4|text";
    const reviewed = reviewedModel({
      accessProviderId: "codex",
      upstreamModelId: "gpt-5.4",
      verifiedAt: "2026-08-20",
      fixtureVersion: "codex-oauth-chat-v1",
      capabilities: conservativeCapabilities(),
      compatibility: { state: "VERIFIED", baseline: "claude-code-2.1.229", evidenceRef: "canary-layer-a:" + claimKey, claimRef: claimKey },
    });
    expect(reviewed.compatibility.claimRef).toBe(claimKey);
    // Reviewed rows without a claim reference stay claim-less (legacy/untrusted for v2 authority).
    expect(directProviderRegistry.models[0]?.compatibility.claimRef).toBeUndefined();
  });

  it("migrates static legacy documents to the canonical shape without guessing families", () => {
    const legacy: LegacyRegistryDocument = Object.freeze({
      registryRevision: 3,
      models: Object.freeze([
        Object.freeze({
          logicalId: "openrouter/nvidia/nemotron-3.5-lightning:free",
          upstreamId: "nvidia/nemotron-3.5-lightning:free",
          verifiedAt: "2026-08-13",
          fixtureVersion: "openai-chat-v1",
          tokenCounting: "conservative-estimate" as const,
          capabilities: conservativeCapabilities(),
        }),
        Object.freeze({
          logicalId: "codex/gpt-5.4",
          upstreamId: "gpt-5.4",
          verifiedAt: "2026-08-14",
          fixtureVersion: "codex-oauth-chat-v1",
          tokenCounting: "conservative-estimate" as const,
          capabilities: conservativeCapabilities(),
        }),
      ]),
    });
    const migrated = migrateRegistryDocument(legacy);
    expect(migrated.registryRevision).toBe(MODEL_REGISTRY_REVISION);
    expect(migrated.models).toHaveLength(2);
    expect(migrated.models[0]?.identity).toEqual({ accessProviderId: "openrouter", upstreamModelId: "nvidia/nemotron-3.5-lightning:free" });
    expect(migrated.models[0]?.identity.modelFamily).toBeUndefined();
    expect(migrated.models[0]?.limits).toEqual({});
    expect(migrated.models[0]?.compatibility).toMatchObject({
      state: "EXPERIMENTAL",
      baseline: "claude-code-fake-upstream",
      evidenceRef: "openai-chat-v1",
      checkedAt: "2026-08-13",
    });
    expect(migrated.models[1]?.identity.accessProviderId).toBe("codex");
    expect(migrated.models[1]?.logicalId).toBe("codex/gpt-5.4");
  });

  it("migrated documents preserve exact evidence lookup and fail closed cross-provider", () => {
    const migrated = migrateRegistryDocument(Object.freeze({
      registryRevision: 3,
      models: Object.freeze([
        Object.freeze({
          logicalId: "cline/claude-sonnet-4-5",
          upstreamId: "claude-sonnet-4-5",
          verifiedAt: "2026-08-14",
          fixtureVersion: "cline-interop-chat-v1",
          tokenCounting: "conservative-estimate" as const,
          capabilities: conservativeCapabilities(),
        }),
      ]),
    }));
    expect(findModelEvidence(migrated, "cline", "claude-sonnet-4-5")?.capabilities.tools).toBe(true);
    expect(findModelEvidence(migrated, "codex", "claude-sonnet-4-5")).toBeUndefined();
    expect(routesFromConfig(gatewayConfigSchema.parse({
      schemaVersion: 1,
      gateway: { port: 17871 },
      routes: { primary: { provider: "cline", model: "claude-sonnet-4-5", credential: "env:CLINE_BEARER" } },
    }), migrated).size).toBe(1);
  });

  it("keeps discovery proposals out of the trusted registry (#23 propose-only)", () => {
    const before = directProviderRegistry.models;
    const proposal = proposeRegistryChanges({
      source: "openrouter-models",
      discoveredAt: "2026-08-22T00:00:00.000Z",
      models: [
        { accessProviderId: "codex", upstreamModelId: "gpt-5.4" },
        { accessProviderId: "cline", upstreamModelId: "gpt-5.6-luna", modelFamily: "openai/codex", observedLimits: { contextWindow: 400_000 } },
        { accessProviderId: "openrouter", upstreamModelId: "nvidia/nemotron-3.5-lightning:free" },
      ],
    });
    expect(proposal.known.map((model) => model.logicalId)).toEqual([
      "codex/gpt-5.4",
      "openrouter/nvidia/nemotron-3.5-lightning:free",
    ]);
    expect(proposal.proposed).toHaveLength(1);
    expect(proposal.proposed[0]?.identity).toEqual({ accessProviderId: "cline", upstreamModelId: "gpt-5.6-luna", modelFamily: "openai/codex" });
    expect(proposal.proposed[0]?.reason).toBe("no-exact-evidence");
    expect(proposal.proposed[0]?.proposedAt).toBe("2026-08-22T00:00:00.000Z");
    expect(proposal.proposed[0]?.observedLimits).toEqual({ contextWindow: 400_000 });
    // The trusted document is never mutated by discovery.
    expect(directProviderRegistry.models).toBe(before);
    expect(directProviderRegistry.models).toHaveLength(12);
    expect(Object.isFrozen(directProviderRegistry.models)).toBe(true);
    expect(Object.isFrozen(directProviderRegistry)).toBe(true);
  });

  it("never stores credentials or account identity in registry evidence", () => {
    // `identity` (ModelIdentity) is model classification, not account identity.
    // Account identity/credential material would surface as email, pseudonym,
    // credentialHandle, access/refresh token, or authorization fields.
    const forbidden = new Set(["accessToken", "refreshToken", "authorization", "token", "secret", "password", "email", "prompt", "response", "pseudonym", "credentialHandle"]);
    const walk = (value: unknown, path: string): string[] => {
      if (value === null || typeof value !== "object") return [];
      const findings: string[] = [];
      for (const [key, child] of Object.entries(value)) {
        if (forbidden.has(key)) findings.push(`${path}.${key}`);
        findings.push(...walk(child, `${path}.${key}`));
      }
      return findings;
    };
    expect(walk(directProviderRegistry, "registry")).toEqual([]);
    expect(walk(aggregatorRegistry, "aggregator")).toEqual([]);
  });

  it("validates provider capability evidence through the typed schema", () => {
    const valid = {
      registryRevision: MODEL_REGISTRY_REVISION,
      providerId: "codex",
      evidenceRef: "canary-12",
      capabilities: conservativeCapabilities(),
      reasoning: { supported: true, controlKind: "binary" as const, adaptive: false, tokenBudget: false, reasoningWithTools: false },
      limits: { contextWindow: 400_000 },
    };
    expect(providerCapabilityEvidenceSchema.parse(valid).registryRevision).toBe(MODEL_REGISTRY_REVISION);
    expect(() => providerCapabilityEvidenceSchema.parse({ ...valid, capabilities: { ...valid.capabilities, tokenCounting: "invented" } })).toThrow();
    expect(() => providerCapabilityEvidenceSchema.parse({ ...valid, limits: { contextWindow: -1 } })).toThrow();
  });
});
