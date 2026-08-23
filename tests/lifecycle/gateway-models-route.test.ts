import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayConfigSchema, type GatewayConfig } from "../../src/config/schema.js";
import type { ProviderCapabilities } from "../../src/core/capabilities.js";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { CredentialBroker } from "../../src/credentials/broker.js";
import { LaunchSessionRegistry } from "../../src/profiles/sessions.js";
import { RouteTraceRing } from "../../src/profiles/traces.js";
import {
  MODEL_REGISTRY_REVISION,
  reviewedModel, directProviderRegistry,
  type RegistryDocument,
} from "../../src/registry/model-registry.js";
import { RLY_MODEL_PREFIX } from "../../src/routing/model-projection/types.js";
import { createGatewayServer } from "../../src/runtime/gateway-server.js";
import { LeaseManager } from "../../src/runtime/lease-manager.js";
import { AffinityStore } from "../../src/routing/pools/affinity.js";
import { RouteSelector } from "../../src/routing/pools/selector.js";
import { seedCodexClaudeProfile, sseFixture } from "../helpers/codex-profile-seed.js";
import { seedClineClaudeProfile } from "../helpers/cline-profile-seed.js";

const directories: string[] = [];
let app: FastifyInstance | undefined;
let store: ControlPlaneStore | undefined;
let broker: CredentialBroker | undefined;
let leases: LeaseManager | undefined;
const upstreams: FastifyInstance[] = [];

afterEach(async () => {
  await app?.close();
  app = undefined;
  await broker?.close();
  broker = undefined;
  store?.close();
  store = undefined;
  leases?.dispose();
  leases = undefined;
  await Promise.all(upstreams.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function capabilities(): ProviderCapabilities {
  return Object.freeze({
    streaming: true,
    tools: true,
    parallelTools: false,
    images: false,
    reasoning: true,
    redactedReasoning: false,
    structuredOutput: false,
    tokenCounting: "conservative-estimate",
  });
}

const VERIFIED = Object.freeze({ state: "VERIFIED" as const, baseline: "claude-code-2.1.229", evidenceRef: "verify-1", checkedAt: "2026-08-21" });
const EXPERIMENTAL = Object.freeze({ state: "EXPERIMENTAL" as const, baseline: "claude-code-fake-upstream", evidenceRef: "e2e-1", checkedAt: "2026-08-21" });

/** Trusted registry mirroring the issue fixtures: Sol via Codex and ClinePass,
 * DeepSeek V4 Pro via ClinePass and DeepSeek, plus an Anthropic family row. */
const gatewayRegistry: RegistryDocument = Object.freeze({
  registryRevision: MODEL_REGISTRY_REVISION,
  models: Object.freeze([
    reviewedModel({
      accessProviderId: "codex", upstreamModelId: "gpt-5.6-sol", modelFamily: "openai/codex",
      verifiedAt: "2026-08-21", fixtureVersion: "codex-oauth-chat-v1", capabilities: capabilities(),
      compatibility: VERIFIED,
    }),
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "gpt-5.6-sol", modelFamily: "openai/codex",
      verifiedAt: "2026-08-21", fixtureVersion: "cline-interop-chat-v1", capabilities: capabilities(),
      compatibility: VERIFIED,
    }),
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "deepseek-v4-pro", modelFamily: "deepseek",
      verifiedAt: "2026-08-21", fixtureVersion: "cline-interop-chat-v1", capabilities: capabilities(),
      compatibility: VERIFIED,
    }),
    reviewedModel({
      accessProviderId: "cline", upstreamModelId: "claude-fable", modelFamily: "anthropic",
      verifiedAt: "2026-08-21", fixtureVersion: "cline-interop-chat-v1", capabilities: capabilities(),
      compatibility: VERIFIED,
    }),
    reviewedModel({
      accessProviderId: "deepseek", upstreamModelId: "deepseek-v4-pro", modelFamily: "deepseek",
      verifiedAt: "2026-08-21", fixtureVersion: "openai-chat-v1", capabilities: capabilities(),
      compatibility: VERIFIED,
    }),
    reviewedModel({
      accessProviderId: "deepseek", upstreamModelId: "deepseek-v4-flash", modelFamily: "deepseek",
      verifiedAt: "2026-08-21", fixtureVersion: "openai-chat-v1", capabilities: capabilities(),
      compatibility: EXPERIMENTAL,
    }),
  ]),
});

