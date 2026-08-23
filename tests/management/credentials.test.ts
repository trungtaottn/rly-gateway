import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { CredentialBroker } from "../../src/credentials/broker.js";
import { CredentialService } from "../../src/credentials/service.js";
import { createManagementServer } from "../../src/management/server.js";
import { SessionStore } from "../../src/management/session-store.js";
import { fakeOauth, writeCodexSource } from "../credentials/helpers.js";

const directories: string[] = [];
let app: FastifyInstance | undefined;
let store: ControlPlaneStore | undefined;
let broker: CredentialBroker | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await broker?.close();
  broker = undefined;
  store?.close();
  store = undefined;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
  return value as Record<string, unknown>;
}

const auth = {
  authorization: "Bearer mgmt-secret",
  origin: "http://127.0.0.1:17872",
  "content-type": "application/json",
};

describe("management credential operations", () => {
  it("imports, selects, and revokes through secret-free DTOs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-mgmt-cred-"));
    directories.push(directory);
    store = await ControlPlaneStore.open(directory);
    broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    const credentials = new CredentialService(store, broker);
    app = createManagementServer({
      host: "127.0.0.1",
      port: 17872,
      origin: "http://127.0.0.1:17872",
      managementToken: "mgmt-secret",
      instanceId: "00000000-0000-4000-8000-000000000099",
      configFingerprint: "a".repeat(64),
      store,
      sessions: new SessionStore(),
      credentials,
    });
    const provider = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: auth,
      payload: { name: "codex", integrationMode: "oauth" },
    });
    const providerBody = asRecord(provider.json());
    const providerId = String(providerBody["id"]);
    const source = await writeCodexSource(directory);
    const preview = await app.inject({
      method: "POST",
      url: "/v1/credentials/import/preview",
      headers: auth,
      payload: { sourcePath: source.path, providerId },
    });
    expect(preview.statusCode).toBe(200);
    expect(JSON.stringify(preview.json())).not.toMatch(/access-token|refresh-token/i);
    const imported = await app.inject({
      method: "POST",
      url: "/v1/credentials/import",
      headers: auth,
      payload: {
        sourcePath: source.path,
        providerId,
        pseudonym: "acct-fixture-001",
        sourceFingerprint: source.sourceFingerprint,
      },
    });
    expect(imported.statusCode).toBe(201);
    const body = asRecord(imported.json());
    expect(body["readiness"]).toBe("ready");
    const selected = await app.inject({
      method: "POST",
      url: `/v1/accounts/${String(body["id"])}/select`,
      headers: auth,
      payload: { version: body["version"] },
    });
    expect(selected.statusCode).toBe(200);
    const revoked = await app.inject({
      method: "POST",
      url: `/v1/accounts/${String(body["id"])}/revoke`,
      headers: auth,
      payload: { version: body["version"] },
    });
    expect(revoked.statusCode).toBe(200);
    expect(asRecord(revoked.json())["state"]).toBe("revoked");
    expect(JSON.stringify(revoked.json())).not.toMatch(/accessToken|refreshToken/i);
  });

  it("imports Cline through the management API and refuses OAuth login", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-mgmt-cline-"));
    directories.push(directory);
    store = await ControlPlaneStore.open(directory);
    broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    const credentials = new CredentialService(store, broker);
    app = createManagementServer({
      host: "127.0.0.1",
      port: 17872,
      origin: "http://127.0.0.1:17872",
      managementToken: "mgmt-secret",
      instanceId: "00000000-0000-4000-8000-000000000099",
      configFingerprint: "a".repeat(64),
      store,
      sessions: new SessionStore(),
      credentials,
    });
    const provider = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: auth,
      payload: { name: "cline", integrationMode: "oauth", endpointPolicy: "https://example.invalid/clinepass" },
    });
    const providerId = String(asRecord(provider.json())["id"]);
    const sourcePath = join(directory, "cline-auth.json");
    const raw = JSON.stringify({ tokens: { access_token: "cline-access-fixture", refresh_token: "cline-refresh-fixture" } });
    const { writeFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    await writeFile(sourcePath, raw, "utf8");
    const preview = await app.inject({
      method: "POST",
      url: "/v1/credentials/import/preview",
      headers: auth,
      payload: { sourcePath, providerId },
    });
    expect(asRecord(preview.json())["provider"]).toBe("cline");
    const imported = await app.inject({
      method: "POST",
      url: "/v1/credentials/import",
      headers: auth,
      payload: {
        sourcePath,
        providerId,
        pseudonym: "acct-cline",
        sourceFingerprint: createHash("sha256").update(raw).digest("hex"),
      },
    });
    expect(imported.statusCode).toBe(201);
    const login = await app.inject({
      method: "POST",
      url: "/v1/credentials/login",
      headers: auth,
      payload: { providerId, pseudonym: "acct-cline-login" },
    });
    expect(login.statusCode).toBe(400);
    expect(asRecord(login.json())["error"]).toBe("invalid");
  });

  it("rejects credential preview without a providerId", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-mgmt-preview-"));
    directories.push(directory);
    store = await ControlPlaneStore.open(directory);
    broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    const credentials = new CredentialService(store, broker);
    app = createManagementServer({
      host: "127.0.0.1",
      port: 17872,
      origin: "http://127.0.0.1:17872",
      managementToken: "mgmt-secret",
      instanceId: "00000000-0000-4000-8000-000000000099",
      configFingerprint: "a".repeat(64),
      store,
      sessions: new SessionStore(),
      credentials,
    });
    const missing = await app.inject({
      method: "POST",
      url: "/v1/credentials/import/preview",
      headers: auth,
      payload: { sourcePath: join(directory, "cline-auth.json") },
    });
    expect(missing.statusCode).toBe(400);
    expect(asRecord(missing.json())["error"]).toBe("invalid");
  });

  it("creates a ready direct env account from a credential reference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-mgmt-env-"));
    directories.push(directory);
    store = await ControlPlaneStore.open(directory);
    broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    const environment: NodeJS.ProcessEnv = {};
    const credentials = new CredentialService(store, broker, environment);
    app = createManagementServer({
      host: "127.0.0.1",
      port: 17872,
      origin: "http://127.0.0.1:17872",
      managementToken: "mgmt-secret",
      instanceId: "00000000-0000-4000-8000-000000000099",
      configFingerprint: "a".repeat(64),
      store,
      sessions: new SessionStore(),
      credentials,
    });
    const provider = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: auth,
      payload: { name: "openrouter", integrationMode: "direct" },
    });
    const providerId = String(asRecord(provider.json())["id"]);
    const created = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: auth,
      payload: { pseudonym: "acct-or", providerId, credentialRef: "env:OPENROUTER_API_KEY" },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = asRecord(created.json());
    expect(createdBody).toMatchObject({
      pseudonym: "acct-or",
      credentialHandle: "env:OPENROUTER_API_KEY",
      generation: 1,
      state: "ready",
      readiness: "unready",
    });
    expect(JSON.stringify(created.json())).not.toMatch(/sk-|Bearer|secret-value/i);
    const listed = await app.inject({ method: "GET", url: "/v1/accounts", headers: auth });
    const items = asRecord(listed.json())["items"];
    expect(Array.isArray(items)).toBe(true);
    expect(asRecord((items as unknown[])[0])).toMatchObject({ readiness: "unready", generation: 1, state: "ready" });
    const selectedUnready = await app.inject({
      method: "POST",
      url: `/v1/accounts/${String(createdBody["id"])}/select`,
      headers: auth,
      payload: { version: createdBody["version"] },
    });
    expect(selectedUnready.statusCode).toBe(409);
    expect(asRecord(selectedUnready.json())).toMatchObject({ error: "credential-unready" });
    environment.OPENROUTER_API_KEY = "fixture-key";
    const listedReady = await app.inject({ method: "GET", url: "/v1/accounts", headers: auth });
    expect(asRecord((asRecord(listedReady.json())["items"] as unknown[])[0])).toMatchObject({ readiness: "ready" });
    const selectedReady = await app.inject({
      method: "POST",
      url: `/v1/accounts/${String(createdBody["id"])}/select`,
      headers: auth,
      payload: { version: createdBody["version"] },
    });
    expect(selectedReady.statusCode).toBe(200);
    expect(asRecord(selectedReady.json())).toMatchObject({ readiness: "ready" });
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: auth,
      payload: { pseudonym: "acct-secret", providerId, credentialRef: "sk-live-not-an-env" },
    });
    expect(rejected.statusCode).toBe(400);
    const generic = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: auth,
      payload: { pseudonym: "acct-generic", providerId, credentialHandle: "env:OPENROUTER_API_KEY" },
    });
    expect(generic.statusCode).toBe(201);
    expect(asRecord(generic.json())).toMatchObject({
      credentialHandle: "env:OPENROUTER_API_KEY",
      generation: 0,
      state: "unready",
    });
  });
});
