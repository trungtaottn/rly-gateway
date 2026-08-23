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
import { seedClineClaudeProfile, sseFixture } from "../helpers/cline-profile-seed.js";

const directories: string[] = [];
let app: FastifyInstance | undefined;
let store: ControlPlaneStore | undefined;
let broker: CredentialBroker | undefined;
let provider: FastifyInstance | undefined;
let leases: LeaseManager | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await provider?.close();
  provider = undefined;
  await broker?.close();
  broker = undefined;
  store?.close();
  store = undefined;
  leases?.dispose();
  leases = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface TraceShape {
  sourceRule?: string;
  selected?: unknown;
  intent?: { kind?: string; sourceSelector?: string; source?: string; tier?: string; alias?: string; modelId?: string; role?: string };
  tierResolution?: { requestedTier?: string; modelFamily?: string; selectedLogicalId?: string };
  modelSelection?: { selectedLogicalId?: string; source?: string };
}

async function openApp(directory: string, endpoint: string) {
  store = await ControlPlaneStore.open(directory);
  broker = await CredentialBroker.open(directory);
  await seedClineClaudeProfile(store, broker, directory, {
    endpoint,
    // Terra-class parent scopes every tier request to the OpenAI/Codex family.
    modelRoles: { primary: "gpt-5.6-terra" },
  });
  leases = new LeaseManager({ ttlMs: 60_000, idleGraceMs: 60_000, onIdle: () => undefined });
  const sessions = new LaunchSessionRegistry((id) => leases?.has(id) === true);
  const traces = new RouteTraceRing();
  const config = gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17891, logLevel: "silent" } });
  app = createGatewayServer({
    host: "127.0.0.1",
    port: 17891,
    authToken: "instance-secret",
    instanceId: "00000000-0000-4000-8000-000000000312",
    configFingerprint: "c".repeat(64),
    config,
    controlPlane: store,
    broker,
    selector: new RouteSelector(store, new AffinityStore(directory)),
    launchSessions: sessions,
    traces,
    leases,
  });
  return { traces };
}

function requireApp(): FastifyInstance {
  if (!app) throw new Error("missing gateway");
  return app;
}