type Received = Record<"codex" | "cline" | "deepseek", string[]>;

async function seedProviders(directory: string, endpoints: Readonly<{ codex: string; cline: string; deepseek: string }>) {
  const opened = await ControlPlaneStore.open(directory);
  const creds = await CredentialBroker.open(directory);
  await seedCodexClaudeProfile(opened, creds, directory, {
    endpoint: endpoints.codex,
    profileName: "work",
    modelRoles: { primary: "gpt-5.6-sol", fast: "gpt-5.6-sol", reasoning: "gpt-5.6-sol" },
  });
  await seedClineClaudeProfile(opened, creds, directory, { endpoint: endpoints.cline, profileName: "clinepass" });
  const deepseek = opened.createProvider({ name: "deepseek", integrationMode: "direct", endpointPolicy: endpoints.deepseek }, "cli");
  const account = opened.createAccount({ pseudonym: "acct-deepseek-a", providerId: deepseek.id, credentialHandle: "env:DEEPSEEK_API_KEY" }, "cli");
  opened.bindCredential(account.id, account.version, { credentialHandle: "env:DEEPSEEK_API_KEY", credentialGeneration: 1, state: "ready" }, "cli");
  opened.createPool({ name: "deepseek-pool", providerId: deepseek.id, strategy: "fill-first", retryBudget: 1, accountIds: [account.id] }, "cli");
  return { store: opened, broker: creds };
}

async function openGateway(
  directory: string,
  input: Readonly<{ endpoints: Readonly<{ codex: string; cline: string; deepseek: string }>; config?: GatewayConfig; registry?: RegistryDocument }>,
): Promise<{ store: ControlPlaneStore; broker: CredentialBroker; leaseManager: LeaseManager; sessions: LaunchSessionRegistry; traces: RouteTraceRing }> {
  let seededStore = store;
  let seededBroker = broker;
  if (seededStore === undefined || seededBroker === undefined) {
    const seeded = await seedProviders(directory, input.endpoints);
    seededStore = seeded.store;
    seededBroker = seeded.broker;
  }
  store = seededStore;
  broker = seededBroker;
  leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
  const sessions = new LaunchSessionRegistry((id) => leases?.has(id) === true);
  const traces = new RouteTraceRing();
  const config = input.config ?? gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17891, logLevel: "silent" } });
  app = createGatewayServer({
    host: "127.0.0.1",
    port: 17891,
    authToken: "instance-secret",
    instanceId: "00000000-0000-4000-8000-000000000401",
    configFingerprint: "c".repeat(64),
    config,
    environment: { DEEPSEEK_API_KEY: "fixture-key", OPENROUTER_API_KEY: "fixture-key" },
    controlPlane: store,
    broker,
    selector: new RouteSelector(store, new AffinityStore(directory)),
    launchSessions: sessions,
    traces,
    leases,
    ...(input.registry === undefined ? {} : { modelRegistry: input.registry }),
  });
  return { store, broker, leaseManager: leases, sessions, traces };
}

function requireApp(): FastifyInstance {
  if (!app) throw new Error("missing gateway");
  return app;
}

async function startUpstreams(): Promise<{ endpoints: { codex: string; cline: string; deepseek: string }; received: Received }> {
  const received: Received = { codex: [], cline: [], deepseek: [] };
  const endpoints: { codex: string; cline: string; deepseek: string } = { codex: "", cline: "", deepseek: "" };
  for (const name of ["codex", "cline", "deepseek"] as const) {
    const server = Fastify();
    upstreams.push(server);
    server.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown };
      if (typeof body.model === "string") received[name].push(body.model);
      return new Response(sseFixture(name, `${name.toUpperCase()}_OK`), { headers: { "content-type": "text/event-stream" } });
    });
    endpoints[name] = await server.listen({ host: "127.0.0.1", port: 0 });
  }
  return { endpoints, received };
}

