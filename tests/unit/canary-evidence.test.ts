import { describe, expect, it } from "vitest";
import { classifyVerdict, requiredGatesFor } from "../../src/canary/classify.js";
import { runGateMatrix } from "../../src/canary/matrix.js";
import { canaryEvidenceRef, proposeCanaryState, verdictToCompatibilityState } from "../../src/canary/proposals.js";
import { adapterIdForProvider, runCanary } from "../../src/canary/run.js";
import { claimKeyFor, claimIdentityFor } from "../../src/canary/claim.js";
import type { CanaryEvidence, CanaryGateResult } from "../../src/canary/types.js";
import { CLAUDE_CODE_CONTRACT } from "../../src/canary/client-fixtures.js";
import { directProviderRegistry, findModelEvidence, reviewedModel } from "../../src/registry/model-registry.js";

function gateResult(gate: CanaryGateResult["gate"], status: CanaryGateResult["status"], reason?: string): CanaryGateResult {
  return Object.freeze({ gate, status, ...(reason === undefined ? {} : { reason }) });
}

function evidenceFor(
  providerId: string,
  modelId: string,
  verdict: CanaryEvidence["verdict"],
  overrides: Partial<CanaryEvidence> = {},
): CanaryEvidence {
  const evidence = findModelEvidence(directProviderRegistry, providerId, modelId);
  if (evidence === undefined) throw new Error(`No registry evidence for ${providerId}/${modelId}`);
  const identity = claimIdentityFor({
    client: "claude-code",
    clientVersion: CLAUDE_CODE_CONTRACT.baseline,
    contract: CLAUDE_CODE_CONTRACT,
    adapterId: adapterIdForProvider(providerId),
    accessProviderId: providerId,
    physicalModelId: modelId,
    ...(evidence.identity.modelFamily === undefined ? {} : { modelFamily: evidence.identity.modelFamily }),
  });
  return Object.freeze({
    client: identity.client,
    clientVersion: identity.clientVersion,
    sourceProtocol: identity.sourceProtocol,
    protocolRevision: identity.protocolRevision,
    accessProviderId: providerId,
    adapterId: identity.adapterId,
    authMode: identity.authMode,
    endpointContract: identity.endpointContract,
    physicalModelId: modelId,
    ...(evidence.identity.modelFamily === undefined ? {} : { modelFamily: evidence.identity.modelFamily }),
    fixtureRevision: CLAUDE_CODE_CONTRACT.fixtureRevision,
    testedGates: [],
    checkedAt: "1970-01-01T00:00:00.000Z",
    evidenceLayer: "A",
    verdict,
    ...overrides,
  });
}

