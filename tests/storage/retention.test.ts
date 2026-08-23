import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { CredentialStore } from "../../src/credentials/store.js";
import { ResponseContinuationStore } from "../../src/protocols/openai-responses/continuation.js";
import { applyRetentionPolicy, assertRetentionPolicy, DEFAULT_RETENTION_POLICY, RetentionPolicyError } from "../../src/storage/retention.js";
import { controlPlanePaths } from "../../src/storage/paths.js";
import { ensurePrivateDirectory, writePrivateTextAtomically } from "../../src/storage/private-files.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("retention policy", () => {
  it("refuses a class without an owner or duration", () => {
    expect(() => assertRetentionPolicy({
      version: 1,
      classes: {
        ...DEFAULT_RETENTION_POLICY.classes,
        logs: { owner: "", maxAgeMs: 1 },
      },
    })).toThrow(RetentionPolicyError);
  });

  it("deletes expired continuation, backups, logs, audit, and credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-retention-"));
    directories.push(directory);
    const store = await ControlPlaneStore.open(directory);
    store.createProvider({ name: "fixture", integrationMode: "direct" }, "system");
    store.close();
    const opened = await ControlPlaneStore.open(directory, { clock: () => new Date("2020-01-01T00:00:00.000Z") });
    opened.createProvider({ name: "old-audit", integrationMode: "direct" }, "cli");
    opened.close();
    const paths = controlPlanePaths(directory);
    const continuation = new ResponseContinuationStore(directory);
    await continuation.put({
      id: "resp_old",
      createdAt: "2020-01-01T00:00:00.000Z",
      model: "fixture-model",
      messages: [{ role: "assistant", content: [{ type: "text", text: "expired fixture" }] }],
    });
    await ensurePrivateDirectory(paths.logs);
    await writePrivateTextAtomically(join(paths.logs, "old.log"), "fixture-log\n");
    await writePrivateTextAtomically(join(paths.backups, "old.sqlite"), "backup\n");
    const past = new Date(Date.now() - 2000);
    await utimes(join(paths.logs, "old.log"), past, past);
    await utimes(join(paths.backups, "old.sqlite"), past, past);
    const credentials = await CredentialStore.open(directory);
    await credentials.commit("cred-expired01", 0, {
      schemaVersion: 1,
      provider: "codex",
      handle: "cred-expired01",
      pseudonym: "acct-fixture",
      generation: 1,
      expiresAt: "2020-01-01T00:00:00.000Z",
      refreshFingerprint: "a".repeat(64),
      material: { accessToken: "fixture-access", refreshToken: "fixture-refresh" },
    });
    const quarantine = join(paths.credentialQuarantine, "stale.json");
    await writePrivateTextAtomically(quarantine, "stale-quarantine\n");
    await utimes(quarantine, past, past);
    const result = await applyRetentionPolicy(directory, {
      version: 1,
      classes: {
        logs: { owner: "runtime", maxAgeMs: 1 },
        audit: { owner: "control-plane", maxAgeMs: 1 },
        continuation: { owner: "responses", maxAgeMs: 1 },
        backups: { owner: "storage", maxAgeMs: 1 },
        expiredCredentials: { owner: "credential-broker", maxAgeMs: 0 },
        ledger: { owner: "ledger", maxAgeMs: 1 },
      },
    });
    expect(result.applied.map((item) => item.className)).toEqual(["logs", "audit", "continuation", "backups", "expiredCredentials", "ledger"]);
    expect(await continuation.get("resp_old")).toBeUndefined();
    await expect(credentials.metadata("cred-expired01")).resolves.toMatchObject({ handle: "cred-expired01" });
  });

  it("resumes an interrupted cleanup from the marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-retention-resume-"));
    directories.push(directory);
    const paths = controlPlanePaths(directory);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    await writePrivateTextAtomically(paths.retentionMarker, `${JSON.stringify({ remaining: ["backups", "expiredCredentials"], policyVersion: 1 })}\n`);
    const result = await applyRetentionPolicy(directory);
    expect(result.resumed).toBe(true);
    expect(result.applied.map((item) => item.className)).toEqual(["backups", "expiredCredentials"]);
  });
});
