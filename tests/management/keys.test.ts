import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { createGovernanceKey, listGovernanceKeys, verifyGovernanceKey, revokeGovernanceKey, checkBudget, recordKeyUsage, checkRpm } from "../../src/management/keys.js";

describe("governance keys", () => {
  let dir: string;
  let store: ControlPlaneStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rly-keys-"));
    store = await ControlPlaneStore.open(dir);
  });

  it("create → list → verify → revoke", async () => {
    const { key, secret } = createGovernanceKey(store, { name: "test-key", budgetUsd: 10 });
    expect(secret.startsWith("rly_")).toBe(true);
    expect(key.name).toBe("test-key");
    const list = listGovernanceKeys(store);
    expect(list.length).toBe(1);
    const verified = verifyGovernanceKey(store, secret);
    expect(verified?.id).toBe(key.id);
    revokeGovernanceKey(store, key.id);
    const after = verifyGovernanceKey(store, secret);
    expect(after).toBeUndefined();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("budget enforcement", async () => {
    const { key, secret } = createGovernanceKey(store, { name: "budget-key", budgetUsd: 10 });
    expect(checkBudget(store, key, 5)).toBe(true);
    recordKeyUsage(store, key.id, 10);
    const verified = verifyGovernanceKey(store, secret);
    expect(verified).toBeDefined();
    if (verified) expect(checkBudget(store, verified, 1)).toBe(false);
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("reject unknown prefix", async () => {
    const verified = verifyGovernanceKey(store, "sk-123");
    expect(verified).toBeUndefined();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("rpm limit", async () => {
    const { key } = createGovernanceKey(store, { name: "rpm-key", rpmLimit: 2 });
    expect(checkRpm(store, key)).toBe(true);
    recordKeyUsage(store, key.id, 0);
    recordKeyUsage(store, key.id, 0);
    // After 2 requests in same window, next should be limited if we simulate
    // Our simple rpm tracks request_count, so after 2, next check should fail
    // But we reset window after 60s, so within window it should be false after 2
    // Instead test directly: after 2 usages, checkRpm should be false for limit 2
    // We recorded 2 usages, so count is 2, limit 2 => should be false on next check before window reset
    // Our implementation increments count on record, so after 2, count=2, limit=2 => check should be false
    expect(checkRpm(store, key)).toBe(false);
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
});
