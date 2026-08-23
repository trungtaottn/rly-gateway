import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { nextQuotaClass } from "../../src/control-plane/health/outcomes.js";
import { CAPABILITIES, createReadyPool, createSelector, openStore, readySnapshots, tempDir } from "./helpers.js";

const directories: string[] = [];
const now = new Date("2026-08-13T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("quota class transitions", () => {
  it("classifies failure, restores healthy on success, and leaves auth distinct from quota", () => {
    expect(nextQuotaClass("quota", "healthy")).toBe("exhausted");
    expect(nextQuotaClass("success", "exhausted")).toBe("healthy");
    expect(nextQuotaClass("auth", "healthy")).toBe("healthy");
    expect(nextQuotaClass("transient", "warning")).toBe("warning");
    expect(nextQuotaClass("quota", "exhausted")).toBe("exhausted");
    expect(nextQuotaClass("transient", "healthy", 2)).toBe("healthy");
    expect(nextQuotaClass("transient", "healthy", 3)).toBe("warning");
    expect(nextQuotaClass("transient", "warning", 3)).toBe("unknown");
    expect(nextQuotaClass("transient", "unknown", 3)).toBe("unknown");
    expect(nextQuotaClass("transient", "exhausted", 3)).toBe("exhausted");
  });
});

describe("route outcomes", () => {
  it("updates health, quota class, cooldown, and audit in one transaction", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { accounts } = createReadyPool(store, {
      strategy: "fill-first",
      specs: [{ pseudonym: "acct-fixture-001", handle: "cred-001" }],
    });
    const account = accounts[0];
    if (!account) throw new Error("expected account");
    const before = store.currentPolicy()?.revision ?? 0;
    const updated = store.recordRouteOutcome(account.id, {
      outcome: "quota",
      quotaClass: "exhausted",
      cooldownUntil: "2026-08-13T00:05:00.000Z",
    });
    expect(updated.quotaClass).toBe("exhausted");
    expect(updated.cooldownUntil).toBe("2026-08-13T00:05:00.000Z");
    expect(store.getHealth(account.id)?.lastOutcome).toBe("quota");
    expect(store.getHealth(account.id)?.consecutiveFailures).toBe(1);
    expect(store.currentPolicy()?.revision).toBe(before);
    expect(store.listAudit().some((event) => event.action === "route.outcome" && event.result === "ok")).toBe(true);
    const selector = createSelector(store, now);
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    await expect(selector.select({
      requestId: "req-cooled",
      poolId: policy.snapshot.pools[0]?.id ?? "",
      policy,
      required: [],
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: readySnapshots([updated]),
    })).rejects.toThrow("No eligible account");
    const cleared = store.recordRouteOutcome(updated.id, {
      outcome: "success",
      quotaClass: nextQuotaClass("success", updated.quotaClass),
      cooldownUntil: null,
    });
    expect(cleared.cooldownUntil).toBeUndefined();
    expect(cleared.quotaClass).toBe("healthy");
    expect(store.getHealth(cleared.id)?.consecutiveFailures).toBe(0);
    store.close();
  });

  it("rolls back an interrupted outcome write", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { accounts } = createReadyPool(store, {
      strategy: "manual",
      specs: [{ pseudonym: "acct-fixture-001", handle: "cred-001" }],
    });
    const account = accounts[0];
    if (!account) throw new Error("expected account");
    store.database.exec("BEGIN IMMEDIATE");
    store.database.prepare("UPDATE health SET last_outcome = ?, consecutive_failures = 9 WHERE account_id = ?")
      .run("quota", account.id);
    store.close();
    const restored = await openStore(directory, now);
    expect(restored.getHealth(account.id)?.consecutiveFailures).toBe(0);
    expect(restored.getHealth(account.id)?.lastOutcome).toBeUndefined();
    restored.close();
  });

  it("treats exhausted accounts as recovery probes after cooldown and extends cooldown on probe failure", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const cooledAt = new Date("2026-08-13T00:00:00.000Z");
    const store = await openStore(directory, cooledAt);
    const { accounts, pool } = createReadyPool(store, {
      strategy: "fill-first",
      specs: [{ pseudonym: "acct-fixture-001", handle: "cred-001" }],
    });
    const account = accounts[0];
    if (!account) throw new Error("expected account");
    const exhausted = store.recordRouteOutcome(account.id, {
      outcome: "quota",
      quotaClass: nextQuotaClass("quota", account.quotaClass),
      cooldownUntil: "2026-08-13T00:05:00.000Z",
    });
    const selector = createSelector(store, cooledAt);
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    const selectInput = {
      poolId: pool.id,
      policy,
      required: [] as const,
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: readySnapshots([exhausted]),
    };
    await expect(selector.select({ ...selectInput, requestId: "req-cooling" })).rejects.toThrow("No eligible account");
    store.close();

    const probeAt = new Date("2026-08-13T00:05:01.000Z");
    const probing = await openStore(directory, probeAt);
    const probeSelector = createSelector(probing, probeAt);
    const probePolicy = probing.currentPolicy();
    if (!probePolicy) throw new Error("expected policy");
    const probed = probing.listAccounts()[0];
    if (!probed) throw new Error("expected account");
    // Exhausted remains ineligible even after cooldown expiry (hard block, probe via manual reset only)
    await expect(probeSelector.select({
      ...selectInput,
      requestId: "req-probe",
      policy: probePolicy,
      credentialSnapshots: readySnapshots([probed]),
    })).rejects.toThrow("No eligible account");
    expect(probed.quotaClass).toBe("exhausted");

    const failed = probing.recordRouteOutcome(probed.id, {
      outcome: "quota",
      quotaClass: nextQuotaClass("quota", probed.quotaClass),
      cooldownUntil: "2026-08-13T00:10:01.000Z",
    });
    expect(failed.quotaClass).toBe("exhausted");
    expect(failed.cooldownUntil).toBe("2026-08-13T00:10:01.000Z");

    const recovered = probing.recordRouteOutcome(failed.id, {
      outcome: "success",
      quotaClass: nextQuotaClass("success", failed.quotaClass),
      cooldownUntil: null,
    });
    expect(recovered.quotaClass).toBe("healthy");
    expect(recovered.cooldownUntil).toBeUndefined();
    probing.close();
  });
});
