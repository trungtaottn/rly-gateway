import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { CredentialBroker } from "../../src/credentials/broker.js";
import { CredentialService } from "../../src/credentials/service.js";
import { decodeAnthropicRequest } from "../../src/protocols/anthropic/decoder.js";
import { createCodexOauthRouteResolver } from "../../src/providers/oauth/codex/route.js";
import { fakeOauth, tempDirectory, writeCodexSource } from "./helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("manual oauth route", () => {
  it("binds one selected account generation into the Anthropic route", async () => {
    const directory = await tempDirectory("rly-gateway-oauth-route-");
    directories.push(directory);
    const store = await ControlPlaneStore.open(directory);
    const broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    const service = new CredentialService(store, broker);
    const provider = store.createProvider({ name: "codex", integrationMode: "oauth" }, "cli");
    const source = await writeCodexSource(directory);
    const account = await service.importCodex({
      sourcePath: source.path,
      providerId: provider.id,
      pseudonym: "acct-fixture-001",
      sourceFingerprint: source.sourceFingerprint,
    }, "cli");
    await service.select(account.id, account.version, "cli");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: "chat_fixture",
      choices: [{ finish_reason: "stop", message: { content: "fixture text" } }],
    }), { status: 200 }));
    const resolve = createCodexOauthRouteResolver(service, broker, "a".repeat(64), fetch, "http://127.0.0.1:9");
    const request = decodeAnthropicRequest({ model: "gpt-5.4", max_tokens: 8, messages: [{ role: "user", content: "fixture" }] }).request;
    const resolved = await resolve(request);
    expect(resolved?.route.adapterId).toBe("codex-oauth");
    expect(resolved?.route.capabilities.redactedReasoning).toBe(true);
    expect(resolved?.route.reasoningEvidence?.supported).toBe(true);
    const events = [];
    if (!resolved) throw new Error("expected oauth route");
    for await (const event of resolved.upstream.invoke(request, new AbortController().signal)) events.push(event);
    expect(events.some((event) => event.type === "response-completed")).toBe(true);
    const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe("Bearer " + "access-token-fixture-not-secret");
    store.close();
    await broker.close();
  });

  it("fails closed when the requested Codex model is not in the registry", async () => {
    const directory = await tempDirectory("rly-gateway-oauth-unknown-");
    directories.push(directory);
    const store = await ControlPlaneStore.open(directory);
    const broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    const service = new CredentialService(store, broker);
    const resolve = createCodexOauthRouteResolver(service, broker, "a".repeat(64), fetch, "http://127.0.0.1:9");
    const request = decodeAnthropicRequest({ model: "fixture-model", max_tokens: 8, messages: [{ role: "user", content: "fixture" }] }).request;
    await expect(resolve(request)).resolves.toBeUndefined();
    store.close();
    await broker.close();
  });

  it("freezes the prepared generation before invoke and does not refresh again", async () => {
    const directory = await tempDirectory("rly-gateway-oauth-bind-");
    directories.push(directory);
    const oauth = fakeOauth();
    const store = await ControlPlaneStore.open(directory);
    const broker = await CredentialBroker.open(directory, { oauth });
    const service = new CredentialService(store, broker);
    const provider = store.createProvider({ name: "codex", integrationMode: "oauth" }, "cli");
    const source = await writeCodexSource(directory);
    const account = await service.importCodex({
      sourcePath: source.path,
      providerId: provider.id,
      pseudonym: "acct-fixture-001",
      sourceFingerprint: source.sourceFingerprint,
    }, "cli");
    await service.select(account.id, account.version, "cli");
    const current = await broker.store.read(account.credentialHandle);
    await broker.store.commit(account.credentialHandle, current.generation, {
      ...current,
      generation: current.generation + 1,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: "chat_fixture",
      choices: [{ finish_reason: "stop", message: { content: "fixture text" } }],
    }), { status: 200 }));
    const resolve = createCodexOauthRouteResolver(service, broker, "a".repeat(64), fetch, "http://127.0.0.1:9");
    const request = decodeAnthropicRequest({ model: "gpt-5.4", max_tokens: 8, messages: [{ role: "user", content: "fixture" }] }).request;
    expect(oauth.refreshCalls).toBe(0);
    const resolved = await resolve(request);
    expect(oauth.refreshCalls).toBe(1);
    expect(resolved?.route).toBeDefined();
    const events = [];
    if (!resolved) throw new Error("expected oauth route");
    for await (const event of resolved.upstream.invoke(request, new AbortController().signal)) events.push(event);
    expect(oauth.refreshCalls).toBe(1);
    expect(events.some((event) => event.type === "response-completed")).toBe(true);
    store.close();
    await broker.close();
  });
});
