import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateEligibility } from "../../src/routing/eligibility/evaluate.js";
import { NoEligibleAccountError } from "../../src/routing/errors.js";
import { QUOTA_CLASS_ORDER } from "../../src/routing/pools/quota.js";
import { CAPABILITIES, createReadyPool, createSelector, openStore, readySnapshots, tempDir } from "./helpers.js";

const directories: string[] = [];
const now = new Date("2026-08-13T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("eligibility", () => {
  it("matches the deterministic quota-class fixture", async () => {
    const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/upstream/ccs/quota-classes.json");
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
      classes: Array<{ id: string; rank: number; eligible: boolean }>;
    };
    expect(fixture.classes.map((item) => item.id)).toEqual([...QUOTA_CLASS_ORDER]);
    expect(fixture.classes.map((item) => item.rank)).toEqual([0, 1, 2, 3]);
  });

  it("never selects paused, expired, unready, cooling, incompatible, or unaccepted accounts", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { accounts, pool } = createReadyPool(store, {
      strategy: "round-robin",
      requiredTermsRevision: "terms-2",
      specs: [
        { pseudonym: "acct-fixture-ready", handle: "cred-ready", terms: "terms-2" },
        { pseudonym: "acct-fixture-paused", handle: "cred-paused", state: "paused", terms: "terms-2" },
        { pseudonym: "acct-fixture-revoked", handle: "cred-revoked", state: "revoked", terms: "terms-2" },
        { pseudonym: "acct-fixture-unready", handle: "cred-unready", state: "unready", generation: 0 },
        { pseudonym: "acct-fixture-exhausted", handle: "cred-exhausted", quotaClass: "exhausted", terms: "terms-2" },
        { pseudonym: "acct-fixture-cooling", handle: "cred-cooling", quotaClass: "exhausted", terms: "terms-2", cooldownUntil: "2026-08-13T01:00:00.000Z" },
        { pseudonym: "acct-fixture-terms", handle: "cred-terms" },
      ],
    });
    const snapshots = readySnapshots(accounts);
    snapshots.set("cred-expired", { present: true, generation: 1, expiresAt: "2026-08-12T00:00:00.000Z" });
    const expired = store.createAccount({
      pseudonym: "acct-fixture-expired",
      providerId: pool.providerId,
      credentialHandle: "cred-expired",
    }, "cli");
    const boundExpired = store.bindCredential(expired.id, expired.version, {
      credentialHandle: "cred-expired",
      credentialGeneration: 1,
      state: "ready",
    }, "cli");
    store.acknowledgeTerms(boundExpired.id, boundExpired.version, "terms-2", "cli");
    store.updatePool(pool.id, pool.version, {
      accountIds: [...pool.memberships.map((item) => item.accountId), expired.id],
    }, "cli");
    const selector = createSelector(store, now);
    const policy = store.currentPolicy();
    if (!policy) throw new Error("expected policy");
    const selected = await selector.select({
      requestId: "req-1",
      poolId: pool.id,
      policy,
      required: ["images"],
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: snapshots,
    }).catch((error: unknown) => error);
    expect(selected).toBeInstanceOf(NoEligibleAccountError);
    const compatible = await selector.select({
      requestId: "req-2",
      poolId: pool.id,
      policy: store.currentPolicy() ?? policy,
      required: ["streaming"],
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: snapshots,
    });
    expect(compatible.route.accountPseudonym).toBe("acct-fixture-ready");
    expect(compatible.trace.candidates.filter((item) => !item.eligible).map((item) => item.accountPseudonym).sort()).toEqual([
      "acct-fixture-cooling",
      "acct-fixture-exhausted",
      "acct-fixture-expired",
      "acct-fixture-paused",
      "acct-fixture-revoked",
      "acct-fixture-terms",
      "acct-fixture-unready",
    ]);
    expect(compatible.trace.candidates.find((item) => item.accountPseudonym === "acct-fixture-exhausted")?.eligible).toBe(false);
    store.close();
  });

  it("treats terms as ineligible until the current required revision is acknowledged", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const store = await openStore(directory, now);
    const { provider, accounts, pool } = createReadyPool(store, {
      strategy: "manual",
      requiredTermsRevision: "terms-1",
      specs: [{ pseudonym: "acct-fixture-001", handle: "cred-001" }],
    });
    const selector = createSelector(store, now);
    const first = store.currentPolicy();
    if (!first) throw new Error("expected policy");
    await expect(selector.select({
      requestId: "req-terms-1",
      poolId: pool.id,
      policy: first,
      required: [],
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: readySnapshots(accounts),
    })).rejects.toBeInstanceOf(NoEligibleAccountError);
    const account = accounts[0];
    if (!account) throw new Error("expected account");
    const acknowledged = store.acknowledgeTerms(account.id, account.version, "terms-1", "cli");
    const afterAck = store.currentPolicy();
    if (!afterAck) throw new Error("expected policy");
    const selected = await selector.select({
      requestId: "req-terms-2",
      poolId: pool.id,
      policy: afterAck,
      required: [],
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: readySnapshots([acknowledged]),
    });
    expect(selected.route.accountPseudonym).toBe("acct-fixture-001");
    store.updateProvider(provider.id, provider.version, { requiredTermsRevision: "terms-2" }, "cli");
    const stale = store.currentPolicy();
    if (!stale) throw new Error("expected policy");
    await expect(selector.select({
      requestId: "req-terms-3",
      poolId: pool.id,
      policy: stale,
      required: [],
      capabilities: CAPABILITIES,
      modelId: "fixture-model",
      adapterId: "fixture-adapter",
      role: "primary",
      credentialSnapshots: readySnapshots([acknowledged]),
    })).rejects.toBeInstanceOf(NoEligibleAccountError);
    store.close();
  });

  it("collects every applicable reason without making an ineligible account usable", () => {
    const assessment = evaluateEligibility({
      account: {
        id: "account-1",
        pseudonym: "acct-fixture-001",
        providerId: "provider-1",
        credentialHandle: "cred-001",
        credentialGeneration: 0,
        state: "paused",
        pauseReason: "owner",
        quotaClass: "exhausted",
        cooldownUntil: "2026-08-13T01:00:00.000Z",
        termsRevision: "terms-1",
        termsAcknowledgedRevision: "terms-1",
        version: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      provider: {
        id: "provider-1",
        name: "codex",
        integrationMode: "oauth",
        endpointPolicy: undefined,
        capabilityEvidence: undefined,
        requiredTermsRevision: "terms-2",
        provenanceRef: undefined,
        enabled: false,
        version: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      pinOrder: 0,
      now,
      credential: { present: false, generation: 0 },
      required: ["images"],
      capabilities: CAPABILITIES,
      health: undefined,
    });
    expect(assessment.eligible).toBe(false);
    expect(assessment.reasons).toEqual([
      "provider-disabled",
      "paused",
      "auth-unready",
      "generation-unbound",
      "cooling",
      "quota-exhausted",
      "capability-incompatible",
      "terms-unaccepted",
    ]);
  });
});
