import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { isControlPlaneError } from "../control-plane/errors.js";
import type { ControlPlaneStore } from "../control-plane/store.js";
import { isCredentialError } from "../credentials/errors.js";
import type { CredentialService } from "../credentials/service.js";
import {
  challengePattern,
  createAuthorizer,
  createManagementIdentityProof,
  headerValue,
  reject,
} from "./auth.js";
import { bootstrapPageHtml, SESSION_COOKIE_NAME } from "./bootstrap-page.js";
import { registerManagementCollections } from "./collections.js";
import { createGovernanceKey, listGovernanceKeys, revokeGovernanceKey } from "./keys.js";
import { registerCredentialRoutes } from "./credentials.js";
import type { RouteTraceRing } from "../profiles/traces.js";
import { toAuditDto, toHealthDto, toPolicyDto, toTraceDto } from "./dtos.js";
import { expiredSessionCookie, isExactManagementOrigin, parseCookie, sessionCookie } from "./origin.js";
import { applyManagementSecurityHeaders } from "./security-headers.js";
import { SESSION_TTL_MS, type SessionStore } from "./session-store.js";

export type ManagementServerOptions = Readonly<{
  host: "127.0.0.1";
  port: number;
  origin: string;
  managementToken: string;
  instanceId: string;
  configFingerprint: string;
  store: ControlPlaneStore;
  sessions: SessionStore;
  credentials?: CredentialService;
  traces?: RouteTraceRing;
}>;

export { createManagementIdentityProof };

