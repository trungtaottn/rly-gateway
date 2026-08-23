import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { CredentialBroker } from "../../src/credentials/broker.js";
import { LaunchSessionRegistry } from "../../src/profiles/sessions.js";
import { RouteTraceRing } from "../../src/profiles/traces.js";
import { createGatewayServer } from "../../src/runtime/gateway-server.js";
import { LeaseManager } from "../../src/runtime/lease-manager.js";
import { AffinityStore } from "../../src/routing/pools/affinity.js";
import { RouteSelector } from "../../src/routing/pools/selector.js";
import { gatewayConfigSchema } from "../../src/config/schema.js";

const directories: string[] = [];
let app: FastifyInstance | undefined;
let store: ControlPlaneStore | undefined;
let broker: CredentialBroker | undefined;
let provider: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await provider?.close();
  provider = undefined;
  await broker?.close();
  broker = undefined;
  store?.close();
  store = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function seed(directory: string, endpoint: string) {
  store = await ControlPlaneStore.open(directory);
  broker = await CredentialBroker.open(directory);
  const created = store.createProvider({
    name: "openrouter",
    integrationMode: "direct",
    endpointPolicy: endpoint,
  }, "cli");
  const first = store.createAccount({
    pseudonym: "acct-pool-a",
    providerId: created.id,
    credentialHandle: "env:OPENROUTER_API_KEY",
  }, "cli");
  const ready = store.bindCredential(first.id, first.version, {
    credentialHandle: "env:OPENROUTER_API_KEY",
    credentialGeneration: 1,
    state: "ready",
  }, "cli");
  const pool = store.createPool({
    name: "work-pool",
    providerId: created.id,
    strategy: "fill-first",
    retryBudget: 1,
    accountIds: [ready.id],
  }, "cli");
  const profile = store.createProfile({
    name: "work",
    harness: "claude",
    providerId: created.id,
    poolId: pool.id,
    modelRoles: {
      primary: "nvidia/nemotron-3.5-lightning:free",
      fast: "nvidia/nemotron-nano-12b-v2-vl:free",
    },
  }, "cli");
  return { profile, pool };
}