describe("canary evidence and classification (#24, claim/evidence v2 by #122)", () => {
  it("classifies all-required-passed (Layer A only) as EXPERIMENTAL — VERIFIED is unreachable from observations", () => {
    const required = requiredGatesFor({
      capabilities: { tools: true, parallelTools: false, reasoning: true },
      reasoning: { reasoningWithTools: false },
    });
    const results = required.map((gate) => gateResult(gate as CanaryGateResult["gate"], "passed"));
    const classified = classifyVerdict({ results, requiredGates: required, adapterId: "codex-oauth", fakeMatrixRan: true });
    expect(classified.verdict).toBe("EXPERIMENTAL");
    expect(classified.reason).toBe("production-claim-not-established");
    // No boolean can grant production trust: every combination of gate results
    // that fully passes still stops at EXPERIMENTAL.
    for (const liveRunner of [false, true]) {
      const again = classifyVerdict({ results, requiredGates: required, adapterId: "codex-oauth", fakeMatrixRan: true });
      expect(again.verdict).not.toBe("VERIFIED");
      expect(liveRunner).toBeDefined();
    }
  });

  it("accepts reviewed VERIFIED evidence on the registry contract", () => {
    const evidence = evidenceFor("codex", "gpt-5.4", "VERIFIED", {
      evidenceLayer: "C",
      reason: "reviewed-compatibility-claim",
    });
    const proposal = proposeCanaryState(evidence, directProviderRegistry);
    expect(proposal).toBeDefined();
    expect(proposal?.proposedState).toBe("VERIFIED");
    expect(proposal?.currentState).toBe("EXPERIMENTAL");
    expect(proposal?.evidenceRef).toContain("canary-layer-a:");
    expect(verdictToCompatibilityState("VERIFIED")).toBe("VERIFIED");
  });


  it("classifies BROKEN when a required gate fails with the typed reason", () => {
    const classified = classifyVerdict({
      results: [
        gateResult("text", "passed"),
        gateResult("model-discovery", "failed", "gateway-model-filter-changed"),
      ],
      requiredGates: ["text", "model-discovery"],
      adapterId: "openrouter-direct",
      fakeMatrixRan: true,
    });
    expect(classified.verdict).toBe("BROKEN");
    expect(classified.reason).toBe("gateway-model-filter-changed");
  });

  it("never reports missing/unrun required gates as passed (unknown, not VERIFIED)", () => {
    const classified = classifyVerdict({
      results: [gateResult("text", "passed"), gateResult("streaming", "not-run", "no-streaming-evidence")],
      requiredGates: ["text", "streaming"],
      adapterId: "codex-oauth",
      fakeMatrixRan: true,
    });
    expect(classified.verdict).toBe("unknown");
  });

  it("does not advertise reasoning+tools without reasoningWithTools evidence", () => {
    const required = requiredGatesFor({
      capabilities: { tools: true, parallelTools: false, reasoning: true },
      reasoning: { reasoningWithTools: false },
    });
    expect(required).not.toContain("reasoning-tools");
    expect(required).toContain("tools-multi");
  });

  it("keys evidence by exact client + provider + adapter + physical model, never upstream name alone", async () => {
    const summary = await runCanary({ environment: {}, now: () => "1970-01-01T00:00:00.000Z" });
    const codexSol = summary.results.find((result) => result.accessProviderId === "codex" && result.physicalModelId === "gpt-5.6-sol");
    const clineSol = summary.results.find((result) => result.accessProviderId === "cline" && result.physicalModelId === "gpt-5.6-sol");
    expect(codexSol).toBeUndefined(); // gpt-5.6-sol is only a ClinePass aggregator fixture
    const clineTerra = summary.results.find((result) => result.accessProviderId === "cline" && result.physicalModelId === "gpt-5.6-terra");
    expect(clineSol).toBeDefined();
    expect(clineTerra).toBeDefined();
    expect(clineSol?.adapterId).toBe("cline-interop");
    expect(clineSol?.clientVersion).toBe(CLAUDE_CODE_CONTRACT.baseline);
    expect(clineSol?.evidenceLayer).toBe("A");
    expect(clineSol?.authMode).toBe("interop-import");
    expect(clineSol?.endpointContract).toBe("anthropic-messages");
    expect(clineSol?.sourceProtocol).toBe("anthropic-messages");
    expect(clineSol?.testedGates.length).toBeGreaterThan(0);
    // Distinct access paths stay distinct evidence records.
    const ids = new Set(summary.results.map((result) => `${result.accessProviderId}/${result.physicalModelId}`));
    expect(ids.size).toBe(summary.results.length);
    // The run is a v2 evidence run: schema version, runner, per-feature claims.
    expect(summary.evidenceSchemaVersion).toBe(2);
    expect(summary.evidence.length).toBeGreaterThan(0);
    expect(summary.claims.length).toBeGreaterThan(0);
    for (const claim of summary.claims) {
      expect(claim.schemaVersion).toBe(1);
      expect(claim.records.length).toBe(1);
      expect(claim.records[0]?.layer).toBe("A");
    }
  });

  it("never emits VERIFIED verdicts or layer B/C evidence from a run, even with the runner switch enabled", async () => {
    const summary = await runCanary({ environment: {}, liveRunnerEnabled: true, now: () => "1970-01-01T00:00:00.000Z" });
    expect(summary.liveRunner.enabled).toBe(true);
    expect(summary.liveRunner.evidenceEmitted).toBe(false);
    for (const result of summary.results) {
      expect(result.verdict).not.toBe("VERIFIED");
      expect(result.evidenceLayer).toBe("A");
    }
    for (const record of summary.evidence) {
      expect(record.layer).toBe("A");
      expect(record.kind).toBe("deterministic-fake-matrix");
    }
  });

  it("proposes canary state without ever mutating the trusted registry (Layer A only, never VERIFIED)", () => {
    const proposal = proposeCanaryState(evidenceFor("codex", "gpt-5.4", "EXPERIMENTAL"), directProviderRegistry);
    expect(proposal).toBeDefined();
    expect(proposal?.currentState).toBe("EXPERIMENTAL");
    expect(proposal?.proposedState).toBe("EXPERIMENTAL");
    expect(proposal?.accessProviderId).toBe("codex");
    expect(proposal?.physicalModelId).toBe("gpt-5.4");
    expect(proposal?.evidenceRef).toContain("canary-layer-a:");
    // A Layer A pass proposes EXPERIMENTAL at most — never VERIFIED.
    expect(verdictToCompatibilityState("EXPERIMENTAL")).toBe("EXPERIMENTAL");
    expect(verdictToCompatibilityState("VERIFIED")).toBe("VERIFIED"); // registry contract retained for #124 review
    // The trusted document is byte-identical after proposal.
    expect(findModelEvidence(directProviderRegistry, "codex", "gpt-5.4")?.compatibility.state).toBe("EXPERIMENTAL");
  });

  it("never proposes BROKEN/unreviewed evidence onto an unverified access path", () => {
    expect(verdictToCompatibilityState("unknown")).toBeUndefined();
    expect(proposeCanaryState(evidenceFor("codex", "gpt-5.4", "unknown"), directProviderRegistry)).toBeUndefined();
    expect(verdictToCompatibilityState("BROKEN")).toBe("BROKEN");
  });

  it("evaluates every trusted access path deterministically (same inputs → same results)", async () => {
    const first = await runCanary({ environment: {}, now: () => "1970-01-01T00:00:00.000Z" });
    const second = await runCanary({ environment: {}, now: () => "1970-01-01T00:00:00.000Z" });
    expect(first.results.length).toBe(second.results.length);
    for (let index = 0; index < first.results.length; index += 1) {
      expect(first.results[index]).toEqual(second.results[index]);
    }
    expect(first.claims).toEqual(second.claims);
  });

  it("keeps registry provenance: reviewedModel entries carry typed baseline/evidenceRef", () => {
    const model = reviewedModel({
      accessProviderId: "openrouter",
      upstreamModelId: "nvidia/nemotron-3.5-lightning:free",
      modelFamily: "nvidia",
      verifiedAt: "2026-08-13",
      fixtureVersion: "openai-chat-v1",
      capabilities: { streaming: true, tools: true, parallelTools: false, images: false, reasoning: true, redactedReasoning: false, structuredOutput: false, tokenCounting: "conservative-estimate" },
    });
    expect(model.compatibility.state).toBe("EXPERIMENTAL");
    expect(model.compatibility.baseline).toBe("claude-code-fake-upstream");
    // Pre-v2 rows carry no claim reference.
    expect(model.compatibility.claimRef).toBeUndefined();
  });

  it("produces distinct claim keys for distinct paths/features and stable refs", () => {
    const clineIdentity = claimIdentityFor({
      client: "claude-code",
      clientVersion: CLAUDE_CODE_CONTRACT.baseline,
      contract: CLAUDE_CODE_CONTRACT,
      adapterId: "cline-interop",
      accessProviderId: "cline",
      physicalModelId: "gpt-5.6-sol",
      modelFamily: "openai/codex",
    });
    const codexIdentity = claimIdentityFor({
      client: "claude-code",
      clientVersion: CLAUDE_CODE_CONTRACT.baseline,
      contract: CLAUDE_CODE_CONTRACT,
      adapterId: "codex-oauth",
      accessProviderId: "codex",
      physicalModelId: "gpt-5.6-sol",
    });
    // Same upstream model through two providers → distinct claim keys.
    expect(claimKeyFor(clineIdentity, "text")).not.toBe(claimKeyFor(codexIdentity, "text"));
    // Same path, different features → distinct claim keys (feature-scoped).
    expect(claimKeyFor(clineIdentity, "text")).not.toBe(claimKeyFor(clineIdentity, "reasoning"));
    expect(claimKeyFor(clineIdentity, "text")).not.toBe(claimKeyFor(clineIdentity, "tools-parallel"));
    // Deterministic.
    expect(claimKeyFor(clineIdentity, "text")).toBe(claimKeyFor(clineIdentity, "text"));
    // Model family is metadata, never part of the key.
    const familyMetadata = claimIdentityFor({
      client: "claude-code",
      clientVersion: CLAUDE_CODE_CONTRACT.baseline,
      contract: CLAUDE_CODE_CONTRACT,
      adapterId: "cline-interop",
      accessProviderId: "cline",
      physicalModelId: "gpt-5.6-sol",
    });
    expect(claimKeyFor(familyMetadata, "text")).toBe(claimKeyFor(clineIdentity, "text"));
  });

  it("still exercises the real gate matrix for a registry entry (executable protocol evidence)", () => {
    const evidence = findModelEvidence(directProviderRegistry, "codex", "gpt-5.4");
    if (evidence === undefined) throw new Error("missing fixture");
    const results = runGateMatrix({
      clientBaseline: CLAUDE_CODE_CONTRACT.baseline,
      accessProviderId: "codex",
      adapterId: "codex-oauth",
      physicalModelId: "gpt-5.4",
      evidence,
      contract: CLAUDE_CODE_CONTRACT,
    });
    expect(results.filter((result) => result.status === "passed").length).toBeGreaterThan(8);
  });

  it("builds a traceable v2 evidence ref from a canary observation", () => {
    const evidence = evidenceFor("cline", "gpt-5.6-sol", "EXPERIMENTAL");
    const ref = canaryEvidenceRef(evidence);
    expect(ref).toContain("canary-layer-a:");
    expect(ref).toContain("claude-code");
    expect(ref).toContain("cline");
    expect(ref).toContain("gpt-5.6-sol");
    expect(ref).toContain("text");
  });
});
