import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CAPABILITIES, createReadyPool, createSelector, openStore, readySnapshots, tempDir } from "./helpers.js";

const directories: string[] = [];
const now = new Date("2026-08-13T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("pool strategies", () => {
  it("selects deterministically under manual, round-robin, and fill-first", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const provider = store.createProvider({ name: "shared", integrationMode: "oauth" }, "cli");
    const first = store.createAccount({
      pseudonym: "acct-fixture-001",
      providerId: provider.id,
      credentialHandle: "cred-001",
    }, "cli");
    const second = store.createAccount({
      pseudonym: "acct-fixture-002",
      providerId: provider.id,
      credentialHandle: "cred-002",
    }, "cli");
    const ready = [first, second].map((account) => store.bindCredential(account.id, account.version, {
      credentialHandle: account.credentialHandle,
      credentialGeneration: 3,
      state: "ready",
    }, "cli"));
    const manual = store.createPool({
      name: "manual",
      providerId: provider.id,
      strategy: "manual",
      accountIds: ready.map((account) => account.id),
    }, "cli");
    const fill = store.createPool({
      name: "fill",
      providerId: provider.id,
      strategy: "fill-first",
      accountIds: ready.map((account) => account.id),
    }, "cli");
    const robin = store.createPool({
      name: "robin",
      providerId: provider.id,
      strategy: "round-robin",
      accountIds: ready.map((account) => account.id),
    }, "cli");
    const selector = createSelector(store, now);
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    const snapshots = readySnapshots(ready);
    const base = {
      required: [] as const,
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: snapshots,
      policy,
    };
    const pinned = await selector.select({ ...base, requestId: "req-manual", poolId: manual.id });
    expect(pinned.route.accountPseudonym).toBe("acct-fixture-001");
    expect(pinned.route.credentialGeneration).toBe(3);
    expect(pinned.trace.sourceRule).toBe("pool:manual:pin");
    const again = await selector.select({ ...base, requestId: "req-manual-2", poolId: manual.id });
    expect(again.route.accountId).toBe(pinned.route.accountId);
    const fillA = await selector.select({ ...base, requestId: "req-fill-1", poolId: fill.id });
    const fillB = await selector.select({ ...base, requestId: "req-fill-2", poolId: fill.id });
    expect(fillA.route.accountPseudonym).toBe("acct-fixture-001");
    expect(fillB.route.accountPseudonym).toBe("acct-fixture-001");
    const robinA = await selector.select({ ...base, requestId: "req-rr-1", poolId: robin.id });
    const robinB = await selector.select({ ...base, requestId: "req-rr-2", poolId: robin.id });
    const robinC = await selector.select({ ...base, requestId: "req-rr-3", poolId: robin.id });
    expect(robinA.route.accountPseudonym).toBe("acct-fixture-001");
    expect(robinB.route.accountPseudonym).toBe("acct-fixture-002");
    expect(robinC.route.accountPseudonym).toBe("acct-fixture-001");
    expect(robinA.trace.selected?.credentialGeneration).toBe(3);
    store.close();
  });

  it("does not substitute another account when the manual pin is ineligible", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { pool } = createReadyPool(store, {
      strategy: "manual",
      specs: [
        { pseudonym: "acct-fixture-001", handle: "cred-001", state: "paused" },
        { pseudonym: "acct-fixture-002", handle: "cred-002" },
      ],
    });
    const selector = createSelector(store, now);
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    await expect(selector.select({
      requestId: "req-pin",
      poolId: pool.id,
      policy,
      required: [],
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: readySnapshots(store.listAccounts()),
    })).rejects.toThrow("No eligible account for the requested route");
    store.close();
  });

  it("uses session affinity until TTL expiry then falls back deterministically", async () => {
    const directory = await tempDir();
    directories.push(directory);
    let nowLocal = now;
    const store = await openStore(directory, now);
    const { pool } = createReadyPool(store, {
      strategy: "round-robin",
      affinity: { sessionAffinity: { enabled: true, ttlSeconds: 60 } },
      specs: [
        { pseudonym: "acct-fixture-001", handle: "cred-001" },
        { pseudonym: "acct-fixture-002", handle: "cred-002" },
      ],
    });
    const selector = new (await import("../../src/routing/pools/selector.js")).RouteSelector(
      store,
      new (await import("../../src/routing/pools/affinity.js")).AffinityStore(directory),
      () => nowLocal,
    );
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    const input = {
      poolId: pool.id,
      policy,
      required: [] as const,
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: readySnapshots(store.listAccounts()),
      sessionKey: "session-fixture-1",
    };
    const first = await selector.select({ ...input, requestId: "req-aff-1" });
    const second = await selector.select({ ...input, requestId: "req-aff-2" });
    expect(second.route.accountId).toBe(first.route.accountId);
    expect(second.trace.sourceRule).toBe("pool:round-robin:affinity");
    nowLocal = new Date("2026-08-13T00:02:00.000Z");
    const expired = await selector.select({ ...input, requestId: "req-aff-3" });
    expect(expired.trace.sourceRule).toBe("pool:round-robin");
    store.close();
  });

  it("does not apply leftover affinity when session affinity is disabled or the pool is manual", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { AffinityStore, hashSessionKey } = await import("../../src/routing/pools/affinity.js");
    const affinity = new AffinityStore(directory);
    await affinity.save([{
      sessionKeyHash: hashSessionKey("session-fixture-1"),
      poolId: "pending",
      accountId: "pending",
      expiresAt: "2026-08-13T01:00:00.000Z",
    }]);
    const provider = store.createProvider({ name: "shared-aff", integrationMode: "oauth" }, "cli");
    const first = store.bindCredential(
      store.createAccount({
        pseudonym: "acct-fixture-001",
        providerId: provider.id,
        credentialHandle: "cred-001",
      }, "cli").id,
      1,
      { credentialHandle: "cred-001", credentialGeneration: 1, state: "ready" },
      "cli",
    );
    const second = store.bindCredential(
      store.createAccount({
        pseudonym: "acct-fixture-002",
        providerId: provider.id,
        credentialHandle: "cred-002",
      }, "cli").id,
      1,
      { credentialHandle: "cred-002", credentialGeneration: 1, state: "ready" },
      "cli",
    );
    const robin = store.createPool({
      name: "robin-disabled",
      providerId: provider.id,
      strategy: "round-robin",
      affinity: { sessionAffinity: { enabled: false, ttlSeconds: 60 } },
      accountIds: [first.id, second.id],
    }, "cli");
    const manual = store.createPool({
      name: "manual-leftover",
      providerId: provider.id,
      strategy: "manual",
      affinity: { sessionAffinity: { enabled: true, ttlSeconds: 60 } },
      accountIds: [first.id, second.id],
    }, "cli");
    await affinity.save([
      {
        sessionKeyHash: hashSessionKey("session-fixture-1"),
        poolId: robin.id,
        accountId: second.id,
        expiresAt: "2026-08-13T01:00:00.000Z",
      },
      {
        sessionKeyHash: hashSessionKey("session-fixture-1"),
        poolId: manual.id,
        accountId: second.id,
        expiresAt: "2026-08-13T01:00:00.000Z",
      },
    ]);
    const selector = new (await import("../../src/routing/pools/selector.js")).RouteSelector(store, affinity, () => now);
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    const base = {
      policy,
      required: [] as const,
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: readySnapshots([first, second]),
      sessionKey: "session-fixture-1",
    };
    const disabled = await selector.select({ ...base, requestId: "req-disabled", poolId: robin.id });
    expect(disabled.route.accountPseudonym).toBe("acct-fixture-001");
    expect(disabled.trace.sourceRule).toBe("pool:round-robin");
    const pinned = await selector.select({ ...base, requestId: "req-manual-aff", poolId: manual.id });
    expect(pinned.route.accountPseudonym).toBe("acct-fixture-001");
    expect(pinned.trace.sourceRule).toBe("pool:manual:pin");
    store.close();
  });

  it("applies quota-aware ordering only from the evidence-backed class fixture", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { pool } = createReadyPool(store, {
      strategy: "fill-first",
      affinity: { quotaAware: true },
      specs: [
        { pseudonym: "acct-fixture-unknown", handle: "cred-unknown", quotaClass: "unknown" },
        { pseudonym: "acct-fixture-healthy", handle: "cred-healthy", quotaClass: "healthy" },
        { pseudonym: "acct-fixture-warning", handle: "cred-warning", quotaClass: "warning" },
        { pseudonym: "acct-fixture-exhausted", handle: "cred-exhausted", quotaClass: "exhausted" },
      ],
    });
    const selector = createSelector(store, now);
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    const selected = await selector.select({
      requestId: "req-quota",
      poolId: pool.id,
      policy,
      required: [],
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: readySnapshots(store.listAccounts()),
    });
    expect(selected.route.accountPseudonym).toBe("acct-fixture-healthy");
    expect(selected.trace.candidates.find((item) => item.accountPseudonym === "acct-fixture-exhausted")?.eligible).toBe(false);
    store.close();
  });
});