async function issueToken(profileName = "clinepass"): Promise<string> {
  const leaseId = "00000000-0000-4000-8000-000000000313";
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

async function sendModel(token: string, model: string): Promise<{ statusCode: number; body: string; json: () => unknown }> {
  return requireApp().inject({
    method: "POST",
    url: "/v1/messages",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: { model, max_tokens: 8, stream: true, messages: [{ role: "user", content: "fixture" }] },
  });
}

async function latestTrace(token: string): Promise<TraceShape> {
  const listed = await requireApp().inject({
    method: "GET",
    url: "/v1/route-traces",
    headers: { authorization: `Bearer ${token}` },
  });
  const body: unknown = listed.json();
  const traces = body && typeof body === "object" && "traces" in body && Array.isArray(body.traces) ? body.traces : [];
  const last = traces.at(-1) as TraceShape | undefined;
  return last ?? {};
}

describe("model-intent selector routing (#125)", () => {
  it("routes bare aliases, explicit RLY tier selectors, exact models, default, and inherit as distinct intents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-model-intent-"));
    directories.push(directory);
    const received: { model?: string }[] = [];
    provider = Fastify();
    provider.post("/chat/completions", (request) => {
      const body = request.body as { model?: unknown };
      if (typeof body.model === "string") received.push({ model: body.model });
      return new Response(sseFixture("model-intent", "MODEL_INTENT_OK"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    await openApp(directory, endpoint);
    const token = await issueToken();

    // 1. Bare `fable` is a client-native alias, deliberately mapped to the
    //    fable tier, then resolved contextually by #69 (same provider+family).
    const bare = await sendModel(token, "fable");
    expect(bare.statusCode).toBe(200);
    expect(bare.body).toContain("MODEL_INTENT_OK");
    expect(received.at(-1)?.model).toBe("gpt-5.6-sol");
    let trace = await latestTrace(token);
    expect(trace.intent).toMatchObject({ kind: "CLIENT_NATIVE_ALIAS", sourceSelector: "fable", source: "client-native-alias-contract", tier: "fable", alias: "fable" });
    expect(trace.tierResolution?.requestedTier).toBe("fable");
    expect(trace.tierResolution?.selectedLogicalId).toBe("cline/gpt-5.6-sol");

    // 2. Explicit `rly-tier:fable` is RLY policy, same contextual target but a
    //    different intent kind/provenance than the bare alias.
    const explicit = await sendModel(token, "rly-tier:fable");
    expect(explicit.statusCode).toBe(200);
    expect(explicit.body).toContain("MODEL_INTENT_OK");
    expect(received.at(-1)?.model).toBe("gpt-5.6-sol");
    trace = await latestTrace(token);
    expect(trace.intent).toMatchObject({ kind: "RLY_LOGICAL_TIER", sourceSelector: "rly-tier:fable", source: "rly-tier-namespace", tier: "fable" });
    expect(trace.intent?.alias).toBeUndefined();
    expect(trace.tierResolution?.selectedLogicalId).toBe("cline/gpt-5.6-sol");

    // 3. An invalid RLY namespace selector fails closed with the typed
    //    unknown-namespace reason and is never reinterpreted as an alias/model.
    const unknown = await sendModel(token, "rly-tier:gpt-5.6-sol");
    expect(unknown.statusCode).toBe(400);
    const unknownBody = unknown.json() as { error?: { type?: string; reason?: string } };
    expect(unknownBody.error?.type).toBe("role-unmapped");
    expect(unknownBody.error?.reason).toBe("unknown-namespace");
    const unknownTrace = await latestTrace(token);
    expect(unknownTrace.sourceRule).toBe("model-selection:unknown-namespace");
    expect(unknownTrace.intent).toMatchObject({ sourceSelector: "rly-tier:gpt-5.6-sol" });
    expect(unknownTrace.selected).toBeUndefined();
    expect(JSON.stringify(unknownTrace)).not.toMatch(/authorization|prompt|secret/i);

    // 4. A persisted exact model id is classified as EXACT_CLIENT_MODEL and
    //    resolves through the profile role mapping — never as a tier.
    const exact = await sendModel(token, "gpt-5.6-terra");
    expect(exact.statusCode).toBe(200);
    expect(received.at(-1)?.model).toBe("gpt-5.6-terra");
    trace = await latestTrace(token);
    expect(trace.intent).toMatchObject({ kind: "EXACT_CLIENT_MODEL", sourceSelector: "gpt-5.6-terra", source: "exact-model", modelId: "gpt-5.6-terra", role: "primary" });
    expect(trace.intent?.tier).toBeUndefined();

    // 5. `default` resolves to the profile primary role.
    const byDefault = await sendModel(token, "default");
    expect(byDefault.statusCode).toBe(200);
    expect(received.at(-1)?.model).toBe("gpt-5.6-terra");
    trace = await latestTrace(token);
    expect(trace.intent).toMatchObject({ kind: "DEFAULT", sourceSelector: "default", source: "default", modelId: "gpt-5.6-terra", role: "primary" });

    // 6. `inherit` with no parent execution context falls back to the profile
    //    default — never a literal role lookup on the string "inherit".
    const inherit = await sendModel(token, "inherit");
    expect(inherit.statusCode).toBe(200);
    expect(received.at(-1)?.model).toBe("gpt-5.6-terra");
    trace = await latestTrace(token);
    expect(trace.intent).toMatchObject({ kind: "INHERIT", sourceSelector: "inherit", source: "inherit", modelId: "gpt-5.6-terra", role: "primary" });

    // Every selector upstream and trace stays secret-free.
    expect(JSON.stringify(received)).not.toMatch(/cline-access-token-fixture|refresh-token|authorization|prompt|@/i);
    const listed = await requireApp().inject({
      method: "GET",
      url: "/v1/route-traces",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.stringify(listed.json())).not.toMatch(/cline-access-token-fixture|refresh-token|authorization|prompt|@|api[_-]?key/i);
  });

  it("dispatches projection selectors before intent classification and never treats them as tiers/aliases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-model-intent-proj-"));
    directories.push(directory);
    provider = Fastify();
    provider.post("/chat/completions", () => {
      throw new Error("projection failures must not reach the upstream");
    });
    const endpoint = await provider.listen({ host: "127.0.0.1", port: 0 });
    await openApp(directory, endpoint);
    const token = await issueToken();
    // An unknown projection id fails closed as model-unavailable at the
    // projection dispatch boundary; it is never reinterpreted as a tier/alias.
    const unknown = await sendModel(token, "claude-rly-unknown-xyz");
    expect(unknown.statusCode).toBe(400);
    const body = unknown.json() as { error?: { type?: string } };
    expect(body.error?.type).toBe("model-unavailable");
  });
});
