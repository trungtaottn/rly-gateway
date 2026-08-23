import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_CONTRACT, CLAUDE_CODE_OBSERVED_VERSION } from "../../src/canary/client-fixtures.js";
import { runGateMatrix, runSingleGate, type MatrixInput } from "../../src/canary/matrix.js";
import { adapterIdForProvider } from "../../src/canary/run.js";
import { CANARY_GATES, type CanaryGate } from "../../src/canary/types.js";
import { decodeAnthropicRequest } from "../../src/protocols/anthropic/decoder.js";
import { directProviderRegistry, findModelEvidence } from "../../src/registry/model-registry.js";

const repoRoot = join(import.meta.dirname, "..", "..");

function inputFor(providerId: string, modelId: string, overrides: Partial<MatrixInput> = {}): MatrixInput {
  const evidence = findModelEvidence(directProviderRegistry, providerId, modelId);
  if (evidence === undefined) throw new Error(`No registry evidence for ${providerId}/${modelId}`);
  return {
    clientBaseline: CLAUDE_CODE_CONTRACT.baseline,
    accessProviderId: providerId,
    adapterId: adapterIdForProvider(providerId),
    physicalModelId: modelId,
    ...(evidence.identity.modelFamily === undefined ? {} : { modelFamily: evidence.identity.modelFamily }),
    evidence,
    contract: CLAUDE_CODE_CONTRACT,
    ...overrides,
  };
}

function statusFor(results: readonly ReturnType<typeof runGateMatrix>[number][], gate: CanaryGate): string {
  const result = results.find((item) => item.gate === gate);
  if (result === undefined) throw new Error(`Gate ${gate} not evaluated`);
  return result.status;
}

