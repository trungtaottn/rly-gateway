import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { GatewayConfig } from "../config/schema.js";
import type { CapabilityRequirement } from "../core/capabilities.js";
import type { CanonicalRequest } from "../core/canonical-request.js";
import type { ControlPlaneStore } from "../control-plane/store.js";
import type { PolicyRevision, ProfileRecord } from "../control-plane/types.js";
import type { EffectiveCompatibilityRegistry } from "../compatibility/registry.js";
import type { CredentialBroker } from "../credentials/broker.js";
import { registerLaunchSessionRoutes } from "../profiles/http.js";
import { verifyGovernanceKey as verifyGovKey } from "../management/keys.js";
// checkRpm/checkBudget/recordKeyUsage imported lazily inside hook to avoid cycle
import { resolveProfileRoute, resolveProjectedModelRoute } from "../profiles/resolve-route.js";
import type { AgentExecutionContextRegistry } from "../profiles/agent-contexts.js";
import type { LaunchSessionRegistry } from "../profiles/sessions.js";
import type { RouteTraceRing } from "../profiles/traces.js";
import { createDirectRouteResolver, type ResolvedDirectRoute } from "../providers/direct/direct-upstream.js";
import { directProviderRegistry, type RegistryDocument } from "../registry/model-registry.js";
import { isProjectionId, type SessionPolicySnapshot } from "../routing/model-projection/types.js";
import { compileModelUniverseSnapshot } from "../routing/model-projection/project.js";
import { ResponseContinuationStore } from "../protocols/openai-responses/continuation.js";
import { registerAnthropicMessagesRoute } from "../routes/anthropic-messages-route.js";
import { registerAnthropicDirectCountTokensRoute } from "../routes/anthropic-direct-count-tokens-route.js";
import { registerAnthropicModelsRoute } from "../routes/anthropic-models-route.js";
import { registerOpenAiResponsesRoute } from "../routes/openai-responses-route.js";
import type { RouteSelector } from "../routing/pools/selector.js";
import { RUNTIME_VERSION } from "./gateway-attestation.js";
import type { BuildIdentity } from "./build-identity.js";
import type { UpdateStateRecord } from "./update/types.js";

/**
 * Secret-free update metadata carried on `/identity` (#73): installation and
 * activation are separate; the CLI/runtime handshake uses this to decide
 * whether new launches may continue on the old runtime while activation is
 * pending.
 */
export type IdentityUpdateSnapshot = Readonly<{
  state: UpdateStateRecord["state"];
  pendingVersion?: string;
  previousVersion?: string;
}>;

export type GatewayServerOptions = Readonly<{
  host: "127.0.0.1";
  port: number;
  authToken: string;
  instanceId: string;
  configFingerprint: string;
  config?: GatewayConfig;
  environment?: NodeJS.ProcessEnv;
  leases?: GatewayLeaseRegistry;
  resolveOauthRoute?: (request: CanonicalRequest) => Promise<ResolvedDirectRoute | undefined> | ResolvedDirectRoute | undefined;
  controlPlane?: ControlPlaneStore;
  broker?: CredentialBroker;
  selector?: RouteSelector;
  launchSessions?: LaunchSessionRegistry;
  /** Session-scoped Claude Code agent execution contexts (#71). */
  agentContexts?: AgentExecutionContextRegistry;
  traces?: RouteTraceRing;
  continuationDirectory?: string;
  /** #124: Effective Compatibility Registry — the runtime compatibility authority. */
  compatibility?: EffectiveCompatibilityRegistry;
  /** True when this instance is owned by the per-user resident service. */
  resident?: boolean;
  /** Authenticated in-process shutdown used by the explicit service stop path. */
  shutdown?: () => Promise<void>;
  /**
   * Trusted model registry for gateway model discovery (#72). Defaults to the
   * reviewed static document (`directProviderRegistry`).
   */
  modelRegistry?: RegistryDocument;
  /** Durable state/schema version this runtime was built against (#73). */
  stateVersion?: number;
  /**
   * Serving runtime version reported on `/identity` (#73). Defaults to the
   * compiled-in `RUNTIME_VERSION`; tests and future distributions override it
   * to prove the identity reports the actual serving binary version.
   */
  runtimeVersion?: string;
  /**
   * Exact build identity (#94) reported on `/identity`: semantic version,
   * commit revision, build ID, release channel, protocol/state versions, and
   * the serving artifact digest. Defaults to the compiled identity; tests and
   * distributions override it to prove the exact bytes now serving.
   */
  buildIdentity?: BuildIdentity;
  /**
   * Durable update-state reader (#73). The serving runtime reports the update
   * state through `/identity` so an updated CLI can apply the launch policy.
   */
  updateState?: () => Promise<UpdateStateRecord | undefined> | UpdateStateRecord | undefined;
  /**
   * When true the runtime refuses issuance of new launch sessions (drain phase
   * of the #73 update lifecycle); wired by the authenticated `/drain` route.
   */
  draining?: boolean;
}>;