export function createManagementServer(options: ManagementServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const authorize = createAuthorizer(options);

  app.addHook("onSend", async (_request, reply, payload) => {
    applyManagementSecurityHeaders(reply);
    return payload;
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    const origin = headerValue(request.headers.origin);
    if (!isExactManagementOrigin(origin, options.origin)) {
      return reject(reply, 403, "invalid-origin");
    }
  });

  app.get("/healthz", () => ({ ok: true }));
  app.get("/", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(bootstrapPageHtml());
  });
  app.get<{ Querystring: { challenge?: string } }>("/identity", async (request, reply) => {
    const challenge = request.query.challenge;
    if (!challenge || !challengePattern.test(challenge)) return reject(reply, 400, "invalid-challenge");
    return {
      product: "rly-gateway-management",
      instanceId: options.instanceId,
      configFingerprint: options.configFingerprint,
      protocolVersion: 1,
      proof: createManagementIdentityProof(
        options.managementToken,
        challenge,
        options.instanceId,
        options.configFingerprint,
      ),
    };
  });

  app.get("/readyz", async (request, reply) => {
    const principal = authorize(request, reply, false);
    if (!principal) return;
    return { ready: true, policyRevision: options.store.currentPolicy()?.revision ?? 0 };
  });

  app.post("/auth/bootstrap", async (request, reply) => {
    const principal = authorize(request, reply, false);
    if (!principal) return;
    if (principal.actor !== "cli") return reject(reply, 403, "cli-only");
    const issued = options.sessions.issueBootstrap();
    return { expiresAt: new Date(issued.expiresAt).toISOString(), token: issued.token };
  });

  app.post("/auth/exchange", async (request, reply) => {
    const parsed = z.object({ token: z.string().min(16) }).safeParse(request.body);
    if (!parsed.success) return reject(reply, 400, "invalid-token");
    const session = options.sessions.exchangeBootstrap(parsed.data.token);
    if (!session) return reject(reply, 401, "invalid-token");
    return reply
      .header("set-cookie", sessionCookie(SESSION_COOKIE_NAME, session.id, Math.floor(SESSION_TTL_MS / 1000)))
      .send({ csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() });
  });

  app.post("/auth/resume", async (request, reply) => {
    const sessionId = parseCookie(headerValue(request.headers.cookie), SESSION_COOKIE_NAME);
    const rotated = sessionId === undefined ? undefined : options.sessions.rotateCsrf(sessionId);
    if (!rotated) return reject(reply, 401, "unauthorized");
    return { csrfToken: rotated.csrfToken, expiresAt: new Date(rotated.expiresAt).toISOString() };
  });

  app.post("/auth/logout", async (request, reply) => {
    const principal = authorize(request, reply, true);
    if (!principal) return;
    const sessionId = parseCookie(headerValue(request.headers.cookie), SESSION_COOKIE_NAME);
    if (sessionId) options.sessions.revoke(sessionId);
    return reply.header("set-cookie", expiredSessionCookie(SESSION_COOKIE_NAME)).send({ loggedOut: true });
  });

  registerManagementCollections(app, authorize, options.store, options.credentials);
  // Governance keys CRUD (managementToken auth)
  app.post("/v1/keys", async (request, reply) => {
    const auth = authorize(request, reply, false);
    if (!auth) return;
    const parsed = z.object({
      name: z.string().min(1),
      profileId: z.uuid().optional(),
      poolId: z.uuid().optional(),
      budgetUsd: z.number().positive().optional(),
      rpmLimit: z.number().int().positive().optional(),
      allowedModels: z.array(z.string().min(1)).optional(),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid-body", details: parsed.error.issues });
    const { key, secret } = createGovernanceKey(options.store, {
      name: parsed.data.name,
      ...(parsed.data.profileId ? { profileId: parsed.data.profileId } : {}),
      ...(parsed.data.poolId ? { poolId: parsed.data.poolId } : {}),
      ...(parsed.data.budgetUsd !== undefined ? { budgetUsd: parsed.data.budgetUsd } : {}),
      ...(parsed.data.rpmLimit !== undefined ? { rpmLimit: parsed.data.rpmLimit } : {}),
      ...(parsed.data.allowedModels ? { allowedModels: parsed.data.allowedModels } : {}),
    });
    return reply.send({ id: key.id, name: key.name, secret, prefix: key.prefix });
  });
  app.get("/v1/keys", async (request, reply) => {
    const auth = authorize(request, reply, false);
    if (!auth) return;
    const keys = listGovernanceKeys(options.store).map(({ hash: _hash, ...rest }) => {
      void _hash;
      return rest;
    });
    return reply.send({ keys });
  });
  app.post("/v1/keys/:id/revoke", async (request, reply) => {
    const auth = authorize(request, reply, false);
    if (!auth) return;
    const { id } = request.params as { id: string };
    revokeGovernanceKey(options.store, id);
    return reply.send({ ok: true });
  });
  if (options.credentials) registerCredentialRoutes(app, authorize, options.credentials);

  app.get("/v1/policy", async (request, reply) => {
    const principal = authorize(request, reply, false);
    if (!principal) return;
    const policy = options.store.currentPolicy();
    return policy ? toPolicyDto(policy) : { revision: 0, providers: [], accounts: [], pools: [], profiles: [] };
  });
  app.get("/v1/audit", async (request, reply) => {
    const principal = authorize(request, reply, false);
    if (!principal) return;
    return { events: options.store.listAudit().map(toAuditDto) };
  });
  app.get("/v1/health", async (request, reply) => {
    const principal = authorize(request, reply, false);
    if (!principal) return;
    return { items: options.store.listHealth().map(toHealthDto) };
  });
  app.get("/v1/route-traces", async (request, reply) => {
    const principal = authorize(request, reply, false);
    if (!principal) return;
    return { traces: (options.traces?.list() ?? []).map(toTraceDto) };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (isControlPlaneError(error)) return reply.code(error.statusCode).send({ error: error.code });
    if (isCredentialError(error)) return reply.code(error.statusCode).send({ error: error.code });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "invalid" });
    return reply.code(500).send({ error: "internal" });
  });
  return app;
}

export async function listenManagement(app: FastifyInstance, options: ManagementServerOptions): Promise<string> {
  return app.listen({ host: options.host, port: options.port });
}
