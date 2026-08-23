import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { computeScore, getAdaptiveHealth, updateAdaptiveHealth, resetRateLimit, ADAPTIVE_MIN_SAMPLES } from "../../src/routing/pools/adaptive.js";

describe("adaptive", () => {
  it("sorts by score with quota penalty", () => {
    // fast health 100ms, slow 500ms
    const healthFast = { accountId: "a1", ewma: 100, errors: 0, total: 10, updatedAt: new Date().toISOString() };
    const healthSlow = { accountId: "a2", ewma: 500, errors: 0, total: 10, updatedAt: new Date().toISOString() };
    expect(computeScore(healthFast, "healthy")).toBeLessThan(computeScore(healthSlow, "healthy"));
  });

  it("EWMA update and winsorize", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rly-adaptive-"));
    try {
      const store = await ControlPlaneStore.open(dir);
      resetRateLimit();
      updateAdaptiveHealth(store, "acct-1", 100, true, new Date("2026-01-01T00:00:00.000Z"));
      // second update within rate limit should be ignored
      updateAdaptiveHealth(store, "acct-1", 6000, true, new Date("2026-01-01T00:00:01.000Z"));
      let h = getAdaptiveHealth(store, "acct-1");
      expect(h?.ewma).toBe(100);
      // after 5s, update with large latency should be winsorized to 5000
      updateAdaptiveHealth(store, "acct-1", 6000, true, new Date("2026-01-01T00:00:06.000Z"));
      h = getAdaptiveHealth(store, "acct-1");
      // EWMA = 100*0.7 + 5000*0.3 = 1570
      expect(h?.ewma).toBeCloseTo(1570, 0);
      expect(h?.total).toBe(2);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
      resetRateLimit();
    }
  });

  it("fallback to fill-first until MIN_SAMPLES", () => {
    const health = { accountId: "a1", ewma: 10, errors: 0, total: ADAPTIVE_MIN_SAMPLES - 1, updatedAt: new Date().toISOString() };
    // With insufficient samples, score should be only quota penalty
    expect(computeScore(health, "healthy")).toBe(0);
    const ready = { accountId: "a1", ewma: 10, errors: 0, total: ADAPTIVE_MIN_SAMPLES, updatedAt: new Date().toISOString() };
    expect(computeScore(ready, "healthy")).toBeGreaterThan(0);
  });

  it("records failures inside the success rate-limit window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rly-adaptive-fail-"));
    try {
      const store = await ControlPlaneStore.open(dir);
      resetRateLimit();
      updateAdaptiveHealth(store, "acct-1", 100, true, new Date("2026-01-01T00:00:00.000Z"));
      updateAdaptiveHealth(store, "acct-1", 200, false, new Date("2026-01-01T00:00:01.000Z"));
      const h = getAdaptiveHealth(store, "acct-1");
      expect(h?.total).toBe(2);
      expect(h?.errors).toBe(1);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
      resetRateLimit();
    }
  });

  it("skips abort errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rly-adaptive-abort-"));
    try {
      const store = await ControlPlaneStore.open(dir);
      resetRateLimit();
      const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
      updateAdaptiveHealth(store, "acct-2", 100, false, new Date(), abort);
      const h = getAdaptiveHealth(store, "acct-2");
      expect(h).toBeUndefined();
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
      resetRateLimit();
    }
  });
});