export type GatewayLeaseRegistry = Readonly<{
  add: (leaseId: string) => Promise<void>;
  renew: (leaseId: string) => Promise<void>;
  release: (leaseId: string) => Promise<void>;
  has?: (leaseId: string) => boolean;
}>;

const leaseParamsSchema = z.object({ leaseId: z.uuid() });
type RequestHeaders = Readonly<{ authorization?: string | undefined; "x-api-key"?: string | string[] | undefined }>;

function tokensEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(actual).digest(), createHash("sha256").update(expected).digest());
}

function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

function isAuthorized(header: string | undefined, token: string): boolean {
  const value = bearerToken(header);
  return value !== undefined && tokensEqual(value, token);
}

function headerToken(headers: RequestHeaders): string | undefined {
  const fromAuth = bearerToken(headers.authorization);
  if (fromAuth) return fromAuth;
  const key = headers["x-api-key"];
  return Array.isArray(key) ? key[0] : key;
}

function isGatewayRequestAuthorized(headers: RequestHeaders, token: string): boolean {
  const candidate = headerToken(headers);
  return candidate !== undefined && tokensEqual(candidate, token);
}

const challengePattern = /^[A-Za-z0-9_-]{32,128}$/;

export function createIdentityProof(
  authToken: string,
  challenge: string,
  instanceId: string,
  configFingerprint: string,
): string {
  return createHmac("sha256", authToken)
    .update(["rly-gateway", "1", challenge, instanceId, configFingerprint].join("\n"))
    .digest("hex");
}