describe("profile pool route", () => {
  it("binds a child token to a profile and selects an account only at request time", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-profile-route-"));
    directories.push(directory);
    const received: string[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown };
      if (typeof body.model === "string") received.push(body.model);
      return new Response('data: {"id":"pool","choices":[{"delta":{"content":"POOL_OK"}}]}\n\ndata: {"id":"pool","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    await seed(directory, endpoint);
    if (!store || !broker) throw new Error("missing store");
    const leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
    const sessions = new LaunchSessionRegistry((id) => leases.has(id));
    const traces = new RouteTraceRing();
    const config = gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17871, logLevel: "silent" } });
    app = createGatewayServer({
      host: "127.0.0.1",
      port: 17871,
      authToken: "instance-secret",
      instanceId: "00000000-0000-4000-8000-000000000001",
      configFingerprint: "a".repeat(64),
      config,
      environment: { OPENROUTER_API_KEY: "fixture-key" },
      controlPlane: store,
      broker,
      selector: new RouteSelector(store, new AffinityStore(directory)),
      launchSessions: sessions,
      traces,
      leases,
    });
    const leaseId = "00000000-0000-4000-8000-000000000011";
    await leases.add(leaseId);
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/launch-sessions",
      headers: { authorization: "Bearer instance-secret", "content-type": "application/json" },
      payload: { profileName: "work", leaseId: "00000000-0000-4000-8000-000000000099" },
    });
    expect(rejected.statusCode).toBe(400);
    const issued = await app.inject({
      method: "POST",
      url: "/v1/launch-sessions",
      headers: { authorization: "Bearer instance-secret", "content-type": "application/json" },
      payload: { profileName: "work", leaseId },
    });
    expect(issued.statusCode).toBe(201);
    const issuedBody: unknown = issued.json();
    const token = issuedBody && typeof issuedBody === "object" && "token" in issuedBody && typeof issuedBody.token === "string"
      ? issuedBody.token
      : "";
    expect(token).not.toBe("instance-secret");
    const planned = issuedBody && typeof issuedBody === "object" && "planned" in issuedBody
      ? issuedBody.planned as Record<string, unknown>
      : undefined;
    expect(planned).toMatchObject({
      providerName: "openrouter",
      poolName: "work-pool",
    });
    expect(planned).not.toHaveProperty("effective");
    expect(JSON.stringify(planned)).not.toContain(token);
    expect(JSON.stringify(issuedBody)).not.toMatch(/"effective"/);
    const helper = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: "claude-haiku-4-5", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(helper.statusCode).toBe(200);
    expect(helper.body).toContain("POOL_OK");
    expect(received).toEqual(["nvidia/nemotron-nano-12b-v2-vl:free"]);
    const listed = await app.inject({
      method: "GET",
      url: "/v1/route-traces",
      headers: { authorization: `Bearer ${token}` },
    });
    const listedBody: unknown = listed.json();
    const body = listedBody && typeof listedBody === "object" && "traces" in listedBody
      ? listedBody as { traces: { profileName?: string; selected?: { accountPseudonym?: string }; modelSelection?: { selectedLogicalId?: string; source?: string } }[] }
      : { traces: [] };
    expect(body.traces[0]?.profileName).toBe("work");
    expect(body.traces[0]?.selected?.accountPseudonym).toBe("acct-pool-a");
    // Two-stage boundary: the #68 model selection decision feeds account selection.
    expect(body.traces[0]?.modelSelection?.selectedLogicalId).toBe("openrouter/nvidia/nemotron-nano-12b-v2-vl:free");
    expect(body.traces[0]?.modelSelection?.source).toBe("exact");
    expect(JSON.stringify(body)).not.toMatch(/fixture-key|OPENROUTER_API_KEY|prompt|authorization/i);

    // #70: an explicit thinking request carries deterministic reasoning
    // translation metadata (intent/mapping kind/fallback reason) in the trace,
    // never reasoning text, prompts, responses, or credentials.
    const thinking = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: "primary", max_tokens: 8, stream: true, thinking: { type: "enabled" }, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(thinking.statusCode).toBe(200);
    const traced = await app.inject({
      method: "GET",
      url: "/v1/route-traces",
      headers: { authorization: `Bearer ${token}` },
    });
    const tracedBody: unknown = traced.json();
    const reasoning = tracedBody && typeof tracedBody === "object" && "traces" in tracedBody
      ? (tracedBody as { traces: { reasoning?: { canonicalIntent?: string; mappingKind?: string; fallbackReason?: string } }[] }).traces.at(-1)?.reasoning
      : undefined;
    expect(reasoning?.canonicalIntent).toBe("BALANCED");
    expect(reasoning?.mappingKind).toBe("normalized");
    expect(reasoning?.fallbackReason).toMatch(/binary reasoning control has no effort granularity/);
    expect(JSON.stringify(tracedBody)).not.toMatch(/fixture-key|OPENROUTER_API_KEY|prompt|authorization|fixture reasoning|thinking text/i);

    const tools = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {
        model: "primary",
        max_tokens: 8,
        stream: true,
        tools: [{ name: "Bash", description: "run", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
        messages: [{ role: "user", content: "fixture" }],
      },
    });
    expect(tools.statusCode).toBe(200);
    expect(tools.body).toContain("POOL_OK");

    // #69: a logical tier request fails closed when no eligible same-family
    // target exists under the profile's provider (all-EXPERIMENTAL nvidia
    // family, fallback disabled) — no silent cross-provider substitution.
    const tierUnavailable = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: "fable", max_tokens: 8, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(tierUnavailable.statusCode).toBe(400);
    const tierError: { error?: { type?: string; reason?: string } } = tierUnavailable.json();
    expect(tierError.error?.type).toBe("tier-unavailable");
    expect(tierError.error?.reason).toBe("tier-unavailable");
    const listedAfterTier = await app.inject({
      method: "GET",
      url: "/v1/route-traces",
      headers: { authorization: `Bearer ${token}` },
    });
    const listedAfterTierBody: unknown = listedAfterTier.json();
    const afterTier = listedAfterTierBody && typeof listedAfterTierBody === "object" && "traces" in listedAfterTierBody
      ? listedAfterTierBody as {
          traces: {
            sourceRule?: string;
            selected?: unknown;
            modelSelection?: { reason?: string; selectedLogicalId?: string };
          }[];
        }
      : { traces: [] };
    const tierTrace = afterTier.traces.at(-1);
    expect(tierTrace?.sourceRule).toBe("model-selection:tier-unavailable");
    expect(tierTrace?.modelSelection?.reason).toBe("tier-unavailable");
    expect(tierTrace?.modelSelection?.selectedLogicalId).toBe("openrouter/fable");
    expect(tierTrace?.selected).toBeUndefined();

    const siblingLease = "00000000-0000-4000-8000-000000000012";
    await leases.add(siblingLease);
    const sibling = await app.inject({
      method: "POST",
      url: "/v1/launch-sessions",
      headers: { authorization: "Bearer instance-secret", "content-type": "application/json" },
      payload: { profileName: "work", leaseId: siblingLease },
    });
    const siblingBody: unknown = sibling.json();
    const siblingToken = siblingBody && typeof siblingBody === "object" && "token" in siblingBody && typeof siblingBody.token === "string"
      ? siblingBody.token
      : "";
    const [left, right] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { model: "primary", max_tokens: 8, stream: true, messages: [{ role: "user", content: "A" }] },
      }),
      app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${siblingToken}`, "content-type": "application/json" },
        payload: { model: "primary", max_tokens: 8, stream: true, messages: [{ role: "user", content: "B" }] },
      }),
    ]);
    expect(left.statusCode).toBe(200);
    expect(right.statusCode).toBe(200);

    await app.inject({
      method: "DELETE",
      url: `/leases/${leaseId}`,
      headers: { authorization: "Bearer instance-secret" },
    });
    const afterRelease = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: "primary", max_tokens: 8, messages: [{ role: "user", content: "gone" }] },
    });
    expect(afterRelease.statusCode).toBe(401);
    leases.dispose();
  });

  it("#J2 contract A: a mid-session profile edit never changes the model of an active session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-j2-freeze-"));
    directories.push(directory);
    const received: string[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown };
      if (typeof body.model === "string") received.push(body.model);
      return new Response('data: {"id":"j2","choices":[{"delta":{"content":"J2_OK"}}]}\n\ndata: {"id":"j2","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    const seeded = await seed(directory, endpoint);
    if (!store || !broker) throw new Error("missing store");
    const leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
    const sessions = new LaunchSessionRegistry((id) => leases.has(id));
    const traces = new RouteTraceRing();
    const config = gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17871, logLevel: "silent" } });
    app = createGatewayServer({
      host: "127.0.0.1",
      port: 17871,
      authToken: "instance-secret",
      instanceId: "00000000-0000-4000-8000-000000000002",
      configFingerprint: "a".repeat(64),
      config,
      environment: { OPENROUTER_API_KEY: "fixture-key" },
      controlPlane: store,
      broker,
      selector: new RouteSelector(store, new AffinityStore(directory)),
      launchSessions: sessions,
      traces,
      leases,
    });
    const issue = async (gatewayInstance: FastifyInstance, leaseId: string): Promise<string> => {
      await leases.add(leaseId);
      const issued = await gatewayInstance.inject({
        method: "POST",
        url: "/v1/launch-sessions",
        headers: { authorization: "Bearer instance-secret", "content-type": "application/json" },
        payload: { profileName: "work", leaseId },
      });
      expect(issued.statusCode).toBe(201);
      const body: unknown = issued.json();
      return body && typeof body === "object" && "token" in body && typeof body.token === "string" ? body.token : "";
    };
    const send = async (gatewayInstance: FastifyInstance, token: string, model: string): Promise<number> => {
      const response = await gatewayInstance.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: { model, max_tokens: 8, stream: true, messages: [{ role: "user", content: "j2" }] },
      });
      return response.statusCode;
    };

    const oldModel = "nvidia/nemotron-3.5-lightning:free";
    const newModel = "openai/gpt-oss-20b:free";
    const gatewayInstance = app;
    const token = await issue(gatewayInstance, "00000000-0000-4000-8000-000000000021");
    // Session pinned to the OLD primary.
    expect(await send(gatewayInstance, token, oldModel)).toBe(200);
    // Admin changes the profile primary mid-session.
    store.updateProfile(seeded.profile.id, seeded.profile.version, {
      modelRoles: { primary: newModel, fast: "nvidia/nemotron-nano-12b-v2-vl:free" },
    }, "cli");
    // The SAME session still resolves the OLD model (frozen binding) — the
    // exact complaint in #J2: no silent switch, no role-unmapped.
    expect(await send(gatewayInstance, token, oldModel)).toBe(200);
    // The NEW model is NOT in the frozen roles → role-unmapped for this session.
    expect(await send(gatewayInstance, token, newModel)).toBe(400);
    // Control: a NEW session sees the change (live config applies to new sessions).
    const fresh = await issue(gatewayInstance, "00000000-0000-4000-8000-000000000022");
    expect(await send(gatewayInstance, fresh, newModel)).toBe(200);
    expect(received.filter((model) => model === oldModel).length).toBe(2);
    expect(received.filter((model) => model === newModel).length).toBe(1);
    leases.dispose();
  });

  it("records a secret-free unknown-exact-model trace before any upstream call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-unknown-exact-"));
    directories.push(directory);
    const received: string[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown };
      if (typeof body.model === "string") received.push(body.model);
      return new Response("should-not-run", { status: 500 });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    const seeded = await seed(directory, endpoint);
    if (!store || !broker) throw new Error("missing store");
    store.updateProfile(seeded.profile.id, seeded.profile.version, {
      modelRoles: { primary: "unreviewed-exact-model" },
    }, "cli");
    const leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
    const sessions = new LaunchSessionRegistry((id) => leases.has(id));
    const traces = new RouteTraceRing();
    const config = gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17871, logLevel: "silent" } });
    app = createGatewayServer({
      host: "127.0.0.1",
      port: 17871,
      authToken: "instance-secret",
      instanceId: "00000000-0000-4000-8000-000000000003",
      configFingerprint: "a".repeat(64),
      config,
      environment: { OPENROUTER_API_KEY: "fixture-key" },
      controlPlane: store,
      broker,
      selector: new RouteSelector(store, new AffinityStore(directory)),
      launchSessions: sessions,
      traces,
      leases,
    });
    const leaseId = "00000000-0000-4000-8000-000000000031";
    await leases.add(leaseId);
    const issued = await app.inject({
      method: "POST",
      url: "/v1/launch-sessions",
      headers: { authorization: "Bearer instance-secret", "content-type": "application/json" },
      payload: { profileName: "work", leaseId },
    });
    expect(issued.statusCode).toBe(201);
    const issuedBody: unknown = issued.json();
    const token = issuedBody && typeof issuedBody === "object" && "token" in issuedBody && typeof issuedBody.token === "string"
      ? issuedBody.token
      : "";
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: "primary", max_tokens: 8, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(rejected.statusCode).toBe(400);
    const errorBody: { error?: { type?: string; reason?: string } } = rejected.json();
    expect(errorBody.error?.type).toBe("capability-rejected");
    expect(errorBody.error?.reason).toBe("unknown-exact-model");
    expect(received).toEqual([]);
    const listed = await app.inject({
      method: "GET",
      url: "/v1/route-traces",
      headers: { authorization: `Bearer ${token}` },
    });
    const listedBody: unknown = listed.json();
    const body = listedBody && typeof listedBody === "object" && "traces" in listedBody
      ? listedBody as {
          traces: {
            sourceRule?: string;
            selected?: unknown;
            modelSelection?: { reason?: string; selectedLogicalId?: string };
          }[];
        }
      : { traces: [] };
    expect(body.traces).toHaveLength(1);
    expect(body.traces[0]?.sourceRule).toBe("model-selection:unknown-exact-model");
    expect(body.traces[0]?.modelSelection?.reason).toBe("unknown-exact-model");
    expect(body.traces[0]?.modelSelection?.selectedLogicalId).toBe("openrouter/unreviewed-exact-model");
    expect(body.traces[0]?.selected).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/fixture-key|sk-|authorization|prompt/i);
    leases.dispose();
  });

  it("admits the exact OpenRouter DeepSeek V4 Flash 0731 pin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-or-deepseek-pin-"));
    directories.push(directory);
    const received: string[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown };
      if (typeof body.model === "string") received.push(body.model);
      return new Response('data: {"id":"pin","choices":[{"delta":{"content":"PIN_OK"}}]}\n\ndata: {"id":"pin","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    const seeded = await seed(directory, endpoint);
    if (!store || !broker) throw new Error("missing store");
    store.updateProfile(seeded.profile.id, seeded.profile.version, {
      modelRoles: { primary: "deepseek/deepseek-v4-flash-0731" },
    }, "cli");
    const leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
    const sessions = new LaunchSessionRegistry((id) => leases.has(id));
    const traces = new RouteTraceRing();
    const config = gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17871, logLevel: "silent" } });
    app = createGatewayServer({
      host: "127.0.0.1",
      port: 17871,
      authToken: "instance-secret",
      instanceId: "00000000-0000-4000-8000-000000000004",
      configFingerprint: "a".repeat(64),
      config,
      environment: { OPENROUTER_API_KEY: "fixture-key" },
      controlPlane: store,
      broker,
      selector: new RouteSelector(store, new AffinityStore(directory)),
      launchSessions: sessions,
      traces,
      leases,
    });
    const leaseId = "00000000-0000-4000-8000-000000000041";
    await leases.add(leaseId);
    const issued = await app.inject({
      method: "POST",
      url: "/v1/launch-sessions",
      headers: { authorization: "Bearer instance-secret", "content-type": "application/json" },
      payload: { profileName: "work", leaseId },
    });
    expect(issued.statusCode).toBe(201);
    const issuedBody: unknown = issued.json();
    const token = issuedBody && typeof issuedBody === "object" && "token" in issuedBody && typeof issuedBody.token === "string"
      ? issuedBody.token
      : "";
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: "primary", max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body).toContain("PIN_OK");
    expect(received).toEqual(["deepseek/deepseek-v4-flash-0731"]);
    leases.dispose();
  });

  it("records a secret-free role-unmapped trace before any upstream call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-role-unmapped-"));
    directories.push(directory);
    const received: string[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown };
      if (typeof body.model === "string") received.push(body.model);
      return new Response("should-not-run", { status: 500 });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    await seed(directory, endpoint);
    if (!store || !broker) throw new Error("missing store");
    const leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
    const sessions = new LaunchSessionRegistry((id) => leases.has(id));
    const traces = new RouteTraceRing();
    const config = gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17871, logLevel: "silent" } });
    app = createGatewayServer({
      host: "127.0.0.1",
      port: 17871,
      authToken: "instance-secret",
      instanceId: "00000000-0000-4000-8000-000000000005",
      configFingerprint: "a".repeat(64),
      config,
      environment: { OPENROUTER_API_KEY: "fixture-key" },
      controlPlane: store,
      broker,
      selector: new RouteSelector(store, new AffinityStore(directory)),
      launchSessions: sessions,
      traces,
      leases,
    });
    const leaseId = "00000000-0000-4000-8000-000000000051";
    await leases.add(leaseId);
    const issued = await app.inject({
      method: "POST",
      url: "/v1/launch-sessions",
      headers: { authorization: "Bearer instance-secret", "content-type": "application/json" },
      payload: { profileName: "work", leaseId },
    });
    expect(issued.statusCode).toBe(201);
    const issuedBody: unknown = issued.json();
    const token = issuedBody && typeof issuedBody === "object" && "token" in issuedBody && typeof issuedBody.token === "string"
      ? issuedBody.token
      : "";
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: "unmapped-client-model", max_tokens: 8, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(rejected.statusCode).toBe(400);
    const errorBody: { error?: { type?: string } } = rejected.json();
    expect(errorBody.error?.type).toBe("role-unmapped");
    expect(received).toEqual([]);
    const listed = await app.inject({
      method: "GET",
      url: "/v1/route-traces",
      headers: { authorization: `Bearer ${token}` },
    });
    const listedBody: unknown = listed.json();
    const body = listedBody && typeof listedBody === "object" && "traces" in listedBody
      ? listedBody as {
          traces: {
            sourceRule?: string;
            selected?: unknown;
            modelSelection?: { reason?: string; selectedLogicalId?: string };
          }[];
        }
      : { traces: [] };
    expect(body.traces).toHaveLength(1);
    expect(body.traces[0]?.sourceRule).toBe("model-selection:role-unmapped");
    expect(body.traces[0]?.modelSelection?.reason).toBe("role-unmapped");
    expect(body.traces[0]?.modelSelection?.selectedLogicalId).toBe("openrouter/unmapped-client-model");
    expect(body.traces[0]?.selected).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/fixture-key|sk-|authorization|prompt/i);
    leases.dispose();
  });
});
