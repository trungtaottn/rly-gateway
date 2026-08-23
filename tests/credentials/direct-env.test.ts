import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { ValidationError } from "../../src/control-plane/errors.js";
import { CredentialBroker } from "../../src/credentials/broker.js";
import { CredentialUnreadyError } from "../../src/credentials/errors.js";
import { CredentialService } from "../../src/credentials/service.js";
import { fakeOauth, tempDirectory } from "./helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("direct environment account onboarding", () => {
  it("creates a ready env-reference account without persisting a secret", async () => {
    const directory = await tempDirectory("rly-gateway-direct-env-");
    directories.push(directory);
    const store = await ControlPlaneStore.open(directory);
    const broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    const environment: NodeJS.ProcessEnv = {};
    const service = new CredentialService(store, broker, environment);
    const provider = store.createProvider({ name: "openrouter", integrationMode: "direct" }, "cli");
    const created = service.createDirectEnvironmentAccount({
      providerId: provider.id,
      pseudonym: "acct-or-1",
      credentialRef: "env:OPENROUTER_API_KEY",
    }, "cli");
    expect(created.state).toBe("ready");
    expect(created.credentialGeneration).toBe(1);
    expect(created.credentialHandle).toBe("env:OPENROUTER_API_KEY");
    expect(await service.readiness(created)).toBe("unready");
    await expect(service.select(created.id, created.version, "cli")).rejects.toBeInstanceOf(CredentialUnreadyError);
    environment.OPENROUTER_API_KEY = "fixture-key";
    expect(await service.readiness(created)).toBe("ready");
    expect(await service.select(created.id, created.version, "cli")).toMatchObject({ id: created.id });
    expect(JSON.stringify(created)).not.toMatch(/sk-|secret|Bearer/i);
    expect(JSON.stringify(store.listAudit())).not.toMatch(/sk-|secret|Bearer/i);
    expect(await broker.store.listHandles()).toEqual([]);
    store.close();
    await broker.close();
  });

  it("treats missing terms acknowledgement as unready for env accounts", async () => {
    const directory = await tempDirectory("rly-gateway-direct-env-terms-");
    directories.push(directory);
    const store = await ControlPlaneStore.open(directory);
    const broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    const service = new CredentialService(store, broker, { OPENROUTER_API_KEY: "fixture-key" });
    const provider = store.createProvider({
      name: "openrouter",
      integrationMode: "direct",
      requiredTermsRevision: "terms-1",
    }, "cli");
    const created = service.createDirectEnvironmentAccount({
      providerId: provider.id,
      pseudonym: "acct-or-terms",
      credentialRef: "env:OPENROUTER_API_KEY",
    }, "cli");
    expect(await service.readiness(created)).toBe("unready");
    const acknowledged = store.acknowledgeTerms(created.id, created.version, "terms-1", "cli");
    expect(await service.readiness(acknowledged)).toBe("ready");
    store.close();
    await broker.close();
  });

  it("rejects oauth providers, unapproved env names, and raw secret values", async () => {
    const directory = await tempDirectory("rly-gateway-direct-env-reject-");
    directories.push(directory);
    const store = await ControlPlaneStore.open(directory);
    const broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    const service = new CredentialService(store, broker);
    const oauth = store.createProvider({ name: "codex", integrationMode: "oauth" }, "cli");
    const direct = store.createProvider({ name: "openrouter", integrationMode: "direct" }, "cli");
    expect(() => service.createDirectEnvironmentAccount({
      providerId: oauth.id,
      pseudonym: "acct-oauth",
      credentialRef: "env:OPENROUTER_API_KEY",
    }, "cli")).toThrow(ValidationError);
    expect(() => service.createDirectEnvironmentAccount({
      providerId: direct.id,
      pseudonym: "acct-wrong",
      credentialRef: "env:AWS_SECRET_ACCESS_KEY",
    }, "cli")).toThrow(ValidationError);
    expect(() => service.createDirectEnvironmentAccount({
      providerId: direct.id,
      pseudonym: "acct-secret",
      credentialRef: "sk-live-not-an-env-name",
    }, "cli")).toThrow(ValidationError);
    expect(store.listAccounts()).toHaveLength(0);
    store.close();
    await broker.close();
  });
});
