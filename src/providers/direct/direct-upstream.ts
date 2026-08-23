import type { GatewayConfig } from "../../config/schema.js";
import type { CanonicalEvent } from "../../core/canonical-event.js";
import type { CanonicalRequest } from "../../core/canonical-request.js";
import { reasoningRequestFromWire, type ResolvedReasoning } from "../../core/reasoning.js";
import { decideRoute, UnsupportedRouteError, type RouteRecord } from "../../core/router.js";
import { conservativeTokenCount } from "../../core/token-counting.js";
import type { CanonicalUpstream } from "../../protocols/anthropic/fake-upstream.js";
import { ProfileActivationError } from "../../profiles/errors.js";
import { directProviderRegistry, findModelEvidence, resolveConfiguredRoute, routesFromConfig, type RegistryDocument } from "../../registry/model-registry.js";
import { preflightContextWindow } from "../../registry/tokenizer-registry.js";
import { providerContract } from "../catalog.js";
import { createProviderAdapter } from "../dispatch.js";
import { ReasoningTranslationError, resolveReasoning } from "../reasoning.js";

export type ResolvedDirectRoute = Readonly<{ route: RouteRecord; upstream: CanonicalUpstream }>;

/** Resolves only an explicit configured role or exact configured model; never falls back. */
export function createDirectRouteResolver(config: GatewayConfig, configFingerprint: string, environment: NodeJS.ProcessEnv = process.env, registry: RegistryDocument = directProviderRegistry): (request: CanonicalRequest) => ResolvedDirectRoute | undefined {
  const routes = routesFromConfig(config, registry);
  return (request) => {
    const route = resolveConfiguredRoute(routes, request.requestedModel);
    if (!route) return undefined;
    const role = route.role === "primary" || route.role === "fast" || route.role === "reasoning" ? route.role : undefined;
    const baseUrl = role === undefined ? undefined : config.routes[role]?.baseUrl;
    const contract = providerContract(route.providerId);
    if (!contract || contract.integrationMode !== "direct") return undefined;
    const evidence = findModelEvidence(registry, route.providerId, route.modelId);
    const gate = preflightContextWindow(request, evidence, `${route.providerId}/${route.modelId}`);
    if (gate.exceeded) {
      throw new ProfileActivationError("context_window_exceeded", `context_window_exceeded: ${String(gate.count)} > ${String(gate.limit ?? 0)}`);
    }
    const adapter = createProviderAdapter({
      provider: {
        id: "00000000-0000-4000-8000-000000000000",
        name: route.providerId,
        integrationMode: "direct",
        endpointPolicy: baseUrl ?? contract.defaultEndpoint,
        capabilityEvidence: undefined,
        requiredTermsRevision: undefined,
        provenanceRef: undefined,
        enabled: true,
        version: 1,
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      },
      request: fetch,
      environment,
    });
    const resolvedReasoning = resolvedFor(route, request);
    const decision = decideRoute({
      requestId: request.id,
      route,
      required: [],
      configFingerprint,
      ...(resolvedReasoning === undefined ? {} : { resolvedReasoning }),
    });
    const effectiveRequest: CanonicalRequest = Object.freeze({ ...request, requestedModel: route.modelId, modelRole: route.role === "primary" || route.role === "fast" || route.role === "reasoning" ? route.role : "unknown" });
    return {
      route,
      upstream: {
        invoke: (_ignored: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalEvent> => adapter.invoke(effectiveRequest, decision, signal),
        countTokens: () => Promise.resolve(conservativeTokenCount(effectiveRequest)),
      },
    };
  };
}

/**
 * #70: translates the canonical reasoning intent for a registry-backed direct
 * route through the provider-owned boundary. Untranslatable explicit intents
 * fail closed on the existing unsupported-route contract instead of being
 * silently downgraded; routes without reasoning evidence emit no control.
 */
function resolvedFor(route: RouteRecord, request: CanonicalRequest): ResolvedReasoning | undefined {
  if (route.reasoningEvidence === undefined) return undefined;
  const reasoningRequest = request.inference.reasoning ?? reasoningRequestFromWire({});
  try {
    return resolveReasoning(reasoningRequest, route.reasoningEvidence);
  } catch (error) {
    if (error instanceof ReasoningTranslationError) {
      throw new UnsupportedRouteError(["reasoning"]);
    }
    throw error;
  }
}