export function createGatewayServer(options: GatewayServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
  app.get("/healthz", () => ({ ok: true }));
  // #73 drain state: once activation begins, the old runtime refuses issuance
  // of new launch sessions and reports `draining` on /identity.
  let draining = options.draining === true;
  const refuseIssuance = (): string | undefined => draining ? "runtime drain in progress; activation has begun" : undefined;
  const controlPlane = options.controlPlane;
  const broker = options.broker;
  const selector = options.selector;
  const launchSessions = options.launchSessions;
  const agentContexts = options.agentContexts;
  const traces = options.traces;
  const profileReady = controlPlane !== undefined
    && broker !== undefined
    && selector !== undefined
    && launchSessions !== undefined
    && traces !== undefined;
  const hasRoutes = Boolean(options.config && (Object.keys(options.config.routes).length > 0 || options.resolveOauthRoute || profileReady));
  if (hasRoutes && options.config) {
    const resolveDirect = Object.keys(options.config.routes).length > 0
      ? createDirectRouteResolver(options.config, options.configFingerprint, options.environment)
      : undefined;
    const resolveRoute = async (
      request: CanonicalRequest,
      headers?: RequestHeaders,
      required?: readonly CapabilityRequirement[],
    ) => {
      // Propagate governance key id into CanonicalRequest for ledger budget wiring (P0-2)
      const bearerForGov = headerToken(headers ?? {});
      if (bearerForGov?.startsWith("rly_") && controlPlane) {
        const gov = verifyGovKey(controlPlane, bearerForGov);
        if (gov) (request as unknown as Record<string, unknown>).__governanceKeyId = gov.id;
      }
      const token = headerToken(headers ?? {});
      const session = token === undefined ? undefined : launchSessions?.resolve(token);
      // #72: an RLY projection id routes through the session's pinned model
      // universe to one exact access-provider/model target + provider pool.
      if (session && isProjectionId(request.requestedModel) && controlPlane && broker && selector && traces) {
        return resolveProjectedModelRoute(request, session, {
          store: controlPlane,
          broker,
          selector,
          traces,
          configFingerprint: options.configFingerprint,
          ...(options.environment === undefined ? {} : { environment: options.environment }),
          ...(required === undefined ? {} : { required }),
          ...(options.modelRegistry === undefined ? {} : { registry: options.modelRegistry }),
          ...(options.compatibility === undefined ? {} : { compatibility: options.compatibility }),
        });
      }
      // Profile/pool session first, then TOML routes, then Codex pin.
      if (session && controlPlane && broker && selector && traces) {
        return resolveProfileRoute(request, session, {
          store: controlPlane,
          broker,
          selector,
          traces,
          configFingerprint: options.configFingerprint,
          ...(options.environment === undefined ? {} : { environment: options.environment }),
          ...(required === undefined ? {} : { required }),
          ...(agentContexts === undefined ? {} : { agentContexts }),
          ...(options.compatibility === undefined ? {} : { compatibility: options.compatibility }),
        });
      }
      return resolveDirect?.(request) ?? await options.resolveOauthRoute?.(request);
    };
    const continuationDirectory = options.continuationDirectory ?? options.controlPlane?.directory;
    const continuation = continuationDirectory === undefined ? undefined : new ResponseContinuationStore(continuationDirectory);
    registerAnthropicMessagesRoute(app, {
      configFingerprint: options.configFingerprint,
      resolveRoute,
    });
    registerOpenAiResponsesRoute(app, {
      configFingerprint: options.configFingerprint,
      resolveRoute,
      ...(continuation === undefined ? {} : { continuation }),
    });
    registerAnthropicDirectCountTokensRoute(app, resolveRoute);
    if (controlPlane && launchSessions) {
      // #72: authenticated gateway model discovery on the gateway listener. The
      // `/v1/` auth hook above accepts the instance bearer or a live launch
      // session child token — the same credentials Claude Code discovery sends.
      registerAnthropicModelsRoute(app, {
        controlPlane,
        sessions: launchSessions,
        registry: options.modelRegistry ?? directProviderRegistry,
        experimentalModels: options.config.gateway.modelDiscovery?.experimentalModels ?? false,
        ...(options.compatibility === undefined ? {} : { compatibility: options.compatibility }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        resolveSession: (token) => token === undefined ? undefined : launchSessions.resolve(token),
        extractToken: headerToken,
      });
    }
    app.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith("/v1/")) return;
      const token = headerToken(request.headers);
      if (isGatewayRequestAuthorized(request.headers, options.authToken)) return;
      if (token && launchSessions?.resolve(token)) return;
      if (token?.startsWith("rly_") && controlPlane) {
        const key = verifyGovKey(controlPlane, token);
        if (key) {
          // Enforce RPM and budget; budget check with 0 cost is only over-budget gate
          const { checkRpm, checkBudget } = await import("../management/keys.js");
          if (!checkRpm(controlPlane, key)) {
            await reply.code(429).send({ type: "error", error: { type: "rate_limit_error", message: "Governance key rate limit exceeded" } });
            return;
          }
          if (!checkBudget(controlPlane, key, 0)) {
            await reply.code(429).send({ type: "error", error: { type: "rate_limit_error", message: "Governance key budget exceeded" } });
            return;
          }
          // Record usage (0 cost at auth; actual cost recorded via ledger on terminal)
          const { recordKeyUsage } = await import("../management/keys.js");
          recordKeyUsage(controlPlane, key.id, 0);
          (request as unknown as Record<string, unknown>).__govKey = key;
          return;
        }
      }
      await reply.code(401).send({ type: "error", error: { type: "authentication_error", message: "Gateway request is unauthorized" } });
    });
    // P0-3: enforce allowedModels after body is parsed (preHandler has access to request.body)
    app.addHook("preHandler", async (request, reply) => {
      if (!request.url.startsWith("/v1/")) return;
      const govKey = (request as unknown as Record<string, unknown>).__govKey as { allowedModels?: readonly string[] } | undefined;
      if (!govKey?.allowedModels || govKey.allowedModels.length === 0) return;
      const body = request.body as { model?: string } | undefined;
      const requested = body?.model;
      if (typeof requested === "string" && !govKey.allowedModels.includes(requested)) {
        await reply.code(403).send({ type: "error", error: { type: "forbidden", message: `model ${requested} not allowed for this key` } });
        return;
      }
    });
  }
  if (controlPlane && launchSessions && traces) {
    registerLaunchSessionRoutes(app, {
      store: controlPlane,
      sessions: launchSessions,
      traces,
      isInstanceToken: (token) => token !== undefined && isGatewayRequestAuthorized({ authorization: `Bearer ${token}` }, options.authToken),
      resolveSession: (token) => token === undefined ? undefined : launchSessions.resolve(token),
      extractToken: headerToken,
      ...(options.leases?.has === undefined ? {} : { leaseActive: (leaseId) => options.leases?.has?.(leaseId) === true }),
      // #73: during the update drain phase the old runtime refuses issuance of
      // new launch sessions (existing sessions keep running to completion).
      refuseIssuance,
      // #72 + #J2 contract A: pin the session's model universe (bindings +
      // revisions) AND the profile-route binding (model roles/policy +
      // provider→pool execution target) at issue time so discovery and
      // routing stay stable for the active session.
      compileBinding: (profile) => {
        const policy = controlPlane.currentPolicy();
        const registry = options.modelRegistry ?? directProviderRegistry;
        if (policy === undefined) {
          return {
            universe: { policyRevision: 0, policyHash: "", registryRevision: registry.registryRevision, bindings: [], experimentalModels: false },
            policy: sessionPolicySnapshot(policy, profile),
          };
        }
        return {
          universe: compileModelUniverseSnapshot(policy, registry, {
            profile,
            experimentalModels: options.config?.gateway.modelDiscovery?.experimentalModels ?? false,
            ...(options.environment === undefined ? {} : { environment: options.environment }),
          }),
          policy: sessionPolicySnapshot(policy, profile),
        };
      },
    });
  }

  /**
   * #J2 contract A: captures the frozen profile-route binding at issue time
   * from the CURRENT control-plane policy — the profile's model roles and
   * launch/capability policy, its pool (strategy/retry/affinity/memberships),
   * and the provider config. Account state, credentials and ECR stay live.
   * An absent policy yields an empty binding (no resolvable execution target).
   */
  const sessionPolicySnapshot = (policy: PolicyRevision | undefined, profile: ProfileRecord): SessionPolicySnapshot => {
    const pool = policy === undefined ? undefined : policy.snapshot.pools.find((item) => item.id === profile.poolId);
    const provider = pool === undefined ? undefined : policy?.snapshot.providers.find((item) => item.id === pool.providerId);
    return Object.freeze({
      profile: Object.freeze({
        id: profile.id,
        name: profile.name,
        harness: profile.harness,
        modelRoles: Object.freeze({ ...profile.modelRoles }),
        capabilityPolicy: profile.capabilityPolicy,
        launchPolicy: profile.launchPolicy,
      }),
      pool: Object.freeze({
        id: pool?.id ?? "",
        name: pool?.name ?? "",
        providerId: pool?.providerId ?? "",
        strategy: pool?.strategy ?? "fill-first",
        retryBudget: pool?.retryBudget ?? 0,
        affinity: pool?.affinity,
        memberships: Object.freeze((pool?.memberships ?? []).map((membership) => Object.freeze({ accountId: membership.accountId }))),
      }),
      provider: Object.freeze({
        id: provider?.id ?? "",
        name: provider?.name ?? "",
        integrationMode: provider?.integrationMode ?? "direct",
        endpointPolicy: provider?.endpointPolicy,
        enabled: provider?.enabled ?? false,
      }),
    });
  };
  const authorizeLease = async (
    request: { headers: RequestHeaders; params: { leaseId: string } },
    reply: { code: (status: number) => { send: (payload?: unknown) => unknown } },
  ) => {
    if (!isAuthorized(request.headers.authorization, options.authToken)) {
      await reply.code(401).send({ error: "unauthorized" });
      return undefined;
    }
    if (!options.leases) {
      await reply.code(503).send({ error: "leases-unavailable" });
      return undefined;
    }
    const parsed = leaseParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      await reply.code(400).send({ error: "invalid-lease" });
      return undefined;
    }
    return { leaseId: parsed.data.leaseId, leases: options.leases };
  };
  app.get("/readyz", async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, options.authToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return { ready: true, routes: Object.keys(options.config?.routes ?? {}).length };
  });
  app.post("/shutdown", async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, options.authToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (!options.shutdown) {
      return reply.code(503).send({ error: "shutdown-unavailable" });
    }
    // Reply before closing so the shutdown request completes; the bounded close
    // then drains only connections owned by this server.
    reply.code(202).send({ shuttingDown: true });
    setImmediate(() => { void options.shutdown?.(); });
  });
  app.post<{ Params: { leaseId: string } }>("/leases/:leaseId", async (request, reply) => {
    const lease = await authorizeLease(request, reply);
    if (!lease) return;
    await lease.leases.add(lease.leaseId);
    return reply.code(201).send({ leased: true });
  });
  app.put<{ Params: { leaseId: string } }>("/leases/:leaseId", async (request, reply) => {
    const lease = await authorizeLease(request, reply);
    if (!lease) return;
    await lease.leases.renew(lease.leaseId);
    return { renewed: true };
  });
  app.delete<{ Params: { leaseId: string } }>("/leases/:leaseId", async (request, reply) => {
    const lease = await authorizeLease(request, reply);
    if (!lease) return;
    options.launchSessions?.dropLease(lease.leaseId);
    options.agentContexts?.dropLease(lease.leaseId);
    await lease.leases.release(lease.leaseId);
    return reply.code(204).send();
  });
  app.get<{ Querystring: { challenge?: string } }>("/identity", async (request, reply) => {
    const challenge = request.query.challenge;
    if (!challenge || !challengePattern.test(challenge)) {
      return reply.code(400).send({ error: "invalid-challenge" });
    }
    // #73: the serving runtime reports its actual version/schema and update
    // metadata through the attested handshake; the CLI never trusts the
    // package version on disk alone. `update` is always present (idle when no
    // update is in progress) so status/doctor and the CLI policy have a
    // stable shape.
    const update = options.updateState === undefined ? undefined : await options.updateState();
    return {
      product: "rly-gateway",
      instanceId: options.instanceId,
      configFingerprint: options.configFingerprint,
      protocolVersion: 1,
      runtimeVersion: options.runtimeVersion ?? RUNTIME_VERSION,
      ...(options.stateVersion === undefined ? {} : { stateVersion: options.stateVersion }),
      ...(options.resident === undefined ? {} : { resident: options.resident }),
      ...(options.buildIdentity === undefined ? {} : { build: options.buildIdentity }),
      activeSessions: options.launchSessions?.size() ?? 0,
      draining,
      update: {
        state: update?.state ?? "idle",
        ...(update?.pendingVersion === undefined ? {} : { pendingVersion: update.pendingVersion }),
        ...(update?.previousVersion === undefined ? {} : { previousVersion: update.previousVersion }),
        // #93: the durable activation-transaction phase (staged/draining/
        // switching/probation/committing/committed/rolling-back/
        // recovery-required) so status/doctor show exactly where a
        // transactional activation stands.
        ...(update?.transaction === undefined ? {} : { phase: update.transaction.phase }),
      },
      proof: createIdentityProof(
        options.authToken,
        challenge,
        options.instanceId,
        options.configFingerprint,
      ),
    };
  });
  app.post("/drain", async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, options.authToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    // Idempotent: subsequent drain requests while already draining are a no-op.
    draining = true;
    return reply.code(202).send({ draining: true });
  });
  return app;
}

export async function listenGateway(app: FastifyInstance, options: GatewayServerOptions): Promise<string> {
  return app.listen({ host: options.host, port: options.port });
}
