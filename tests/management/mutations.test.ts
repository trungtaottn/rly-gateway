import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { createManagementServer } from "../../src/management/server.js";
import { SessionStore } from "../../src/management/session-store.js";

const directories: string[] = [];
let app: FastifyInstance | undefined;
let store: ControlPlaneStore | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  store?.close();
  store = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function start() {
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-mut-"));
  directories.push(directory);
  store = await ControlPlaneStore.open(directory);
  app = createManagementServer({
    host: "127.0.0.1",
    port: 17872,
    origin: "http://127.0.0.1:17872",
    managementToken: "mgmt-secret",
    instanceId: "00000000-0000-4000-8000-000000000099",
    configFingerprint: "a".repeat(64),
    store,
    sessions: new SessionStore(),
  });
}

const auth = {
  authorization: "Bearer mgmt-secret",
  origin: "http://127.0.0.1:17872",
  "content-type": "application/json",
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
  return value as Record<string, unknown>;
}

function asItems(value: unknown): unknown[] {
  const items = asRecord(value)["items"];
  if (!Array.isArray(items)) throw new Error("expected items");
  return items;
}

describe("management mutations", () => {
  it("creates and updates providers, accounts, pools, and profiles through secret-free DTOs", async () => {
    await start();
    if (!app) throw new Error("missing app");
    const provider = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: auth,
      payload: { name: "codex", integrationMode: "oauth", requiredTermsRevision: "terms-1" },
    });
    expect(provider.statusCode).toBe(201);
    const providerId = String(asRecord(provider.json())["id"]);
    const account = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: auth,
      payload: { pseudonym: "acct-001", providerId, credentialHandle: "cred-001" },
    });
    const accountId = String(asRecord(account.json())["id"]);
    const paused = await app.inject({
      method: "PATCH",
      url: `/v1/accounts/${accountId}`,
      headers: auth,
      payload: { version: asRecord(account.json())["version"], state: "paused" },
    });
    expect(asRecord(paused.json())).toMatchObject({ state: "paused", pseudonym: "acct-001" });
    expect(JSON.stringify(paused.json())).not.toMatch(/accessToken|refreshToken|email|authorization/i);
    const terms = await app.inject({
      method: "PATCH",
      url: `/v1/accounts/${accountId}`,
      headers: auth,
      payload: { version: asRecord(paused.json())["version"], termsRevision: "terms-1" },
    });
    expect(asRecord(terms.json())).toMatchObject({ termsAcknowledgedRevision: "terms-1" });
    const pool = await app.inject({
      method: "POST",
      url: "/v1/pools",
      headers: auth,
      payload: {
        name: "pool-a",
        providerId,
        strategy: "fill-first",
        accountIds: [accountId],
      },
    });
    const profile = await app.inject({
      method: "POST",
      url: "/v1/profiles",
      headers: auth,
      payload: {
        name: "work",
        harness: "claude",
        providerId,
        poolId: asRecord(pool.json())["id"],
        modelRoles: { primary: "role-a" },
      },
    });
    expect(profile.statusCode).toBe(201);
    const policy = await app.inject({ method: "GET", url: "/v1/policy", headers: auth });
    expect(Number(asRecord(policy.json())["revision"])).toBeGreaterThan(0);
    expect(JSON.stringify(policy.json())).not.toMatch(/accessToken|refreshToken|email/i);
  });

  it("rejects unauthorized and stale-version mutations without partial state", async () => {
    await start();
    if (!app) throw new Error("missing app");
    const created = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: auth,
      payload: { name: "openrouter", integrationMode: "direct" },
    });
    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: { origin: "http://127.0.0.1:17872", "content-type": "application/json" },
      payload: { name: "blocked", integrationMode: "direct" },
    });
    expect(unauthorized.statusCode).toBe(401);
    const stale = await app.inject({
      method: "PATCH",
      url: `/v1/providers/${String(asRecord(created.json())["id"])}`,
      headers: auth,
      payload: { version: 99, enabled: false },
    });
    expect(stale.statusCode).toBe(409);
    expect(asRecord(stale.json())["error"]).toBe("stale-version");
    const listed = await app.inject({ method: "GET", url: "/v1/providers", headers: auth });
    expect(asItems(listed.json())).toHaveLength(1);
    expect(asRecord(asItems(listed.json())[0])).toMatchObject({ name: "openrouter", enabled: true, version: 1 });
  });

  it("rejects uncatalogued names and Cline create without a safe endpoint", async () => {
    await start();
    if (!app) throw new Error("missing app");
    const unknown = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: auth,
      payload: { name: "keep", integrationMode: "direct" },
    });
    expect(unknown.statusCode).toBe(400);
    expect(asRecord(unknown.json())["error"]).toBe("invalid");
    const missingEndpoint = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: auth,
      payload: { name: "cline", integrationMode: "oauth" },
    });
    expect(missingEndpoint.statusCode).toBe(400);
    const protectedPort = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: auth,
      payload: { name: "cline", integrationMode: "oauth", endpointPolicy: "http://127.0.0.1:8317" },
    });
    expect(protectedPort.statusCode).toBe(400);
    const created = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: auth,
      payload: { name: "cline", integrationMode: "oauth", endpointPolicy: "https://example.invalid/clinepass" },
    });
    expect(created.statusCode).toBe(201);
    expect(asRecord(created.json())).toMatchObject({
      name: "cline",
      endpointPolicy: "https://example.invalid/clinepass",
    });
  });

  it("applies catalog terms and rejects a catalog name with the wrong mode", async () => {
    await start();
    if (!app) throw new Error("missing app");
    const alibaba = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: auth,
      payload: { name: "alibaba", integrationMode: "direct" },
    });
    expect(alibaba.statusCode).toBe(201);
    expect(asRecord(alibaba.json())).toMatchObject({
      name: "alibaba",
      requiredTermsRevision: "alibaba-terms-1",
    });
    const wrong = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: auth,
      payload: { name: "gemini", integrationMode: "direct" },
    });
    expect(wrong.statusCode).toBe(400);
  });

  it("deletes pools, accounts, and providers with a version check", async () => {
    await start();
    if (!app) throw new Error("missing app");
    const provider = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: auth,
      payload: { name: "openrouter", integrationMode: "direct" },
    });
    const providerId = String(asRecord(provider.json())["id"]);
    const account = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: auth,
      payload: { pseudonym: "acct-del", providerId, credentialHandle: "cred-del" },
    });
    const accountId = String(asRecord(account.json())["id"]);
    const pool = await app.inject({
      method: "POST",
      url: "/v1/pools",
      headers: auth,
      payload: { name: "pool-del", providerId, strategy: "fill-first", accountIds: [accountId] },
    });
    const poolId = String(asRecord(pool.json())["id"]);
    const stale = await app.inject({
      method: "DELETE",
      url: `/v1/pools/${poolId}`,
      headers: auth,
      payload: { version: 99 },
    });
    expect(stale.statusCode).toBe(409);
    const deletedPool = await app.inject({
      method: "DELETE",
      url: `/v1/pools/${poolId}`,
      headers: auth,
      payload: { version: asRecord(pool.json())["version"] },
    });
    expect(deletedPool.statusCode).toBe(200);
    expect(asRecord(deletedPool.json())).toMatchObject({ id: poolId });
    const deletedAccount = await app.inject({
      method: "DELETE",
      url: `/v1/accounts/${accountId}`,
      headers: auth,
      payload: { version: asRecord(account.json())["version"] },
    });
    expect(deletedAccount.statusCode).toBe(200);
    const deletedProvider = await app.inject({
      method: "DELETE",
      url: `/v1/providers/${providerId}`,
      headers: auth,
      payload: { version: asRecord(provider.json())["version"] },
    });
    expect(deletedProvider.statusCode).toBe(200);
    const listed = await app.inject({ method: "GET", url: "/v1/providers", headers: auth });
    expect(asItems(listed.json())).toHaveLength(0);
  });

});
