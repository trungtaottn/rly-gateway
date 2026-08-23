import { describe, expect, it } from "vitest";
import {
  MODEL_REGISTRY_REVISION,
  directProviderRegistry,
  reviewedModel,
  type DiscoverySnapshot,
  type RegistryDocument,
} from "../../src/registry/model-registry.js";
import { proposeCatalogDrift } from "../../src/registry/catalog-proposal.js";

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

const DISCOVERED_AT = "2026-08-22T00:00:00.000Z";

const trustedRegistry: RegistryDocument = Object.freeze({
  registryRevision: MODEL_REGISTRY_REVISION,
  models: Object.freeze([
    reviewedModel({
      accessProviderId: "openrouter", upstreamModelId: "nvidia/nemotron-3.5-lightning:free", modelFamily: "nvidia",
      verifiedAt: "2026-08-13", fixtureVersion: "openai-chat-v1", capabilities: conservativeCapabilities(),
      compatibility: { evidenceRef: "e2e-1" },
    }),
    reviewedModel({
      accessProviderId: "openrouter", upstreamModelId: "deepseek-v4-flash", modelFamily: "deepseek",
      verifiedAt: "2026-08-13", fixtureVersion: "openai-chat-v1", capabilities: conservativeCapabilities({ tools: false }),
      compatibility: { evidenceRef: "e2e-2" },
    }),
    reviewedModel({
      accessProviderId: "openrouter", upstreamModelId: "openai/gpt-oss-20b:free", modelFamily: "openai",
      verifiedAt: "2026-08-13", fixtureVersion: "openai-chat-v1", capabilities: conservativeCapabilities(),
      limits: { contextWindow: 200_000 },
      compatibility: { evidenceRef: "e2e-4" },
    }),
    reviewedModel({
      accessProviderId: "codex", upstreamModelId: "gpt-5.4", modelFamily: "openai/codex",
      verifiedAt: "2026-08-14", fixtureVersion: "codex-oauth-chat-v1", capabilities: conservativeCapabilities(),
      compatibility: { evidenceRef: "e2e-3" },
    }),
  ]),
});

