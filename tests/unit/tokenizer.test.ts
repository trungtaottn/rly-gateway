import { describe, it, expect } from "vitest";
import { conservativeTokenCount } from "../../src/core/token-counting.js";
import { getEncoding, isSupported, preflightContextWindow, countTokens } from "../../src/registry/tokenizer-registry.js";
import type { CanonicalRequest } from "../../src/core/canonical-request.js";
import type { ModelEvidence } from "../../src/registry/model-registry.js";

function fakeRequest(text: string): CanonicalRequest {
  return {
    id: "req-1",
    requestedModel: "openrouter/nvidia-nemotron-nano-9b-v2",
    input: [{ type: "text", text }],
  } as unknown as CanonicalRequest;
}

describe("tokenizer registry lite", () => {
  it("known model supported offline", () => {
    expect(isSupported("openai/gpt-4o")).toBe(true);
    expect(getEncoding("openai/gpt-4o")).toBe("o200k_base");
  });

  it("unknown returns fallback and gate respects limit", () => {
    expect(isSupported("nvidia/nemotron:free")).toBe(false);
    expect(countTokens(fakeRequest("hello"), "nvidia/nemotron:free")).toBeUndefined();
    const req = fakeRequest("hello world");
    const cons = conservativeTokenCount(req).inputTokens;
    expect(cons).toBeGreaterThan(0);
  });

  it("context gate fires when count > limit-100", () => {
    const req = fakeRequest("a".repeat(10000));
    const evidence = { limits: { contextWindow: 100 } } as unknown as ModelEvidence;
    const gate = preflightContextWindow(req, evidence, "openai/gpt-4o");
    expect(gate.exceeded).toBe(true);
    expect(gate.count).toBeGreaterThan(50);
  });

  it("gate passes when limit not exceeded", () => {
    const req = fakeRequest("hello");
    const evidence = { limits: { contextWindow: 1_000_000 } } as unknown as ModelEvidence;
    const gate = preflightContextWindow(req, evidence, "openai/gpt-4o");
    expect(gate.exceeded).toBe(false);
  });
});
