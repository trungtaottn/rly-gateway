import { describe, expect, it } from "vitest";
import { gatewayConfigSchema } from "../../src/config/schema.js";
import { ProfileActivationError } from "../../src/profiles/errors.js";
import { decodeAnthropicRequest } from "../../src/protocols/anthropic/decoder.js";
import { createDirectRouteResolver } from "../../src/providers/direct/direct-upstream.js";
import { MODEL_REGISTRY_REVISION, reviewedModel, type RegistryDocument } from "../../src/registry/model-registry.js";

const capabilities = Object.freeze({
  streaming: true,
  tools: true,
  parallelTools: false,
  images: false,
  reasoning: true,
  redactedReasoning: false,
  structuredOutput: false,
  tokenCounting: "conservative-estimate" as const,
});

const limitedRegistry: RegistryDocument = Object.freeze({
  registryRevision: MODEL_REGISTRY_REVISION,
  models: Object.freeze([
    reviewedModel({
      accessProviderId: "openrouter",
      upstreamModelId: "nvidia/nemotron-3.5-lightning:free",
      modelFamily: "nvidia",
      verifiedAt: "2026-08-13",
      fixtureVersion: "openai-chat-v1",
      capabilities,
      limits: { contextWindow: 120 },
    }),
  ]),
});

function config() {
  return gatewayConfigSchema.parse({
    schemaVersion: 1,
    gateway: { port: 17871 },
    routes: {
      primary: {
        provider: "openrouter",
        model: "nvidia/nemotron-3.5-lightning:free",
        credential: "env:OPENROUTER_API_KEY",
      },
    },
  });
}

describe("direct route preflight", () => {
  it("throws context_window_exceeded before creating the adapter", () => {
    const resolve = createDirectRouteResolver(config(), "a".repeat(64), { OPENROUTER_API_KEY: "fixture" }, limitedRegistry);
    const request = decodeAnthropicRequest({
      model: "primary",
      max_tokens: 8,
      messages: [{ role: "user", content: "x".repeat(2000) }],
    }).request;
    expect(() => resolve(request)).toThrow(ProfileActivationError);
    try {
      resolve(request);
      throw new Error("expected context_window_exceeded");
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileActivationError);
      expect((error as ProfileActivationError).code).toBe("context_window_exceeded");
    }
  });

  it("resolves registry-backed routes when no context window is evidenced", () => {
    const resolve = createDirectRouteResolver(config(), "a".repeat(64), { OPENROUTER_API_KEY: "fixture" });
    const request = decodeAnthropicRequest({
      model: "primary",
      max_tokens: 8,
      messages: [{ role: "user", content: "fixture" }],
    }).request;
    const resolved = resolve(request);
    expect(resolved?.route.modelId).toBe("nvidia/nemotron-3.5-lightning:free");
    expect(resolved?.route.providerId).toBe("openrouter");
  });
});