describe("canary gate matrix (#24)", () => {
  it("records Claude Code 2.1.233 as observed without promoting the supported baseline", () => {
    expect(CLAUDE_CODE_OBSERVED_VERSION).toBe("2.1.233");
    expect(CLAUDE_CODE_CONTRACT.baseline).toBe("claude-code-2.1.229");
    expect(CLAUDE_CODE_CONTRACT.baseline).not.toContain(CLAUDE_CODE_OBSERVED_VERSION);
  });

  it("covers every documented capability gate for an exact access path", () => {
    const results = runGateMatrix(inputFor("codex", "gpt-5.4"));
    expect(results.map((result) => result.gate).sort()).toEqual([...CANARY_GATES].sort());
    for (const result of results) {
      expect(["passed", "failed", "not-run"]).toContain(result.status);
      if (result.status !== "passed") expect(typeof result.reason).toBe("string");
    }
  });

  it("passes text, streaming, and cancellation for a supported access path", () => {
    const results = runGateMatrix(inputFor("codex", "gpt-5.4"));
    expect(statusFor(results, "text")).toBe("passed");
    expect(statusFor(results, "streaming")).toBe("passed");
    expect(statusFor(results, "cancellation")).toBe("passed");
    expect(statusFor(results, "long-running-session")).toBe("passed");
  });

  it("passes the single/multi tool loop and keeps parallel tools unclaimed without evidence", () => {
    const results = runGateMatrix(inputFor("codex", "gpt-5.4"));
    expect(statusFor(results, "tools-single")).toBe("passed");
    expect(statusFor(results, "tools-multi")).toBe("passed");
    // `parallelTools` is not evidenced for this access path: the gate is
    // not-run, never passed, so no stronger tool capability is advertised.
    expect(statusFor(results, "tools-parallel")).toBe("not-run");
  });

  it("preserves the reasoning/effort signal and pins the fable alias contract", () => {
    const results = runGateMatrix(inputFor("cline", "claude-fable"));
    expect(statusFor(results, "reasoning")).toBe("passed");
    expect(statusFor(results, "effort-signal")).toBe("passed");
    expect(statusFor(results, "subagent-routing")).toBe("passed");
    expect(statusFor(results, "session-attribution")).toBe("passed");
    expect(statusFor(results, "subagent-parallel")).toBe("passed");
  });

  it("pins /v1/models discovery: id-prefix filter and projection namespace", () => {
    const results = runGateMatrix(inputFor("cline", "gpt-5.6-sol"));
    expect(statusFor(results, "model-discovery")).toBe("passed");
  });

  it("fails model-discovery with a typed reason when the id-filter contract changes", () => {
    const drifted = runSingleGate("model-discovery", inputFor("codex", "gpt-5.4", {
      contract: {
        ...CLAUDE_CODE_CONTRACT,
        modelDiscovery: { ...CLAUDE_CODE_CONTRACT.modelDiscovery, idPrefixFilter: ["only-prefixed"] },
      },
    }));
    expect(drifted.status).toBe("failed");
    expect(drifted.reason).toBe("gateway-model-filter-changed");
  });

  it("fails session-attribution with a typed reason when the agent header is missing", () => {
    const drifted = runSingleGate("session-attribution", inputFor("codex", "gpt-5.4", {
      fixtures: { attributionHeaders: { "x-claude-code-session-id": "session-synthetic-0001" } },
    }));
    expect(drifted.status).toBe("failed");
    expect(drifted.reason).toBe("missing-agent-header");
  });

  it("fails the tool loop with a typed reason on a malformed tool continuation", () => {
    const malformed = (): readonly unknown[] => [
      {
        requestId: "req-drift", sequence: 0, timestamp: "1970-01-01T00:00:00.000Z",
        providerId: "synthetic", modelId: "claude-sonnet-4-5", type: "response-started", responseId: "msg_drift",
      },
      {
        requestId: "req-drift", sequence: 1, timestamp: "1970-01-01T00:00:00.000Z",
        providerId: "synthetic", modelId: "claude-sonnet-4-5", type: "content-started", index: 0,
        contentType: "tool-call", toolCallId: "toolcall_drift", toolName: "Bash",
      },
      {
        requestId: "req-drift", sequence: 2, timestamp: "1970-01-01T00:00:00.000Z",
        providerId: "synthetic", modelId: "claude-sonnet-4-5", type: "tool-arguments-delta",
        index: 0, toolCallId: "toolcall_drift", partialJson: "{\"command\":",
      },
      {
        requestId: "req-drift", sequence: 3, timestamp: "1970-01-01T00:00:00.000Z",
        providerId: "synthetic", modelId: "claude-sonnet-4-5", type: "content-completed", index: 0,
      },
      {
        requestId: "req-drift", sequence: 4, timestamp: "1970-01-01T00:00:00.000Z",
        providerId: "synthetic", modelId: "claude-sonnet-4-5", type: "response-completed", stopReason: "tool_use",
      },
    ];
    const drifted = runSingleGate("tools-single", inputFor("codex", "gpt-5.4", { fixtures: { toolRun: malformed } }));
    expect(drifted.status).toBe("failed");
    expect(drifted.reason).toBe("tool-result-invalid");
  });

  it("fails reasoning with a typed reason when the effort signal is clamped", () => {
    const drifted = runSingleGate("reasoning", inputFor("codex", "gpt-5.4", {
      fixtures: { effortRequest: { ...SYNTHETIC_EFFORT_REQUEST_BODY, effort: undefined } },
    }));
    expect(drifted.status).toBe("failed");
    expect(drifted.reason).toBe("reasoning-effort-clamped");
  });

  it("fails effort-signal with a typed reason when the request field is lost", () => {
    const drifted = runSingleGate("effort-signal", inputFor("codex", "gpt-5.4", {
      fixtures: { effortRequest: { model: "claude-sonnet-4-5", max_tokens: 1024, messages: [{ role: "user", content: "synthetic fixture text" }] } },
    }));
    expect(drifted.status).toBe("failed");
    expect(drifted.reason).toBe("effort-signal-lost");
  });

  it("keeps reasoning+tools not-run when the access path lacks reasoningWithTools evidence", () => {
    const results = runGateMatrix(inputFor("cline", "gpt-5.6-sol"));
    expect(statusFor(results, "reasoning-tools")).toBe("not-run");
  });

  it("captures the golden effort-signal fixture through the real decoder (#70 feed)", async () => {
    const fixture = JSON.parse(
      await readFile(join(repoRoot, "tests/fixtures/upstream/claude-code/effort-signal-shape.json"), "utf8"),
    ) as Record<string, unknown>;
    const request = fixture["request"] as Record<string, unknown>;
    const decoded = decodeAnthropicRequest(request);
    expect(decoded.request.inference.reasoning?.sourceEffort).toBe("high");
    expect(decoded.request.inference.reasoning?.explicit).toBe(true);
    expect(decoded.ignoredAdditiveFields).toEqual([]);
  });

  it("matches the pinned golden client-contract fixture (no embedded drift)", async () => {
    const golden = JSON.parse(
      await readFile(join(repoRoot, "tests/fixtures/upstream/claude-code/client-contract-2.1.229.json"), "utf8"),
    ) as Record<string, Record<string, unknown>>;
    const attribution = fixtureSection(golden, "attribution");
    const modelDiscovery = fixtureSection(golden, "modelDiscovery");
    const aliases = fixtureSection(golden, "aliases");
    const effort = fixtureSection(golden, "effort");
    const framing = fixtureSection(golden, "framing");
    expect(CLAUDE_CODE_CONTRACT.attribution.session).toBe(attribution["session"]);
    expect(CLAUDE_CODE_CONTRACT.modelDiscovery.idPrefixFilter).toEqual(modelDiscovery["idPrefixFilter"]);
    expect(CLAUDE_CODE_CONTRACT.aliases.tiers).toEqual(aliases["tiers"]);
    expect(CLAUDE_CODE_CONTRACT.effort.requestField).toBe(effort["requestField"]);
    expect(CLAUDE_CODE_CONTRACT.framing.streamingEventOrder).toEqual(framing["streamingEventOrder"]);
  });
});

const SYNTHETIC_EFFORT_REQUEST_BODY = Object.freeze({
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  thinking: { type: "enabled" },
  effort: "high",
  messages: [{ role: "user", content: "synthetic fixture text" }],
});

function fixtureSection(golden: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = golden[name];
  if (value === null || typeof value !== "object") throw new Error(`fixture section missing: ${name}`);
  return value as Record<string, unknown>;
}
