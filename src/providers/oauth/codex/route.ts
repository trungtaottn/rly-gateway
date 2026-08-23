import type { CanonicalEvent } from "../../../core/canonical-event.js";
import type { CanonicalRequest } from "../../../core/canonical-request.js";
import { reasoningRequestFromWire, type ResolvedReasoning } from "../../../core/reasoning.js";
import { decideRoute, UnsupportedRouteError, type RouteRecord } from "../../../core/router.js";
import type { CredentialBroker } from "../../../credentials/broker.js";
import type { CredentialService } from "../../../credentials/service.js";
import { conservativeTokenCount } from "../../../core/token-counting.js";
import type { CanonicalUpstream } from "../../../protocols/anthropic/fake-upstream.js";
import { directProviderRegistry, findModelEvidence } from "../../../registry/model-registry.js";
import { providerContract } from "../../catalog.js";
import { ReasoningTranslationError, resolveReasoning } from "../../reasoning.js";
import { CodexOAuthAdapter } from "./adapter.js";

export type ResolvedOauthRoute = Readonly<{ route: RouteRecord; upstream: CanonicalUpstream }>;

export function createCodexOauthRouteResolver(
  credentials: CredentialService,
  broker: CredentialBroker,
  configFingerprint: string,
  request: typeof fetch = fetch,
  endpoint?: string,
): (canonical: CanonicalRequest) => Promise<ResolvedOauthRoute | undefined> {
  return async (canonical) => {
    const contract = providerContract("codex");
    if (!contract || contract.integrationMode !== "oauth") return undefined;
    const evidence = findModelEvidence(directProviderRegistry, "codex", canonical.requestedModel);
    if (evidence === undefined) return undefined;
    const account = await credentials.resolveSelected();
    if (!account) return undefined;
    const prepared = await broker.prepare(account.credentialHandle);
    const route: RouteRecord = {
      role: "primary",
      providerId: "codex",
      modelId: canonical.requestedModel,
      adapterId: contract.adapterId,
      credentialRef: { kind: "handle", handle: account.credentialHandle },
      capabilities: evidence.capabilities,
      reasoningEvidence: evidence.reasoning,
    };
    const resolvedReasoning = resolvedFor(route, canonical);
    const decision = decideRoute({
      requestId: canonical.id,
      route,
      required: [],
      configFingerprint,
      accountPseudonym: account.pseudonym,
      credentialGeneration: prepared.generation,
      ...(resolvedReasoning === undefined ? {} : { resolvedReasoning }),
    });
    return {
      route,
      upstream: {
        invoke: async function* (_ignored: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalEvent> {
          const scoped = await broker.bind(account.credentialHandle, prepared.generation);
          try {
            const adapter = new CodexOAuthAdapter(request, scoped.accessToken, endpoint, scoped.accountId);
            yield* adapter.invoke(canonical, decision, signal);
          } finally {
            scoped.dispose();
          }
        },
        countTokens: () => Promise.resolve(conservativeTokenCount(canonical)),
      },
    };
  };
}

/**
 * #70: translates the canonical reasoning intent for a registry-backed Codex
 * OAuth route through the provider-owned boundary. Untranslatable explicit
 * intents fail closed on the existing unsupported-route contract.
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
