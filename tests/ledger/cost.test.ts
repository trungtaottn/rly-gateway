import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { appendEntrySync, queryLedger, pruneLedger, closeLedger } from "../../src/ledger/sqlite.js";
import { ValidationError } from "../../src/control-plane/errors.js";
import { estimateCost } from "../../src/ledger/price-registry.js";

let dir: string | undefined;

afterEach(async () => {
  closeLedger();
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function freshDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "rly-ledger-"));
  return dir;
}

describe("ledger", () => {
  it("append → query", async () => {
    const d = await freshDir();
    appendEntrySync(d, { eventId: "e1", provider: "openrouter", model: "nvidia-nemotron-nano-9b-v2", inputTokens: 100, outputTokens: 50 });
    const groups = await queryLedger(d, {});
    expect(groups.length).toBe(1);
    expect(groups[0]?.provider).toBe("openrouter");
  });

  it("query since filter", async () => {
    const d = await freshDir();
    appendEntrySync(d, { eventId: "e2", provider: "openrouter", model: "nvidia-nemotron-nano-9b-v2", inputTokens: 10, outputTokens: 5, occurredAt: "2026-01-01T00:00:00.000Z" });
    appendEntrySync(d, { eventId: "e3", provider: "openrouter", model: "nvidia-nemotron-nano-9b-v2", inputTokens: 20, outputTokens: 10, occurredAt: "2026-08-21T00:00:00.000Z" });
    const groups = await queryLedger(d, { since: "2026-08-01T00:00:00.000Z" });
    expect(groups[0]?.count).toBe(1);
  });

  it("group-by model", async () => {
    const d = await freshDir();
    appendEntrySync(d, { eventId: "e4", provider: "openrouter", model: "nvidia-nemotron-nano-9b-v2", inputTokens: 10, outputTokens: 5 });
    appendEntrySync(d, { eventId: "e5", provider: "openrouter", model: "deepseek-v4-flash", inputTokens: 10, outputTokens: 5 });
    const groups = await queryLedger(d, { groupBy: "model" });
    expect(groups.length).toBe(2);
  });

  it("rejects an invalid groupBy instead of falling back", async () => {
    const d = await freshDir();
    appendEntrySync(d, { eventId: "e4b", provider: "openrouter", model: "nvidia-nemotron-nano-9b-v2", inputTokens: 10, outputTokens: 5 });
    await expect(queryLedger(d, { groupBy: "account" } as unknown as { groupBy: "model" })).rejects.toBeInstanceOf(ValidationError);
  });


  it("prune before", async () => {
    const d = await freshDir();
    appendEntrySync(d, { eventId: "e6", provider: "openrouter", model: "nvidia-nemotron-nano-9b-v2", inputTokens: 10, outputTokens: 5, occurredAt: "2026-01-01T00:00:00.000Z" });
    const deleted = await pruneLedger(d, "2026-06-01T00:00:00.000Z");
    expect(deleted).toBe(1);
    const groups = await queryLedger(d, {});
    expect(groups.length).toBe(0);
  });

  it("estimate overwritten by upstream usage via UPSERT", async () => {
    const d = await freshDir();
    const eventId = "e7";
    appendEntrySync(d, { eventId, provider: "openrouter", model: "nvidia-nemotron-nano-9b-v2", inputTokens: 10, outputTokens: 5 });
    // Overwrite with real usage
    appendEntrySync(d, { eventId, provider: "openrouter", model: "nvidia-nemotron-nano-9b-v2", inputTokens: 100, outputTokens: 200 });
    const groups = await queryLedger(d, {});
    expect(groups[0]?.inputTokens).toBe(100);
    expect(groups[0]?.outputTokens).toBe(200);
    const cost = estimateCost({ model: "openrouter/nvidia-nemotron-nano-9b-v2", inputTokens: 100, outputTokens: 200 });
    expect(groups[0]?.totalCost).toBeCloseTo(cost, 8);
  });
});