type ModelRow = {
  type?: unknown;
  id?: unknown;
  display_name?: unknown;
  created_at?: unknown;
  max_input_tokens?: unknown;
  max_tokens?: unknown;
};

function modelsOf(payload: unknown): ModelRow[] {
  if (payload === null || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  return Array.isArray(data) ? data as ModelRow[] : [];
}

async function discover(token?: string): Promise<{ rows: ModelRow[]; body: Record<string, unknown> }> {
  const response = await requireApp().inject({
    method: "GET",
    url: "/v1/models",
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });
  expect(response.statusCode).toBe(200);
  const parsed: unknown = response.json();
  const body = parsed as Record<string, unknown>;
  return { rows: modelsOf(body), body };
}

async function issueToken(profileName = "work"): Promise<string> {
  const leaseId = "00000000-0000-4000-8000-000000000411";
  if (!leases) throw new Error("missing leases");
  await leases.add(leaseId);
  const issued = await requireApp().inject({
    method: "POST",
    url: "/v1/launch-sessions",
    headers: { authorization: "Bearer instance-secret", "content-type": "application/json" },
    payload: { profileName, leaseId },
  });
  expect(issued.statusCode).toBe(201);
  const body: unknown = issued.json();
  const token = body && typeof body === "object" && "token" in body && typeof body.token === "string" ? body.token : "";
  expect(token).not.toBe("");
  return token;
}

function projectionId(rows: ModelRow[], displayName: string): string {
  const row = rows.find((entry) => entry.display_name === displayName);
  if (row === undefined || typeof row.id !== "string") throw new Error(`missing projection ${displayName}`);
  return row.id;
}

describe("gateway model discovery and projection routing (#72)", () => {
  it("requires launch/gateway credentials for /v1/models", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-models-"));
    directories.push(directory);
    const { endpoints } = await startUpstreams();
    await openGateway(directory, { endpoints, registry: gatewayRegistry });
    const blocked = await requireApp().inject({ method: "GET", url: "/v1/models" });
    expect(blocked.statusCode).toBe(401);
    const badToken = await requireApp().inject({ method: "GET", url: "/v1/models", headers: { authorization: "Bearer wrong" } });
    expect(badToken.statusCode).toBe(401);
  });

  it("discovers VERIFIED models from all configured provider bindings and routes each exact selection to its own provider pool", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-models-"));
    directories.push(directory);
    const { endpoints, received } = await startUpstreams();
    const { traces } = await openGateway(directory, { endpoints, registry: gatewayRegistry });

    // Instance-token discovery: the full configured universe.
    const instance = await discover("instance-secret");
    const instanceIds = instance.rows.map((row) => row.id).filter((id): id is string => typeof id === "string");
    expect(instanceIds.length).toBeGreaterThanOrEqual(5);
    // Regression canary: every discoverable id satisfies the Claude Code filter.
    for (const id of instanceIds) {
      expect(id.startsWith("claude") || id.startsWith("anthropic")).toBe(true);
      expect(id.startsWith(RLY_MODEL_PREFIX)).toBe(true);
    }
    const displays = instance.rows.map((row) => row.display_name).filter((name): name is string => typeof name === "string");
    // Same upstream model through two providers => two distinct selectable targets.
    expect(displays).toContain("GPT-5.6 Sol (Codex)");
    expect(displays).toContain("GPT-5.6 Sol (ClinePass)");
    expect(displays).toContain("DeepSeek V4 Pro (ClinePass)");
    expect(displays).toContain("DeepSeek V4 Pro (DeepSeek)");
    expect(displays).toContain("Claude Fable (ClinePass)");
    // EXPERIMENTAL is excluded by default; BROKEN/unreviewed are never present.
    expect(displays).not.toContain("DeepSeek V4 Flash (DeepSeek)");
    // Anthropic-compatible wire shape.
    for (const row of instance.rows) {
      expect(row.type).toBe("model");
      expect(typeof row.id).toBe("string");
      expect(typeof row.display_name).toBe("string");
      expect(typeof row.created_at).toBe("string");
      expect(Number.isNaN(Date.parse(String(row.created_at)))).toBe(false);
    }
    expect(instance.body["has_more"]).toBe(false);
    expect(instance.body["first_id"]).toBe(instanceIds[0]);
    expect(instance.body["last_id"]).toBe(instanceIds.at(-1));
    // Secret-free discovery payload.
    expect(JSON.stringify(instance.body)).not.toMatch(/token|secret|authorization|fixture-key|email|prompt|response/i);

    // Session token: the pinned universe (same policy at issue time).
    const token = await issueToken();
    const session = await discover(token);
    const sessionDisplays = session.rows.map((row) => row.display_name);
    expect(sessionDisplays).toEqual(expect.arrayContaining(displays));

    // Selecting GPT-5.6 Sol (Codex) routes to the Codex provider pool.
    const codexSol = projectionId(session.rows, "GPT-5.6 Sol (Codex)");
    const codexRequest = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: codexSol, max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(codexRequest.statusCode).toBe(200);
    expect(codexRequest.body).toContain("CODEX_OK");
    expect(received.codex).toEqual(["gpt-5.6-sol"]);
    expect(received.cline).toEqual([]);

    // Selecting GPT-5.6 Sol (ClinePass) routes to the ClinePass pool.
    const clineSol = projectionId(session.rows, "GPT-5.6 Sol (ClinePass)");
    const clineRequest = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: clineSol, max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(clineRequest.statusCode).toBe(200);
    expect(clineRequest.body).toContain("CLINE_OK");
    expect(received.cline).toEqual(["gpt-5.6-sol"]);
    expect(received.codex).toEqual(["gpt-5.6-sol"]);

    // Selecting DeepSeek V4 Pro (DeepSeek) routes to the DeepSeek pool.
    const deepseekPro = projectionId(session.rows, "DeepSeek V4 Pro (DeepSeek)");
    const deepseekRequest = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: deepseekPro, max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(deepseekRequest.statusCode).toBe(200);
    expect(deepseekRequest.body).toContain("DEEPSEEK_OK");
    expect(received.deepseek).toEqual(["deepseek-v4-pro"]);

    // Route trace: projection id/display as allowlisted metadata, then the
    // exact model-selection and account decisions; fully secret-free.
    const traced = await requireApp().inject({ method: "GET", url: "/v1/route-traces", headers: { authorization: `Bearer ${token}` } });
    const tracedBody: unknown = traced.json();
    const body = tracedBody && typeof tracedBody === "object" && "traces" in tracedBody
      ? tracedBody as { traces: { projection?: { projectionId?: string; displayName?: string }; modelSelection?: { selectedLogicalId?: string; source?: string }; selected?: { accountPseudonym?: string } }[] }
      : { traces: [] };
    const codexTrace = body.traces.find((item) => item.projection?.displayName === "GPT-5.6 Sol (Codex)");
    expect(codexTrace?.projection?.projectionId).toBe(codexSol);
    expect(codexTrace?.modelSelection?.selectedLogicalId).toBe("codex/gpt-5.6-sol");
    expect(codexTrace?.modelSelection?.source).toBe("exact");
    expect(codexTrace?.selected?.accountPseudonym).toBe("acct-codex-a");
    const clineTrace = body.traces.find((item) => item.projection?.displayName === "GPT-5.6 Sol (ClinePass)");
    expect(clineTrace?.selected?.accountPseudonym).toBe("acct-cline-a");
    const deepseekTrace = body.traces.find((item) => item.projection?.displayName === "DeepSeek V4 Pro (DeepSeek)");
    expect(deepseekTrace?.selected?.accountPseudonym).toBe("acct-deepseek-a");
    expect(JSON.stringify(body)).not.toMatch(/token|secret|authorization|fixture-key|prompt|response|email/i);
    expect(traces.list("work").length).toBeGreaterThanOrEqual(3);
  });

  it("keeps an issued session's universe pinned when policy changes, and fails closed on unknown targets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-models-pin-"));
    directories.push(directory);
    const { endpoints, received } = await startUpstreams();
    const seeded = await openGateway(directory, { endpoints, registry: gatewayRegistry });
    const token = await issueToken();
    const before = await discover(token);
    const codexSol = projectionId(before.rows, "GPT-5.6 Sol (Codex)");

    // Policy change after session issue: a new provider+pool becomes eligible.
    const openrouterServer = Fastify();
    upstreams.push(openrouterServer);
    openrouterServer.post("/chat/completions", () => new Response(sseFixture("or", "OPENROUTER_OK"), { headers: { "content-type": "text/event-stream" } }));
    const openrouterEndpoint = await openrouterServer.listen({ host: "127.0.0.1", port: 0 });
    const openrouter = seeded.store.createProvider({ name: "openrouter", integrationMode: "direct", endpointPolicy: openrouterEndpoint }, "cli");
    const openrouterAccount = seeded.store.createAccount({ pseudonym: "acct-or-a", providerId: openrouter.id, credentialHandle: "env:OPENROUTER_API_KEY" }, "cli");
    seeded.store.bindCredential(openrouterAccount.id, openrouterAccount.version, { credentialHandle: "env:OPENROUTER_API_KEY", credentialGeneration: 1, state: "ready" }, "cli");
    seeded.store.createPool({ name: "or-pool", providerId: openrouter.id, strategy: "fill-first", retryBudget: 1, accountIds: [openrouterAccount.id] }, "cli");

    // The active session's discovery is pinned: no silent remapping to the new
    // provider, and the already-issued projection id still resolves to the same
    // canonical target + pool.
    const after = await discover(token);
    expect(after.rows.map((row) => row.display_name)).toEqual(before.rows.map((row) => row.display_name));
    expect(after.rows.map((row) => row.display_name)).not.toContain(expect.stringMatching(/OpenRouter|Nemotron/));
    const request = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: codexSol, max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(request.statusCode).toBe(200);
    expect(received.codex).toEqual(["gpt-5.6-sol"]);

    // An unknown projection id fails closed with an actionable typed error —
    // never a silent model/provider substitution.
    const unknown = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: `${RLY_MODEL_PREFIX}codex-000000000000`, max_tokens: 8, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(unknown.statusCode).toBe(400);
    const unknownBody: { error?: { type?: string } } = unknown.json();
    expect(unknownBody.error?.type).toBe("model-unavailable");
    // A BROKEN/removed model is never discoverable, so its projection id fails
    // closed even when a user persisted it earlier.
    const flashId = `${RLY_MODEL_PREFIX}deepseek-000000000001`;
    const flash = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: flashId, max_tokens: 8, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(flash.statusCode).toBe(400);
    expect(flash.json<{ error?: { type?: string } }>().error?.type).toBe("model-unavailable");
  });

  it("exposes EXPERIMENTAL models only through the explicit config opt-in", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-models-exp-"));
    directories.push(directory);
    const { endpoints } = await startUpstreams();
    await openGateway(directory, { endpoints, registry: gatewayRegistry });
    const defaultRows = (await discover("instance-secret")).rows;
    expect(defaultRows.map((row) => row.display_name)).not.toContain("DeepSeek V4 Flash (DeepSeek)");

    // Second gateway on the same store with the explicit opt-in.
    await requireApp().close();
    app = undefined;
    leases?.dispose();
    leases = undefined;
    await openGateway(directory, {
      endpoints,
      registry: directProviderRegistry,
      config: gatewayConfigSchema.parse({
        schemaVersion: 1,
        gateway: { port: 17891, logLevel: "silent", modelDiscovery: { experimentalModels: true } },
      }),
    });
    const optInRows = (await discover("instance-secret")).rows;
    expect(optInRows.map((row) => row.display_name)).toContain("DeepSeek V4 Flash (DeepSeek)");
  });

  it("emits Anthropic-shaped token limits only when the projection has evidenced numbers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-models-limits-"));
    directories.push(directory);
    const { endpoints } = await startUpstreams();
    const seeded = await openGateway(directory, {
      endpoints,
      registry: directProviderRegistry,
      config: gatewayConfigSchema.parse({
        schemaVersion: 1,
        gateway: { port: 17891, logLevel: "silent", modelDiscovery: { experimentalModels: true } },
      }),
    });
    const openrouterServer = Fastify();
    upstreams.push(openrouterServer);
    openrouterServer.post("/chat/completions", () => new Response(sseFixture("or", "OPENROUTER_OK"), { headers: { "content-type": "text/event-stream" } }));
    const openrouterEndpoint = await openrouterServer.listen({ host: "127.0.0.1", port: 0 });
    const openrouter = seeded.store.createProvider({ name: "openrouter", integrationMode: "direct", endpointPolicy: openrouterEndpoint }, "cli");
    const openrouterAccount = seeded.store.createAccount({
      pseudonym: "acct-or-a",
      providerId: openrouter.id,
      credentialHandle: "env:OPENROUTER_API_KEY",
    }, "cli");
    seeded.store.bindCredential(openrouterAccount.id, openrouterAccount.version, {
      credentialHandle: "env:OPENROUTER_API_KEY",
      credentialGeneration: 1,
      state: "ready",
    }, "cli");
    seeded.store.createPool({
      name: "or-pool",
      providerId: openrouter.id,
      strategy: "fill-first",
      retryBudget: 1,
      accountIds: [openrouterAccount.id],
    }, "cli");
    const { rows } = await discover("instance-secret");
    const limited = rows.find((row) => row.display_name === "DeepSeek V4 Flash 0731 (OpenRouter)");
    expect(limited?.max_input_tokens).toBe(1_310_720);
    expect(limited?.max_tokens).toBe(393_216);
    const unlimited = rows.find((row) => row.display_name === "NVIDIA Nemotron 3.5 Lightning (Free) (OpenRouter)");
    expect(unlimited).toBeDefined();
    expect(unlimited).not.toHaveProperty("max_input_tokens");
    expect(unlimited).not.toHaveProperty("max_tokens");
    const deepseekFlash = rows.find((row) => row.display_name === "DeepSeek V4 Flash (DeepSeek)");
    expect(deepseekFlash).toBeDefined();
    expect(deepseekFlash).not.toHaveProperty("max_input_tokens");
    expect(deepseekFlash).not.toHaveProperty("max_tokens");
  });

  it("#J1 UX: an empty discovery carries a secret-free note explaining why, never a bare empty list", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-models-note-"));
    directories.push(directory);
    const { endpoints } = await startUpstreams();
    // Default config: experimentalModels=false, and the shipped registry
    // models are all EXPERIMENTAL without reviewed evidence → discovery empty.
    await openGateway(directory, { endpoints, registry: directProviderRegistry });
    const response = await requireApp().inject({ method: "GET", url: "/v1/models", headers: { authorization: "Bearer instance-secret" } });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ data?: unknown[]; note?: string }>();
    expect(body.data).toEqual([]);
    // The Claude-compatible wire shape is preserved; the note explains the
    // empty result and how to unblock (secret-free).
    expect(typeof body.note).toBe("string");
    expect(body.note).toContain("EXPERIMENTAL");
    expect(body.note).toContain("experimentalModels");
    // With the opt-in the note disappears (models are discoverable).
    await requireApp().close();
    app = undefined;
    leases?.dispose();
    leases = undefined;
    await openGateway(directory, {
      endpoints,
      registry: directProviderRegistry,
      config: gatewayConfigSchema.parse({
        schemaVersion: 1,
        gateway: { port: 17891, logLevel: "silent", modelDiscovery: { experimentalModels: true } },
      }),
    });
    const optIn = await requireApp().inject({ method: "GET", url: "/v1/models", headers: { authorization: "Bearer instance-secret" } });
    const optInBody = optIn.json<{ data?: unknown[]; note?: string }>();
    expect(optInBody.data?.length).toBeGreaterThan(0);
    expect(optInBody.note).toBeUndefined();
  });

  it("supports limit and cursor pagination deterministically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-models-page-"));
    directories.push(directory);
    const { endpoints } = await startUpstreams();
    await openGateway(directory, { endpoints, registry: gatewayRegistry });
    const page1 = await requireApp().inject({ method: "GET", url: "/v1/models?limit=2", headers: { authorization: "Bearer instance-secret" } });
    expect(page1.statusCode).toBe(200);
    const page1Body = page1.json<{ data?: ModelRow[]; has_more?: boolean; last_id?: unknown }>();
    expect(page1Body.data?.length).toBe(2);
    expect(page1Body.has_more).toBe(true);
    expect(typeof page1Body.last_id).toBe("string");
    const page2 = await requireApp().inject({
      method: "GET",
      url: `/v1/models?limit=2&after_id=${encodeURIComponent(String(page1Body.last_id))}`,
      headers: { authorization: "Bearer instance-secret" },
    });
    const page2Body = page2.json<{ data?: ModelRow[]; last_id?: unknown; has_more?: boolean }>();
    expect(page2Body.data?.length).toBeGreaterThan(0);
    const ids1 = (page1Body.data ?? []).map((row) => row.id);
    const ids2 = (page2Body.data ?? []).map((row) => row.id);
    for (const id of ids2) expect(ids1).not.toContain(id);
    const invalid = await requireApp().inject({ method: "GET", url: "/v1/models?limit=0", headers: { authorization: "Bearer instance-secret" } });
    expect(invalid.statusCode).toBe(400);
  });

  it("passes #68 capability and #70 reasoning validation for a projected exact model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-models-reason-"));
    directories.push(directory);
    const { endpoints, received } = await startUpstreams();
    await openGateway(directory, { endpoints, registry: gatewayRegistry });
    const token = await issueToken();
    const session = await discover(token);
    const codexSol = projectionId(session.rows, "GPT-5.6 Sol (Codex)");
    // #70: an explicit thinking request on the exact projected model resolves
    // deterministically and streams; #68 exact selection stays on the target.
    const thinking = await requireApp().inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { model: codexSol, max_tokens: 8, stream: true, thinking: { type: "enabled" }, messages: [{ role: "user", content: "fixture" }] },
    });
    expect(thinking.statusCode).toBe(200);
    expect(received.codex).toEqual(["gpt-5.6-sol"]);
    const traced = await requireApp().inject({ method: "GET", url: "/v1/route-traces", headers: { authorization: `Bearer ${token}` } });
    const tracedBody: unknown = traced.json();
    const body = tracedBody && typeof tracedBody === "object" && "traces" in tracedBody
      ? tracedBody as { traces: { reasoning?: { canonicalIntent?: string; mappingKind?: string }; modelSelection?: { selectedLogicalId?: string } }[] }
      : { traces: [] };
    const trace = body.traces.at(-1);
    expect(trace?.reasoning?.canonicalIntent).toBe("BALANCED");
    expect(trace?.reasoning?.mappingKind).toBe("normalized");
    expect(trace?.modelSelection?.selectedLogicalId).toBe("codex/gpt-5.6-sol");
    expect(JSON.stringify(body)).not.toMatch(/token|secret|authorization|fixture-key|prompt|response|email/i);
  });
});