describe("propose-only catalog drift (#23)", () => {
  it("yields a stable empty proposal for identical trusted registry and identical snapshot on repeated runs", () => {
    const snapshot: DiscoverySnapshot = Object.freeze({
      source: "openrouter-api-v1",
      discoveredAt: DISCOVERED_AT,
      models: Object.freeze([
        Object.freeze({ accessProviderId: "openrouter", upstreamModelId: "nvidia/nemotron-3.5-lightning:free", modelFamily: "nvidia" }),
        Object.freeze({ accessProviderId: "openrouter", upstreamModelId: "deepseek-v4-flash", modelFamily: "deepseek" }),
        Object.freeze({ accessProviderId: "openrouter", upstreamModelId: "openai/gpt-oss-20b:free", modelFamily: "openai" }),
      ]),
    });
    const first = proposeCatalogDrift(snapshot, "openrouter", trustedRegistry);
    const second = proposeCatalogDrift(snapshot, "openrouter", trustedRegistry);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.unchanged.map((model) => model.logicalId)).toEqual([
      "openrouter/deepseek-v4-flash",
      "openrouter/nvidia/nemotron-3.5-lightning:free",
      "openrouter/openai/gpt-oss-20b:free",
    ]);
    expect(first.new).toEqual([]);
    expect(first.changed).toEqual([]);
    expect(first.removed).toEqual([]);
    expect(first.registryRevision).toBe(MODEL_REGISTRY_REVISION);
    // Reviewed evidence references only, from known entries, sorted and deduplicated.
    expect(first.compatibilityEvidenceRefs).toEqual(["e2e-1", "e2e-2", "e2e-4"]);
    // The trusted document is untouched.
    expect(trustedRegistry.models).toHaveLength(4);
    expect(Object.isFrozen(trustedRegistry.models)).toBe(true);
  });

  it("produces deterministic entries for new, removed, family-change, reasoning, limits, and declared-capability drift", () => {
    const snapshot: DiscoverySnapshot = Object.freeze({
      source: "openrouter-api-v1",
      discoveredAt: DISCOVERED_AT,
      models: Object.freeze([
        // family drift on a trusted model
        Object.freeze({ accessProviderId: "openrouter", upstreamModelId: "nvidia/nemotron-3.5-lightning:free", modelFamily: "nvidia-updated" }),
        // reasoning + context-window drift; declared tools equal trusted
        Object.freeze({
          accessProviderId: "openrouter", upstreamModelId: "openai/gpt-oss-20b:free", modelFamily: "openai",
          declared: Object.freeze({ tools: true, reasoning: false, contextWindow: 131_072 }),
        }),
        // brand-new candidate with declared metadata
        Object.freeze({
          accessProviderId: "openrouter", upstreamModelId: "anthropic/claude-sonnet-5:beta", modelFamily: "anthropic",
          declared: Object.freeze({ tools: true, reasoning: true, maxOutput: 64_000 }),
        }),
        // deepseek-v4-flash is absent -> removed drift
      ]),
    });
    const report = proposeCatalogDrift(snapshot, "openrouter", trustedRegistry);
    expect(report.new).toEqual([{
      identity: { accessProviderId: "openrouter", upstreamModelId: "anthropic/claude-sonnet-5:beta", modelFamily: "anthropic" },
      proposedAt: DISCOVERED_AT,
      reason: "no-exact-evidence",
      declared: { tools: true, reasoning: true, maxOutput: 64_000 },
    }]);
    expect(report.changed).toEqual([
      {
        logicalId: "openrouter/nvidia/nemotron-3.5-lightning:free",
        identity: { accessProviderId: "openrouter", upstreamModelId: "nvidia/nemotron-3.5-lightning:free", modelFamily: "nvidia" },
        changes: [{ field: "modelFamily", trusted: "nvidia", observed: "nvidia-updated" }],
      },
      {
        logicalId: "openrouter/openai/gpt-oss-20b:free",
        identity: { accessProviderId: "openrouter", upstreamModelId: "openai/gpt-oss-20b:free", modelFamily: "openai" },
        changes: [
          { field: "contextWindow", trusted: 200_000, observed: 131_072 },
          { field: "reasoning", trusted: true, observed: false },
        ],
      },
    ]);
    expect(report.removed).toEqual([{
      logicalId: "openrouter/deepseek-v4-flash",
      identity: { accessProviderId: "openrouter", upstreamModelId: "deepseek-v4-flash", modelFamily: "deepseek" },
      observedAt: DISCOVERED_AT,
      reason: "not-in-snapshot",
    }]);
    // Trusted evidence refs include the drifted-but-still-trusted entries.
    expect(report.compatibilityEvidenceRefs).toEqual(["e2e-1", "e2e-4"]);
    // No silent substitution: the removed model is never re-added and no candidate replaces it.
    expect(report.new.some((entry) => entry.identity.upstreamModelId === "deepseek-v4-flash")).toBe(false);
  });

  it("never cross-matches the same upstream model id across access providers", () => {
    const snapshot: DiscoverySnapshot = Object.freeze({
      source: "cline-bridge-catalog",
      discoveredAt: DISCOVERED_AT,
      models: Object.freeze([
        // gpt-5.4 is reviewed under codex, not cline: must be a cline candidate, never unchanged.
        Object.freeze({ accessProviderId: "cline", upstreamModelId: "gpt-5.4", modelFamily: "openai/codex" }),
      ]),
    });
    const report = proposeCatalogDrift(snapshot, "cline", trustedRegistry);
    expect(report.unchanged).toEqual([]);
    expect(report.new).toEqual([{
      identity: { accessProviderId: "cline", upstreamModelId: "gpt-5.4", modelFamily: "openai/codex" },
      proposedAt: DISCOVERED_AT,
      reason: "no-exact-evidence",
    }]);
  });

  it("handles a large aggregator snapshot deterministically without auto-activating every model", () => {
    const models = Array.from({ length: 250 }, (_unused, index) => Object.freeze({
      accessProviderId: "openrouter",
      upstreamModelId: `openai/aggregate-model-${String(index).padStart(3, "0")}`,
      modelFamily: "openai",
    }));
    const snapshot: DiscoverySnapshot = Object.freeze({ source: "openrouter-api-v1", discoveredAt: DISCOVERED_AT, models: Object.freeze(models) });
    const before = trustedRegistry.models;
    const report = proposeCatalogDrift(snapshot, "openrouter", trustedRegistry);
    expect(report.new).toHaveLength(250);
    expect(report.unchanged).toHaveLength(0);
    expect(report.changed).toHaveLength(0);
    expect(report.removed).toHaveLength(3); // all trusted openrouter entries are absent from this snapshot
    const ids = report.new.map((entry) => entry.identity.upstreamModelId);
    expect(ids).toEqual([...ids].sort());
    expect(JSON.stringify(report)).toBe(JSON.stringify(proposeCatalogDrift(snapshot, "openrouter", trustedRegistry)));
    // Nothing activated: the trusted document is byte-identical and frozen.
    expect(trustedRegistry.models).toBe(before);
    expect(Object.isFrozen(trustedRegistry.models)).toBe(true);
  });

  it("fails closed on a mixed-provider snapshot and on duplicate access paths", () => {
    expect(() => proposeCatalogDrift(Object.freeze({
      source: "mixed", discoveredAt: DISCOVERED_AT,
      models: Object.freeze([
        Object.freeze({ accessProviderId: "openrouter", upstreamModelId: "a/b" }),
        Object.freeze({ accessProviderId: "codex", upstreamModelId: "gpt-5.4" }),
      ]),
    }), "openrouter", trustedRegistry)).toThrow(/mixes access providers/);
    expect(() => proposeCatalogDrift(Object.freeze({
      source: "dup", discoveredAt: DISCOVERED_AT,
      models: Object.freeze([
        Object.freeze({ accessProviderId: "openrouter", upstreamModelId: "a/b" }),
        Object.freeze({ accessProviderId: "openrouter", upstreamModelId: "a/b" }),
      ]),
    }), "openrouter", trustedRegistry)).toThrow(/duplicate access path/);
  });

  it("references #24 compatibility evidence without fabricating a pass for unrun candidates", () => {
    const snapshot: DiscoverySnapshot = Object.freeze({
      source: "openrouter-api-v1", discoveredAt: DISCOVERED_AT,
      models: Object.freeze([
        Object.freeze({ accessProviderId: "openrouter", upstreamModelId: "brand-new-model" }),
        Object.freeze({ accessProviderId: "openrouter", upstreamModelId: "nvidia/nemotron-3.5-lightning:free", modelFamily: "nvidia" }),
      ]),
    });
    const report = proposeCatalogDrift(snapshot, "openrouter", trustedRegistry);
    expect(report.compatibilityEvidenceRefs).toEqual(["e2e-1"]);
    // The new candidate carries no compatibility claim at all.
    expect(JSON.stringify(report.new[0])).not.toContain("VERIFIED");
  });

  it("never stores credentials or account identity in proposal output", () => {
    const snapshot: DiscoverySnapshot = Object.freeze({
      source: "openrouter-api-v1", discoveredAt: DISCOVERED_AT,
      models: Object.freeze([
        Object.freeze({ accessProviderId: "openrouter", upstreamModelId: "a/b", declared: Object.freeze({ tools: true }) }),
        Object.freeze({ accessProviderId: "openrouter", upstreamModelId: "nvidia/nemotron-3.5-lightning:free", modelFamily: "nvidia" }),
      ]),
    });
    const report = proposeCatalogDrift(snapshot, "openrouter", trustedRegistry);
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
    expect(walk(report, "report")).toEqual([]);
  });

  it("keeps discovery out of the shipped trusted registry and out of route projection", () => {
    const before = directProviderRegistry.models;
    const report = proposeCatalogDrift(Object.freeze({
      source: "openrouter-api-v1", discoveredAt: DISCOVERED_AT,
      models: Object.freeze([
        Object.freeze({ accessProviderId: "openrouter", upstreamModelId: "some/new-model:free" }),
      ]),
    }), "openrouter", directProviderRegistry);
    expect(report.new).toHaveLength(1);
    expect(directProviderRegistry.models).toBe(before);
    expect(directProviderRegistry.models).toHaveLength(12);
  });
});
